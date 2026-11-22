import { loadConfig, profileInfo, type ServerConfig } from './config.ts';
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
  });
  const port = await listenReplacingOld(server, config);
  const profiles = config.profiles.map(profileInfo);
  const lines = [
    '',
    `  Browser agent server listening on http://${config.host}:${port}  (WebSocket: ws://${config.host}:${port}/ws)`,
    '',
    `  Pairing token:  ${config.token}`,
    '  Paste it into the extension side panel → Settings → Pairing token.',
    '',
    '  Model profiles:',
    ...profiles.map((p) => `    ${p.available ? '✓' : '✗'} ${p.id.padEnd(22)} ${p.label}${p.available ? '' : `  (${p.unavailableReason})`}${p.id === config.defaultProfileId ? '  [default]' : ''}`),
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
