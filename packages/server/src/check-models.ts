/**
 * Verify model profiles: sends one small request per profile (with the browser tools attached)
 * and reports whether it answered, called a tool, and how long it took. Costs a few hundred
 * tokens per profile.
 *
 *   npm run check-models                 all available profiles
 *   npm run check-models -- claude-opus  one profile
 */
import { selectMembers } from '@ba/shared';
import { KeyStore, loadConfig, profileAvailability } from './config.ts';
import { buildSystemPrompt } from './agent/system-prompt.ts';
import { createProvider } from './providers/index.ts';
import type { Turn } from './providers/types.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  new KeyStore(config.dataDir, () => config.profiles); // keys saved from the side panel
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const profiles = config.profiles.filter((p) => p.provider !== 'mock' && (!only.length || only.includes(p.id)));
  if (!profiles.length) {
    console.log('No matching profiles.');
    return;
  }
  let failures = 0;
  for (const p of profiles) {
    const avail = profileAvailability(p);
    if (!avail.available) {
      console.log(`- ${p.id.padEnd(20)} skipped: ${avail.reason}`);
      continue;
    }
    const t0 = Date.now();
    try {
      const provider = createProvider(p);
      const members = selectMembers({ toolSet: p.toolSet, vision: p.vision });
      const history: Turn[] = [
        { role: 'user', parts: [{ type: 'text', text: 'The task starts in tab tab-1 (https://example.com). Read the page to find its main heading. Use a tool.' }] },
      ];
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), p.timeoutMs ?? 120_000);
      const r = await provider.complete({ system: buildSystemPrompt(p), history, members, profile: p }, {}, ac.signal);
      clearTimeout(timer);
      const calls = r.parts.filter((x) => x.type === 'tool_call').map((x) => (x as { name: string }).name);
      const ok = calls.length > 0;
      if (!ok) failures++;
      console.log(
        `${ok ? '✓' : '!'} ${p.id.padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${ok ? `called ${calls.join(', ')}` : `no tool call (stop: ${r.stopReason})`}  tokens in/out: ${r.usage.inputTokens + r.usage.cacheReadTokens}/${r.usage.outputTokens}`,
      );
    } catch (e) {
      failures++;
      console.log(`✗ ${p.id.padEnd(20)} ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (failures) {
    console.log('\nProfiles marked ✗ or ! will not work well as browser agents. "!" means the model replied without calling a tool: try toolMode "json" or a model with tool calling.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
