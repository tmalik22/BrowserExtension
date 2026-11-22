/**
 * Screenshots sized to the model's image limits, and the scale needed to map the model's
 * coordinates (pixels of the image it saw) back to CSS pixels of the viewport.
 */
import { send } from './cdp.ts';

/** Long edge and pixel budget that fit every supported Claude model (and most other VLMs). */
export const MAX_LONG_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;

export interface Viewport {
  /** CSS px */
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
}

const scales = new Map<number, number>();

export function scaleFor(width: number, height: number): number {
  return Math.min(1, MAX_LONG_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
}

export async function viewport(tabId: number): Promise<Viewport> {
  const m = await send<any>(tabId, 'Page.getLayoutMetrics');
  const vv = m.cssVisualViewport ?? m.visualViewport;
  const lv = m.cssLayoutViewport ?? m.layoutViewport;
  const width = Math.round(vv?.clientWidth ?? lv?.clientWidth ?? 1280);
  const height = Math.round(vv?.clientHeight ?? lv?.clientHeight ?? 800);
  // Device pixel ratio: device-pixel visualViewport vs CSS one when both exist.
  const devW = m.visualViewport?.clientWidth;
  const dpr = m.cssVisualViewport && devW ? devW / m.cssVisualViewport.clientWidth : 1;
  return { width, height, dpr: dpr || 1, scrollX: vv?.pageX ?? 0, scrollY: vv?.pageY ?? 0 };
}

/** image px per CSS px for the tab's latest screenshot (or what the next one will use). */
export async function imageScale(tabId: number): Promise<number> {
  const s = scales.get(tabId);
  if (s) return s;
  const vp = await viewport(tabId);
  return scaleFor(vp.width, vp.height);
}

/** Convert a coordinate from screenshot space to CSS viewport space, validating bounds. */
export async function toCss(tabId: number, x: unknown, y: unknown): Promise<{ x: number; y: number }> {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('Error: coordinate target needs numeric x and y.');
  const s = await imageScale(tabId);
  const vp = await viewport(tabId);
  const cx = nx / s;
  const cy = ny / s;
  const maxX = Math.round(vp.width * s);
  const maxY = Math.round(vp.height * s);
  if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) {
    throw new Error(`Error: coordinate (${nx}, ${ny}) is outside the viewport (screenshot size ${maxX}x${maxY}).`);
  }
  return { x: Math.min(vp.width - 1, cx), y: Math.min(vp.height - 1, cy) };
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(bin);
  });
}

async function decode(b64png: string): Promise<ImageBitmap> {
  const bin = atob(b64png);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

async function encode(canvas: OffscreenCanvas, type: 'image/jpeg' | 'image/png'): Promise<string> {
  const blob = await canvas.convertToBlob(type === 'image/jpeg' ? { type, quality: 0.8 } : { type });
  return blobToBase64(blob);
}

export interface Shot {
  data: string;
  mediaType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

async function captureRaw(tabId: number): Promise<string> {
  const r = await send<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  return r.data;
}

/** Capture the viewport, resize to the model limits, remember the scale. */
export async function screenshot(tabId: number): Promise<Shot> {
  const vp = await viewport(tabId);
  const raw = await captureRaw(tabId);
  const bmp = await decode(raw);
  const s = scaleFor(vp.width, vp.height);
  const w = Math.max(1, Math.round(vp.width * s));
  const h = Math.max(1, Math.round(vp.height * s));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  // The raw capture is in device pixels; draw the full bitmap into CSS-scaled output.
  ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, w, h);
  bmp.close();
  scales.set(tabId, w / vp.width);
  return { data: await encode(canvas, 'image/jpeg'), mediaType: 'image/jpeg', width: w, height: h };
}

/** Crop region [x0,y0,x1,y1] (screenshot pixels) and upscale for detail. */
export async function zoom(tabId: number, region: unknown): Promise<Shot> {
  if (!Array.isArray(region) || region.length !== 4 || !region.every((n) => Number.isFinite(Number(n)))) {
    throw new Error('Error: region must be [x0, y0, x1, y1].');
  }
  const [x0, y0, x1, y1] = region.map(Number);
  if (x1 <= x0 || y1 <= y0) throw new Error('Error: region must have x1 > x0 and y1 > y0.');
  const vp = await viewport(tabId);
  const s = await imageScale(tabId);
  const raw = await captureRaw(tabId);
  const bmp = await decode(raw);
  const devPerCss = bmp.width / vp.width;
  // Region in device pixels, clamped to the capture.
  const sx = Math.max(0, (x0 / s) * devPerCss);
  const sy = Math.max(0, (y0 / s) * devPerCss);
  const sw = Math.min(bmp.width - sx, ((x1 - x0) / s) * devPerCss);
  const sh = Math.min(bmp.height - sy, ((y1 - y0) / s) * devPerCss);
  if (sw < 2 || sh < 2) {
    bmp.close();
    throw new Error('Error: region is outside the viewport.');
  }
  // Upscale up to 4x the source, within the image limits.
  const fit = Math.min(4, MAX_LONG_EDGE / Math.max(sw, sh), Math.sqrt(MAX_PIXELS / (sw * sh)));
  const w = Math.max(1, Math.round(sw * fit));
  const h = Math.max(1, Math.round(sh * fit));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close();
  return { data: await encode(canvas, 'image/png'), mediaType: 'image/png', width: w, height: h };
}

/**
 * Crop the challenge region for a captcha VLM: flat ~720² pixel budget, optional red cell
 * numbers for grids (the model is trained to read those, not infer a numbering).
 */
export async function captchaCrop(
  tabId: number,
  region: { x: number; y: number; w: number; h: number },
  cells: { x: number; y: number; w: number; h: number }[] = [],
): Promise<Shot & { rect: { x: number; y: number; w: number; h: number } }> {
  const vp = await viewport(tabId);
  const raw = await captureRaw(tabId);
  const bmp = await decode(raw);
  const devPerCss = bmp.width / vp.width;
  const pad = region.w >= vp.width - 2 ? 0 : 16;
  const x0 = Math.max(0, region.x - pad);
  const y0 = Math.max(0, region.y - pad);
  const x1 = Math.min(vp.width, region.x + region.w + pad);
  const y1 = Math.min(vp.height, region.y + region.h + pad);
  const sx = x0 * devPerCss;
  const sy = y0 * devPerCss;
  const sw = Math.max(2, (x1 - x0) * devPerCss);
  const sh = Math.max(2, (y1 - y0) * devPerCss);
  const fit = Math.min(4, Math.max(0.2, Math.sqrt(518_400 / (sw * sh))));
  const w = Math.max(1, Math.round(sw * fit));
  const h = Math.max(1, Math.round(sh * fit));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close();
  if (cells.length) {
    const k = w / (x1 - x0);
    ctx.font = `bold ${Math.max(14, Math.round(18 * k))}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#e11d48';
    cells.forEach((c, i) => {
      const cx = (c.x + c.w - (x0 + 3 / k)) * k;
      const cy = (c.y - y0 + 3 / k) * k;
      const label = String(i + 1);
      ctx.strokeText(label, cx, cy);
      ctx.fillText(label, cx, cy);
    });
  }
  return { data: await encode(canvas, 'image/png'), mediaType: 'image/png', width: w, height: h, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

export function forgetScale(tabId: number): void {
  scales.delete(tabId);
}
