/**
 * Live GPU monitoring (NVIDIA): streams nvidia-smi samples, keeps a short history and raises
 * plain-language alerts for things worth knowing (overheating, hardware throttling, very loud
 * fans, graphics memory nearly full, losing contact with the GPU).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { GpuAlert, GpuHistoryPoint, GpuSample, GpuStatus } from '@ba/shared';

const FIELDS = [
  'index', 'name', 'temperature.gpu', 'temperature.memory', 'fan.speed', 'power.draw', 'power.limit',
  'utilization.gpu', 'memory.used', 'memory.total', 'clocks.sm', 'clocks_event_reasons.active', 'pstate',
];
/** Older drivers name the throttle field differently and may not know temperature.memory. */
const FALLBACK_FIELDS = FIELDS.map((f) => (f === 'clocks_event_reasons.active' ? 'clocks_throttle_reasons.active' : f === 'temperature.memory' ? 'temperature.gpu' : f));

const HISTORY_POINTS = 150; // 5 minutes at 2 s

/** Throttle-reason bits reported by nvidia-smi. */
const REASON_BITS: [number, string][] = [
  [0x1, 'idle'],
  [0x2, 'app_clocks'],
  [0x4, 'power_cap'],
  [0x8, 'hw_slowdown'],
  [0x10, 'sync_boost'],
  [0x20, 'sw_thermal'],
  [0x40, 'hw_thermal'],
  [0x80, 'hw_power_brake'],
  [0x100, 'display_clocks'],
];

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s || /n\/a|not supported|unknown|error/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function decodeReasons(hex: string | undefined): string[] {
  const n = hex ? parseInt(hex.trim(), 16) : NaN;
  if (!Number.isFinite(n)) return [];
  return REASON_BITS.filter(([bit]) => (n & bit) !== 0).map(([, name]) => name);
}

/** Parse one `--format=csv,noheader,nounits` line in FIELDS order. */
export function parseSampleLine(line: string, t = Date.now(), fallback = false): GpuSample | null {
  const c = line.split(',').map((x) => x.trim());
  if (c.length < FIELDS.length) return null;
  const index = num(c[0]);
  if (index == null) return null;
  return {
    t,
    index,
    name: c[1],
    tempC: num(c[2]),
    memTempC: fallback ? null : num(c[3]),
    fanPct: num(c[4]),
    powerW: num(c[5]),
    powerLimitW: num(c[6]),
    utilPct: num(c[7]),
    memUsedMB: num(c[8]),
    memTotalMB: num(c[9]),
    smClockMHz: num(c[10]),
    reasons: decodeReasons(c[11]),
    pstate: c[12],
  };
}

// ---------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------

type Finding = { level: 'warn' | 'critical'; message: string } | null;

interface Rule {
  id: string;
  /** Consecutive bad samples before the alert is raised. */
  sustain: number;
  /** Consecutive good samples before it clears. */
  clearAfter: number;
  check(s: GpuSample, active: boolean): Finding;
}

