/**
 * Builds the extension into packages/extension/dist (load it unpacked from there).
 *   tsx build.ts            production build
 *   tsx build.ts --watch    rebuild on change
 *   tsx build.ts --store    Chrome Web Store build into dist-store (javascript_exec compiled out)
 * Also emits dist-test/outline-harness.js, the content-script modules exposed on window for
 * Playwright tests of the page outline without the extension.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
/** --store: the Chrome Web Store build (no javascript_exec), written to dist-store/. */
const store = process.argv.includes('--store');
const dist = path.join(here, store ? 'dist-store' : 'dist');

/** Copy static/ (manifest, side panel, icons) into the output folder. */
function copyStatic(): void {
  fs.cpSync(path.join(here, 'static'), dist, { recursive: true });
}

const common: esbuild.BuildOptions = {
  bundle: true,
  target: 'chrome125',
  sourcemap: 'linked',
  logLevel: 'info',
  legalComments: 'none',
  define: { __BA_STORE__: store ? 'true' : 'false' },
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
