import { describe, expect, it } from 'vitest';
import type { GpuSample, GpuStatus } from '@ba/shared';
import { AlertTracker, GpuMonitor, decodeReasons, parseSampleLine } from '../src/gpu.ts';

const line = (o: Partial<{ temp: number | string; fan: number; power: number; used: number; reasons: string; util: number }> = {}) =>
  `0, NVIDIA GeForce RTX 3090, ${o.temp ?? 60}, N/A, ${o.fan ?? 60}, ${o.power ?? 300}, 370.00, ${o.util ?? 90}, ${o.used ?? 23600}, 24576, 1800, ${o.reasons ?? '0x0000000000000004'}, P2`;

const sample = (o: Parameters<typeof line>[0] = {}, t = Date.now()) => parseSampleLine(line(o), t)!;

describe('parsing nvidia-smi output', () => {
  it('parses a sample line, treating N/A as missing', () => {
    const s = parseSampleLine('0, NVIDIA GeForce RTX 3090, 57, N/A, 63, 232.95, 370.00, 100, 23687, 24576, 1830, 0x0000000000000004, P2', 5)!;
    expect(s).toMatchObject({ t: 5, index: 0, tempC: 57, memTempC: null, fanPct: 63, powerW: 232.95, powerLimitW: 370, utilPct: 100, memUsedMB: 23687, memTotalMB: 24576, reasons: ['power_cap'], pstate: 'P2' });
    expect(parseSampleLine('garbage')).toBeNull();
    expect(parseSampleLine('Field "x" is not a valid field to query.')).toBeNull();
  });
  it('decodes throttle reasons', () => {
    expect(decodeReasons('0x0000000000000024')).toEqual(['power_cap', 'sw_thermal']);
    expect(decodeReasons('0x48')).toEqual(['hw_slowdown', 'hw_thermal']);
    expect(decodeReasons('[N/A]')).toEqual([]);
  });
});

describe('GPU alerts', () => {
  const feed = (tr: AlertTracker, samples: GpuSample[]) => samples.map((s) => tr.update(s));

  it('raises a heat warning only after it persists, escalates, and clears with hysteresis', () => {
    const tr = new AlertTracker();
    feed(tr, [sample({ temp: 84 }), sample({ temp: 84 })]);
    expect(tr.active()).toEqual([]); // two hot samples: still a blip
    const [r] = feed(tr, [sample({ temp: 85 })]);
    expect(r.started.map((a) => [a.id, a.level])).toEqual([['temp', 'warn']]);
    const [esc] = feed(tr, [sample({ temp: 89 })]);
    expect(esc.started[0]).toMatchObject({ id: 'temp', level: 'critical' });
    expect(tr.active()[0].message).toMatch(/89°C/);
    // 82°C is below the warning threshold but inside the hysteresis band: stays raised.
    feed(tr, Array.from({ length: 6 }, () => sample({ temp: 82 })));
    expect(tr.active().map((a) => a.id)).toEqual(['temp']);
    const ends = feed(tr, Array.from({ length: 5 }, () => sample({ temp: 70 })));
    expect(ends.flatMap((e) => e.ended).map((a) => a.id)).toEqual(['temp']);
    expect(tr.active()).toEqual([]);
  });

  it('does not alert on normal full-load readings (power cap, ~1 GB free, 75% fan)', () => {
    const tr = new AlertTracker();
    feed(tr, Array.from({ length: 30 }, () => sample({ temp: 70, fan: 75, power: 365, used: 23700, reasons: '0x4' })));
    expect(tr.active()).toEqual([]);
  });

  it('flags hardware throttling, sustained thermal slowdown, loud fans and nearly-full video memory', () => {
    const tr = new AlertTracker();
    feed(tr, Array.from({ length: 10 }, () => sample({ temp: 75, fan: 95, used: 24400, reasons: '0x64' })));
    const ids = tr.active().map((a) => `${a.id}:${a.level}`);
    expect(ids).toEqual(expect.arrayContaining(['hw-throttle:critical', 'sw-thermal:warn', 'fan:warn', 'vram:warn']));
    expect(tr.active()[0].level).toBe('critical'); // critical first
  });

  it('ignores a single thermal-slowdown blip', () => {
    const tr = new AlertTracker();
    feed(tr, [sample({ reasons: '0x24' }), sample(), sample({ reasons: '0x24' }), sample()]);
    expect(tr.active()).toEqual([]);
  });
});

describe('GpuMonitor', () => {
  it('streams samples from a source process and reports alerts', async () => {
    const script = `let i=0;setInterval(()=>{i++;console.log(${JSON.stringify(line({ temp: '@@' }))}.replace('@@', i>2?'90':'60'))},30)`;
    const m = new GpuMonitor({ command: process.execPath, args: ['-e', script], intervalMs: 30 });
    const updates: GpuStatus[] = [];
    const alerts: string[] = [];
    m.onUpdate = (s) => updates.push(s);
    m.onAlert = (a, c) => alerts.push(`${c}:${a.id}:${a.level}`);
    m.start();
    const t0 = Date.now();
    while (!alerts.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    m.stop();
    expect(alerts[0]).toBe('start:temp:critical');
    const st = m.status();
    expect(st.available).toBe(true);
    expect(st.sample?.tempC).toBe(90);
    expect(st.history.length).toBeGreaterThan(3);
    expect(st.peaks.tempC).toBe(90);
  });

  it('reports a missing nvidia-smi without crashing', async () => {
    const m = new GpuMonitor({ command: 'definitely-not-nvidia-smi-xyz', args: [] });
    let last: GpuStatus | undefined;
    m.onUpdate = (s) => (last = s);
    m.start();
    const t0 = Date.now();
    while (!last && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    m.stop();
    expect(last).toMatchObject({ available: false });
    expect(last!.error).toMatch(/not found/);
  });

  it('raises "lost contact" when readings stop, and clears it when they resume', async () => {
    const m = new GpuMonitor({ command: process.execPath, args: ['-e', ''], intervalMs: 10 });
    const alerts: string[] = [];
    m.onAlert = (a, c) => alerts.push(`${c}:${a.id}`);
    m.ingest(sample({}, Date.now() - 60_000));
    (m as any).checkStale();
    expect(alerts).toEqual(['start:lost']);
    expect(m.status().alerts[0]).toMatchObject({ id: 'lost', level: 'critical' });
    m.ingest(sample());
    expect(alerts).toEqual(['start:lost', 'end:lost']);
    expect(m.status().alerts).toEqual([]);
  });
});
