/**
 * Side panel GPU strip: live readings, a 5-minute temperature sparkline, alerts, and an
 * expandable details view with temperature and power charts (separate charts, one axis each).
 * Built with DOM APIs only.
 */
import type { GpuHistoryPoint, GpuStatus } from '@ba/shared';

const SVG = 'http://www.w3.org/2000/svg';
const THROTTLE_TEMP = 83;

const REASON_TEXT: Record<string, string> = {
  idle: 'idle',
  power_cap: 'at its power limit (normal under full load)',
  sw_thermal: 'slowing down to stay cool',
  hw_thermal: 'hardware overheating protection',
  hw_slowdown: 'hardware slowdown (heat or power)',
  hw_power_brake: 'power-supply protection',
  app_clocks: 'clock setting',
  sync_boost: 'sync boost',
  display_clocks: 'display clock setting',
};

let last: GpuStatus | undefined;
let open = false;

const el = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function clear(n: Element): void {
  while (n.firstChild) n.removeChild(n.firstChild);
}

const gb = (mb: number | null) => (mb == null ? '?' : (mb / 1024).toFixed(1));
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function level(g: GpuStatus): 'ok' | 'warn' | 'critical' {
  if (g.alerts.some((a) => a.level === 'critical')) return 'critical';
  if (g.alerts.length) return 'warn';
  return 'ok';
}

