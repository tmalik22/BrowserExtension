/**
 * The Chrome Web Store build leaves out two things the GitHub build has: the javascript_exec
 * tool and the CAPTCHA helper. They must be gone from the shipped files, not just switched off.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(root, 'packages/extension/dist-store');
const read = (f: string) => fs.readFileSync(path.join(out, f), 'utf8');

describe('Chrome Web Store build', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'packages/extension/build.ts', '--store'], { cwd: root, stdio: 'pipe' });
  }, 120_000);

  it('has no CAPTCHA helper code in any script', () => {
    for (const f of ['background.js', 'content.js', 'sidepanel.js']) {
      const js = read(f);
      // RPCs, content-script messages, challenge-provider hosts and the solver's settings.
      expect(js, f).not.toMatch(/captcha_(probe|observe|action)|ba:captcha|hcaptcha|recaptcha|turnstile|challenges\.cloudflare|set-captcha-helper|CaptchaKraken/i);
    }
  });

  it('has no CAPTCHA setting in the side panel', () => {
    expect(read('sidepanel.html')).not.toMatch(/captcha/i);
  });

  it('has no way to run arbitrary JavaScript in a page', () => {
    expect(read('background.js')).not.toContain('Runtime.evaluate');
  });

  it('is otherwise the same extension', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
    expect(read('sidepanel.html')).toContain('id="set-maxsteps"');
    expect(read('background.js')).toContain('session_begin');
  });
});
