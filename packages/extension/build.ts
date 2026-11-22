/**
 * Builds the extension into packages/extension/dist (load it unpacked from there).
 *   tsx build.ts            production build
 *   tsx build.ts --watch    rebuild on change
 * Also emits dist-test/outline-harness.js, the content-script modules exposed on window for
 * Playwright tests of the page outline without the extension.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const watch = process.argv.includes('--watch');

// --- tiny PNG writer for the icons (no image deps) ---------------------------------------------
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function icon(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // Rounded square in the brand colour with a lighter "cursor" dot.
      const dx = Math.max(r - x - 0.5, x + 0.5 - (size - r), 0);
      const dy = Math.max(r - y - 0.5, y + 0.5 - (size - r), 0);
      const inside = Math.hypot(dx, dy) <= r;
      const cx = x - size * 0.62;
      const cy = y - size * 0.62;
      const dot = Math.hypot(cx, cy) <= size * 0.16;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (!inside) continue;
      const [R, G, B] = dot ? [255, 244, 236] : [217, 119, 87];
      raw[o] = R;
      raw[o + 1] = G;
      raw[o + 2] = B;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function copyStatic(): void {
  fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(path.join(here, 'static'))) {
    const src = path.join(here, 'static', f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dist, f));
  }
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(dist, 'icons', `${s}.png`), icon(s));
}

const common: esbuild.BuildOptions = {
  bundle: true,
  target: 'chrome125',
  sourcemap: 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

async function main(): Promise<void> {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  copyStatic();
  const builds: esbuild.BuildOptions[] = [
    { ...common, entryPoints: [path.join(here, 'src/background/index.ts')], outfile: path.join(dist, 'background.js'), format: 'esm' },
    // Content scripts are classic scripts: IIFE.
    { ...common, entryPoints: [path.join(here, 'src/content/index.ts')], outfile: path.join(dist, 'content.js'), format: 'iife' },
    { ...common, entryPoints: [path.join(here, 'src/sidepanel/main.ts')], outfile: path.join(dist, 'sidepanel.js'), format: 'esm' },
    {
      ...common,
      entryPoints: [path.join(here, 'test/harness.ts')],
      outfile: path.join(here, 'dist-test/outline-harness.js'),
      format: 'iife',
      sourcemap: false,
    },
  ];
  if (watch) {
    for (const b of builds) await (await esbuild.context(b)).watch();
    console.log('watching…');
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