const RULES: Rule[] = [
  {
    id: 'temp',
    sustain: 3,
    clearAfter: 5,
    check(s, active) {
      if (s.tempC == null) return null;
      const crit = active ? 86 : 88;
      const warn = active ? 80 : 83;
      if (s.tempC >= crit) return { level: 'critical', message: `GPU is very hot (${s.tempC}°C). Check the fans and airflow; it is close to its safety limit and will slow down hard.` };
      if (s.tempC >= warn) return { level: 'warn', message: `GPU is running hot (${s.tempC}°C). It starts slowing itself down around this point.` };
      return null;
    },
  },
  {
    id: 'memtemp',
    sustain: 3,
    clearAfter: 5,
    check(s, active) {
      if (s.memTempC == null) return null;
      if (s.memTempC >= (active ? 102 : 105)) return { level: 'critical', message: `Graphics memory is very hot (${s.memTempC}°C).` };
      if (s.memTempC >= (active ? 96 : 100)) return { level: 'warn', message: `Graphics memory is running hot (${s.memTempC}°C).` };
      return null;
    },
  },
  {
    id: 'hw-throttle',
    sustain: 2,
    clearAfter: 5,
    check(s) {
      const hw = s.reasons.filter((r) => r === 'hw_slowdown' || r === 'hw_thermal' || r === 'hw_power_brake');
      if (!hw.length) return null;
      const why = hw.includes('hw_power_brake') ? 'a power problem' : hw.includes('hw_thermal') ? 'overheating' : 'overheating or a power problem';
      return { level: 'critical', message: `GPU hardware protection is forcing it to slow down (${why}).` };
    },
  },
  {
    id: 'sw-thermal',
    sustain: 5,
    clearAfter: 5,
    check(s) {
      if (!s.reasons.includes('sw_thermal')) return null;
      return { level: 'warn', message: `GPU is slowing itself down to stay cool${s.tempC != null ? ` (${s.tempC}°C)` : ''}. The model will run a bit slower.` };
    },
  },
  {
    id: 'fan',
    sustain: 10,
    clearAfter: 5,
    check(s, active) {
      if (s.fanPct == null || s.fanPct < (active ? 85 : 90)) return null;
      return { level: 'warn', message: `Fans at ${s.fanPct}%, so it will be loud. Fine for a while; check airflow if it stays here.` };
    },
  },
  {
    id: 'vram',
    sustain: 3,
    clearAfter: 5,
    check(s, active) {
      if (s.memUsedMB == null || s.memTotalMB == null) return null;
      const free = s.memTotalMB - s.memUsedMB;
      if (free >= (active ? 384 : 256)) return null;
      return { level: 'warn', message: `Graphics memory almost full (${free} MB free). Opening other GPU-heavy apps now could slow down or crash the model.` };
    },
  },
];

export class AlertTracker {
  private state = new Map<string, { bad: number; good: number; active?: GpuAlert }>();

  constructor(private rules: Rule[] = RULES) {}

  /** Feed one sample; returns alerts that started and ended with it. */
  update(s: GpuSample): { started: GpuAlert[]; ended: GpuAlert[] } {
    const started: GpuAlert[] = [];
    const ended: GpuAlert[] = [];
    for (const rule of this.rules) {
      const st = this.state.get(rule.id) ?? { bad: 0, good: 0 };
      const f = rule.check(s, !!st.active);
      if (f) {
        st.bad++;
        st.good = 0;
        if (st.active) {
          const escalated = st.active.level === 'warn' && f.level === 'critical';
          st.active = { ...st.active, level: f.level, message: f.message };
          if (escalated) started.push(st.active);
        } else if (st.bad >= rule.sustain) {
          st.active = { id: rule.id, level: f.level, message: f.message, since: s.t };
          started.push(st.active);
        }
      } else {
        st.good++;
        st.bad = 0;
        if (st.active && st.good >= rule.clearAfter) {
          ended.push(st.active);
          st.active = undefined;
        }
      }
      this.state.set(rule.id, st);
    }
    return { started, ended };
  }

  raise(alert: GpuAlert): boolean {
    const st = this.state.get(alert.id);
    if (st?.active) return false;
    this.state.set(alert.id, { bad: 1, good: 0, active: alert });
    return true;
  }

  clear(id: string): GpuAlert | undefined {
    const st = this.state.get(id);
    const a = st?.active;
    if (st) st.active = undefined;
    return a;
  }

  active(): GpuAlert[] {
    return [...this.state.values()].flatMap((s) => (s.active ? [s.active] : [])).sort((a, b) => (a.level === b.level ? a.since - b.since : a.level === 'critical' ? -1 : 1));
  }
}

// ---------------------------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------------------------

export interface GpuMonitorOptions {
  /** Defaults to nvidia-smi. Tests pass a fake sample source. */
  command?: string;
  args?: string[];
  intervalMs?: number;
  /** Which GPU to watch (nvidia-smi index). */
  gpuIndex?: number;
}

export class GpuMonitor {
  onUpdate?: (status: GpuStatus) => void;
  onAlert?: (alert: GpuAlert, change: 'start' | 'end') => void;

  private proc?: ChildProcess;
  private tracker = new AlertTracker();
  private history: GpuHistoryPoint[] = [];
  private sample?: GpuSample;
  private peaks: GpuStatus['peaks'] = { tempC: null, powerW: null, fanPct: null, since: Date.now() };
  private available = false;
  private error?: string;
  private stopped = true;
  private restartTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private fallback = false;
  private interval: number;

