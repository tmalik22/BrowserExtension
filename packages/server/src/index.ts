import { loadConfig, profileAvailability, profileInfo, type ServerConfig } from './config.ts';
import { detectLocalModels, mergeDetected } from './local-models.ts';
import { consolePairPrompter, newNonce, safeEqualHex, whoamiProof } from './pairing.ts';
import { AgentServer } from './server.ts';

/**
 * Start listening. If the port is taken by an older Browser Agent server (e.g. one whose window
 * was lost, or a leftover background run), ask it to shut down and take over — so starting the
 * agent always works as a restart. Anything else on the port is reported plainly.
 */
export async function listenReplacingOld(server: AgentServer, config: ServerConfig, log = console.log): Promise<number> {
  try {
    return await server.listen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
  }
  const base = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  const health = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .catch(() => null)) as { ok?: boolean; version?: string } | null;
  if (!health?.ok || !health.version) {
    throw new Error(`Port ${config.port} is used by another program, so the agent server can't start. Close that program, or set AGENT_PORT in .env to a free port (and update the server URL in the extension's settings).`);
  }
  // Only hand the token to a server that proves it already holds it (not a program squatting on the port).
  const nonce = newNonce();
  const who = (await fetch(`${base}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .catch(() => null)) as { proof?: string } | null;
  if (!who?.proof || !safeEqualHex(who.proof, whoamiProof(config.token, nonce))) {
    throw new Error(
      `Port ${config.port} is used by a program that isn't this Browser Agent server (or one with a different data folder), so it won't be stopped automatically. ` +
        'Close it, or set AGENT_PORT in .env to a free port (and update the server URL in the extension settings).',
    );
  }
  log(`  An older agent server is still running on port ${config.port}. Replacing it…`);
  const res = await fetch(`${base}/api/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res?.ok) {
    throw new Error(
      `An older agent server is running on port ${config.port} and didn't agree to stop${res ? ` (HTTP ${res.status})` : ''}. ` +
        'Close its window, or end "node.exe" in Task Manager, then start again.',
    );
  }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      return await server.listen();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`The older agent server didn't free port ${config.port} in time. Close its window and start again.`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Show models already installed in Ollama / LM Studio without any models.json editing.
  if (process.env.AGENT_DETECT_LOCAL !== '0') {
    const found = await detectLocalModels(config.profiles);
    const merged = mergeDetected(config.profiles, config.defaultProfileId, found, (p) => profileAvailability(p).available);
    config.profiles = merged.profiles;
    config.defaultProfileId = merged.defaultProfileId;
  }
  let server: AgentServer;
  const shutdown = async (why = '') => {
    console.log(`\nShutting down${why}…`);
    await server.close().catch(() => {});
    process.exit(0);
  };
  server = new AgentServer(config, {
    gpu: process.env.BA_GPU === '0' ? false : {},
    // AGENT_TRANSCRIPTS=0: don't save session transcripts/screenshots to data/sessions (also disables chat history).
    transcripts: process.env.AGENT_TRANSCRIPTS !== '0',
    onShutdownRequest: () => void shutdown(' (a newer agent server is taking over)'),
    pairPrompt: consolePairPrompter(),
  });
  const port = await listenReplacingOld(server, config);
  const profiles = config.profiles.map(profileInfo);
  const lines = [
    '',
    `  Browser agent server listening on http://${config.host}:${port}  (WebSocket: ws://${config.host}:${port}/ws)`,
    '',
    `  Pairing token:  ${config.token}`,
    process.stdin.isTTY
      ? '  To pair a browser: open the side panel, then approve the code it shows when this window asks.\n  (Or paste the token above into the side panel → Settings → Pairing token.)'
      : '  Paste it into the extension side panel → Settings → Pairing token.',
    '',
    '  Models ready to use:',
    ...profiles.filter((p) => p.available).map((p) => `    ✓ ${p.label}${p.id === config.defaultProfileId ? '  [default]' : ''}`),
    ...(() => {
      const missing = profiles.filter((p) => !p.available);
      return missing.length ? [`    + ${missing.length} more need an API key: add it in the side panel → Settings → API keys.`] : [];
    })(),
    ...(config.profiles.some((p) => p.detected) ? [] : ['    Tip: install Ollama or LM Studio and your local models appear here automatically.']),
    '',
    `  Transcripts: ${config.dataDir}`,
    process.env.BA_GPU === '0' ? '  GPU monitor: off (BA_GPU=0)' : '  GPU monitor: on (alerts print here and in the side panel)',
    '',
    '  Keep this window open while you use the agent. To restart, just run Start Browser Agent again.',
    '',
  ];
  console.log(lines.join('\n'));
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(`\n  ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
