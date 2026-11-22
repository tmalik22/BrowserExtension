/**
 * Bundles the agent server into one file (release/server/server.mjs) that runs with plain
 * `node server.mjs`: no git, no npm install. Used by scripts/package-release.py.
 *   npx tsx scripts/build-server.ts
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release', 'server');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'packages/server/src/index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  legalComments: 'eof',
  define: { __BA_BUNDLE__: 'true' },
  // ws optionally loads these native speed-ups; it works fine without them.
  external: ['bufferutil', 'utf-8-validate'],
  // Bundled CommonJS dependencies call require(); give ESM a real one.
  banner: { js: "import { createRequire as __baCreateRequire } from 'node:module'; const require = __baCreateRequire(import.meta.url);" },
  logLevel: 'info',
});

for (const f of ['models.example.json', '.env.example', 'LICENSE']) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log(`Server bundle written to ${path.relative(root, out)}`);