  constructor(private opts: GpuMonitorOptions = {}) {
    this.interval = opts.intervalMs ?? 2000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.spawn();
    this.watchdog = setInterval(() => this.checkStale(), Math.max(1000, this.interval));
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    this.proc?.kill();
    this.proc = undefined;
  }

  status(): GpuStatus {
    return {
      available: this.available,
      error: this.error,
      sample: this.sample,
      history: this.history,
      alerts: this.tracker.active(),
      peaks: this.peaks,
    };
  }

  private spawn(): void {
    const fields = (this.fallback ? FALLBACK_FIELDS : FIELDS).join(',');
    const command = this.opts.command ?? 'nvidia-smi';
    const args = this.opts.args ?? [`--query-gpu=${fields}`, '--format=csv,noheader,nounits', `-lms`, String(this.interval)];
    const startedAt = Date.now();
    let errText = '';
    let gotSample = false;
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this.fail(`Could not start ${command}: ${(e as Error).message}`);
      return;
    }
    this.proc = proc;
    proc.on('error', (e: NodeJS.ErrnoException) => {
      this.fail(e.code === 'ENOENT' ? 'nvidia-smi was not found, so GPU monitoring is off.' : `GPU monitor error: ${e.message}`, e.code !== 'ENOENT');
    });
    proc.stderr?.on('data', (d) => (errText = (errText + String(d)).slice(-2000)));
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      // nvidia-smi prints field errors on stdout too.
      if (/not a valid field|invalid/i.test(line)) {
        errText += line;
        return;
      }
      const s = parseSampleLine(line, Date.now(), this.fallback);
      if (!s || s.index !== (this.opts.gpuIndex ?? 0)) return;
      gotSample = true;
      this.ingest(s);
    });
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (this.stopped) return;
      if (!gotSample && !this.fallback && /valid field|invalid/i.test(errText)) {
        this.fallback = true;
        this.spawn();
        return;
      }
      if (!gotSample && Date.now() - startedAt < 3000 && errText) this.error = errText.trim().split(/\r?\n/)[0];
      this.restartTimer = setTimeout(() => this.spawn(), 5000);
      this.restartTimer.unref?.();
    });
  }

  private fail(message: string, retry = true): void {
    this.error = message;
    this.available = false;
    this.onUpdate?.(this.status());
    if (retry && !this.stopped) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.spawn(), 30_000);
      this.restartTimer.unref?.();
    }
  }

  /** Exposed for tests. */
  ingest(s: GpuSample): void {
    this.available = true;
    this.error = undefined;
    this.sample = s;
    this.history.push({ t: s.t, tempC: s.tempC, powerW: s.powerW, utilPct: s.utilPct, fanPct: s.fanPct });
    if (this.history.length > HISTORY_POINTS) this.history.splice(0, this.history.length - HISTORY_POINTS);
    const max = (a: number | null, b: number | null) => (b == null ? a : a == null ? b : Math.max(a, b));
    this.peaks = { ...this.peaks, tempC: max(this.peaks.tempC, s.tempC), powerW: max(this.peaks.powerW, s.powerW), fanPct: max(this.peaks.fanPct, s.fanPct) };
    const lost = this.tracker.clear('lost');
    if (lost) this.onAlert?.(lost, 'end');
    const { started, ended } = this.tracker.update(s);
    for (const a of started) this.onAlert?.(a, 'start');
    for (const a of ended) this.onAlert?.(a, 'end');
    this.onUpdate?.(this.status());
  }

  private checkStale(): void {
    if (!this.available || !this.sample) return;
    if (Date.now() - this.sample.t < this.interval * 3 + 5000) return;
    const alert: GpuAlert = { id: 'lost', level: 'critical', message: 'Lost contact with the GPU: no readings for a while. The driver may have crashed or the GPU is stuck.', since: Date.now() };
    if (this.tracker.raise(alert)) {
      this.onAlert?.(alert, 'start');
      this.onUpdate?.(this.status());
    }
  }
}