export function renderGpu(g: GpuStatus): void {
  last = g;
  const root = el<HTMLElement>('gpu');
  if (!g.available && !g.sample) {
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');
  const s = g.sample!;
  const lv = level(g);
  root.dataset.level = lv;
  el<HTMLElement>('gpu-dot').title = lv === 'ok' ? 'GPU OK' : lv === 'warn' ? 'GPU warning' : 'GPU alert';

  const parts = [
    s.tempC != null ? `${s.tempC}°C` : null,
    s.fanPct != null ? `fan ${s.fanPct}%` : null,
    s.powerW != null ? `${Math.round(s.powerW)} W` : null,
    s.memUsedMB != null ? `${gb(s.memUsedMB)}/${gb(s.memTotalMB)} GB` : null,
    s.utilPct != null ? `load ${s.utilPct}%` : null,
  ].filter(Boolean);
  el<HTMLElement>('gpu-summary').textContent = `GPU ${parts.join(' · ')}`;

  sparkline(el<SVGSVGElement>('gpu-spark'), g.history);

  const alerts = el<HTMLElement>('gpu-alerts');
  clear(alerts);
  for (const a of g.alerts) {
    const row = document.createElement('div');
    row.className = `gpu-alert ${a.level}`;
    row.setAttribute('role', a.level === 'critical' ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = 'gpu-alert-icon';
    icon.textContent = a.level === 'critical' ? '⛔' : '⚠';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('strong');
    label.textContent = a.level === 'critical' ? 'Alert: ' : 'Warning: ';
    const msg = document.createElement('span');
    msg.textContent = `${a.message} (since ${clock(a.since)})`;
    row.append(icon, label, msg);
    alerts.append(row);
  }
  if (!g.available && g.error) {
    const row = document.createElement('div');
    row.className = 'gpu-alert warn';
    row.textContent = g.error;
    alerts.append(row);
  }
  if (open) renderDetails(g);
}

function sparkline(node: SVGSVGElement, hist: GpuHistoryPoint[]): void {
  clear(node);
  const pts = hist.filter((p) => p.tempC != null);
  if (pts.length < 2) return;
  const W = 60;
  const H = 16;
  const lo = Math.min(40, ...pts.map((p) => p.tempC!));
  const hi = Math.max(90, ...pts.map((p) => p.tempC!));
  const t0 = pts[0].t;
  const t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (v: number) => H - 1 - ((v - lo) / (hi - lo)) * (H - 2);
  node.append(svg('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.tempC!).toFixed(1)}`).join(''), class: 'spark-line' }));
}

function renderDetails(g: GpuStatus): void {
  const s = g.sample;
  const stats = el<HTMLElement>('gpu-stats');
  clear(stats);
  const add = (k: string, v: string) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    stats.append(dt, dd);
  };
  if (s) {
    add('Card', s.name);
    add('Temperature', s.tempC != null ? `${s.tempC}°C (slows itself down from ~${THROTTLE_TEMP}°C)` : 'n/a');
    if (s.memTempC != null) add('Memory temp', `${s.memTempC}°C`);
    add('Fan (noise)', s.fanPct != null ? `${s.fanPct}%${s.fanPct >= 85 ? ' (loud)' : s.fanPct >= 65 ? ' (audible)' : ' (quiet)'}` : 'n/a');
    add('Power', s.powerW != null ? `${Math.round(s.powerW)} W of ${s.powerLimitW != null ? Math.round(s.powerLimitW) : '?'} W limit` : 'n/a');
    add('Video memory', s.memUsedMB != null && s.memTotalMB != null ? `${gb(s.memUsedMB)} of ${gb(s.memTotalMB)} GB (${s.memTotalMB - s.memUsedMB} MB free)` : 'n/a');
    add('Load', s.utilPct != null ? `${s.utilPct}%` : 'n/a');
    if (s.smClockMHz != null) add('Clock', `${s.smClockMHz} MHz`);
    const reasons = s.reasons.filter((r) => r !== 'idle');
    add('Limited by', reasons.length ? reasons.map((r) => REASON_TEXT[r] ?? r).join(', ') : 'nothing');
  }
  const p = g.peaks;
  add('Peaks', [p.tempC != null ? `${p.tempC}°C` : null, p.fanPct != null ? `fan ${p.fanPct}%` : null, p.powerW != null ? `${Math.round(p.powerW)} W` : null].filter(Boolean).join(' · ') + ` since ${clock(p.since)}`);

  lineChart(el<HTMLElement>('gpu-chart-temp'), g.history.map((h) => ({ t: h.t, v: h.tempC })), { unit: '°C', min: 30, max: 95, ref: { v: THROTTLE_TEMP, label: `slows down ~${THROTTLE_TEMP}°C` } });
  const limit = s?.powerLimitW ?? null;
  lineChart(el<HTMLElement>('gpu-chart-power'), g.history.map((h) => ({ t: h.t, v: h.powerW })), {
    unit: ' W',
    min: 0,
    max: Math.max(100, limit ?? 0, ...g.history.map((h) => h.powerW ?? 0)),
    ref: limit != null ? { v: limit, label: `limit ${Math.round(limit)} W` } : undefined,
  });
}

interface ChartOpts {
  unit: string;
  min: number;
  max: number;
  ref?: { v: number; label: string };
}

/** Single-series line chart with a crosshair + tooltip on hover. */
function lineChart(box: HTMLElement, raw: { t: number; v: number | null }[], o: ChartOpts): void {
  clear(box);
  const pts = raw.filter((p): p is { t: number; v: number } => p.v != null);
  if (pts.length < 2) {
    const m = document.createElement('div');
    m.className = 'muted small';
    m.textContent = 'Collecting readings…';
    box.append(m);
    return;
  }
  // Draw in real pixels so text and lines aren't stretched.
  const W = Math.max(160, Math.round(box.clientWidth || 300));
  const H = 72;
  const padL = 30;
  const padR = 4;
  const padT = 6;
  const padB = 14;
  const lo = Math.min(o.min, ...pts.map((p) => p.v));
  const hi = Math.max(o.max, ...pts.map((p) => p.v));
  const t0 = pts[0].t;
  const t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img' });
  root.setAttribute('aria-label', `${pts[pts.length - 1].v}${o.unit} now; range ${Math.min(...pts.map((p) => p.v))}–${Math.max(...pts.map((p) => p.v))}${o.unit} over the last ${Math.round((t1 - t0) / 60000) || 1} min`);
  // Recessive axis: min/max labels + baseline.
  for (const v of [lo, hi]) {
    const tx = svg('text', { x: padL - 4, y: y(v) + 3, class: 'axis-label', 'text-anchor': 'end' });
    tx.textContent = `${Math.round(v)}`;
    root.append(tx);
  }
  root.append(svg('line', { x1: padL, x2: W - padR, y1: y(lo), y2: y(lo), class: 'axis' }));
  const span = svg('text', { x: padL, y: H - 2, class: 'axis-label' });
  span.textContent = `${Math.round((t1 - t0) / 60000) || '<1'} min ago`;
  const now = svg('text', { x: W - padR, y: H - 2, class: 'axis-label', 'text-anchor': 'end' });
  now.textContent = 'now';
  root.append(span, now);
  if (o.ref && o.ref.v >= lo && o.ref.v <= hi) {
    root.append(svg('line', { x1: padL, x2: W - padR, y1: y(o.ref.v), y2: y(o.ref.v), class: 'ref-line' }));
    const rl = svg('text', { x: padL + 3, y: y(o.ref.v) - 3, class: 'axis-label ref-label' });
    rl.textContent = o.ref.label;
    root.append(rl);
  }
  root.append(svg('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(''), class: 'chart-line' }));

  // Hover layer.
  const cross = svg('line', { y1: padT, y2: H - padB, class: 'crosshair', visibility: 'hidden' });
  const dot = svg('circle', { r: 3.5, class: 'hover-dot', visibility: 'hidden' });
  const hit = svg('rect', { x: padL, y: 0, width: W - padL - padR, height: H, fill: 'transparent' });
  root.append(cross, dot, hit);
  const tip = document.createElement('div');
  tip.className = 'chart-tip hidden';
  box.append(root, tip);
  hit.addEventListener('mousemove', (e) => {
    const r = root.getBoundingClientRect();
    const tx = t0 + ((((e.clientX - r.left) / r.width) * W - padL) / (W - padL - padR)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - tx) < Math.abs(best.t - tx)) best = p;
    const px = x(best.t);
    cross.setAttribute('x1', String(px));
    cross.setAttribute('x2', String(px));
    dot.setAttribute('cx', String(px));
    dot.setAttribute('cy', String(y(best.v)));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    tip.textContent = `${Math.round(best.v)}${o.unit} at ${clock(best.t)}`;
    tip.classList.remove('hidden');
    const left = (px / W) * r.width;
    tip.style.left = `${Math.min(Math.max(0, left - 50), r.width - 110)}px`;
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.classList.add('hidden');
  });
}

export function initGpu(): void {
  const toggle = el<HTMLButtonElement>('gpu-toggle');
  toggle.addEventListener('click', () => {
    open = !open;
    toggle.setAttribute('aria-expanded', String(open));
    el<HTMLElement>('gpu-details').classList.toggle('hidden', !open);
    if (open && last) renderDetails(last);
  });
  const notify = el<HTMLInputElement>('gpu-notify');
  void chrome.storage.local.get('gpuNotify').then((v) => (notify.checked = v.gpuNotify !== false));
  notify.addEventListener('change', () => void chrome.storage.local.set({ gpuNotify: notify.checked }));
}
