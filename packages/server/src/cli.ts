/**
 * Run a task from the terminal against a running agent server and a connected browser.
 *
 *   npm run task -- "Summarize this page"
 *   npm run task -- --profile claude-sonnet --url https://example.com "What is this site about?"
 *   npm run task -- --session s_abc "Now open the pricing page"     (continue a session)
 *   npm run task -- --auto-approve "…"                               (approve every prompt; careful)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { AgentEvent } from '@ba/shared';
import { ROOT, loadEnv } from './config.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const flags = new Set(['--profile', '--url', '--session', '--server', '--client']);
  const rest: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (flags.has(a)) i++;
    else if (!a.startsWith('--')) rest.push(a);
  }
  const text = rest.join(' ').trim();
  if (!text) {
    console.error('Usage: npm run task -- [--profile id] [--url https://…] [--session id] [--auto-approve] "task"');
    process.exit(2);
  }
  const base = arg('server') ?? `http://${process.env.AGENT_HOST ?? '127.0.0.1'}:${process.env.AGENT_PORT ?? 7878}`;
  const tokenFile = path.join(process.env.AGENT_DATA_DIR ?? path.join(ROOT, 'data'), 'token.txt');
  const token = process.env.AGENT_TOKEN ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
  if (!token) throw new Error('No token: start the server once (npm run server) or set AGENT_TOKEN.');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const autoApprove = process.argv.includes('--auto-approve');

  const sessionArg = arg('session');
  const res = sessionArg
    ? await fetch(`${base}/api/sessions/${sessionArg}/messages`, { method: 'POST', headers, body: JSON.stringify({ text, profileId: arg('profile') }) })
    : await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, profileId: arg('profile'), startUrl: arg('url'), clientId: arg('client'), autoApprove: autoApprove ? 'allow_once' : undefined }),
      });
  const body = (await res.json()) as { sessionId?: string; error?: string };
  if (!res.ok || !body.sessionId) throw new Error(body.error ?? `HTTP ${res.status}`);
  const sessionId = body.sessionId;
  console.log(`session ${sessionId}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const sse = await fetch(`${base}/api/sessions/${sessionId}/events`, { headers });
  const reader = sse.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let seenDone = false;
  let lastSeq = 0;
  // Only render events from this turn onward.
  const state = (await (await fetch(`${base}/api/sessions/${sessionId}`, { headers })).json()) as { events: { seq: number; event: AgentEvent }[] };
  const startSeq = sessionArg ? Math.max(0, ...state.events.filter((e) => e.event.type === 'turn_done').map((e) => e.seq)) : 0;
  while (!seenDone) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const id = Number(chunk.match(/^id: (\d+)/m)?.[1] ?? 0);
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (!data || id <= lastSeq || id <= startSeq) continue;
      lastSeq = id;
      const ev = JSON.parse(data) as AgentEvent;
      switch (ev.type) {
        case 'thinking':
          console.log(`\x1b[2m(thinking) ${ev.text.slice(0, 400)}${ev.text.length > 400 ? '…' : ''}\x1b[0m`);
          break;
        case 'text':
          console.log(`\n${ev.text}\n`);
          break;
        case 'tool_call':
          process.stdout.write(`  → ${ev.summary} `);
          break;
        case 'tool_result':
          console.log(ev.isError ? `\x1b[31m✗ ${ev.text.split('\n')[0].slice(0, 200)}\x1b[0m` : '\x1b[32m✓\x1b[0m');
          break;
        case 'notice':
          console.log(`\x1b[33m[${ev.level}] ${ev.message}\x1b[0m`);
          break;
        case 'approval_request': {
          if (autoApprove) break;
          console.log(`\n\x1b[35mApproval needed: ${ev.reason}\n  ${ev.summary}\x1b[0m`);
          const choices = ev.kind === 'site' ? '[o]nce / [a]lways for this site / [d]eny' : '[y]es / [n]o';
          const a = (await rl.question(`  ${choices}? `)).trim().toLowerCase();
          const decision = a.startsWith('a') ? 'allow_site' : a.startsWith('y') || a.startsWith('o') ? 'allow_once' : 'deny';
          await fetch(`${base}/api/approvals/${ev.approvalId}`, { method: 'POST', headers, body: JSON.stringify({ decision }) });
          break;
        }
        case 'usage':
          break;
        case 'turn_done':
          console.log(`\x1b[2m— ${ev.reason}\x1b[0m`);
          seenDone = true;
          break;
      }
    }
  }
  await reader.cancel().catch(() => {});
  rl.close();
  const final = (await (await fetch(`${base}/api/sessions/${sessionId}`, { headers })).json()) as { usage: Record<string, number> };
  console.log(`\x1b[2musage: ${JSON.stringify(final.usage)}\nContinue with: npm run task -- --session ${sessionId} "…"\x1b[0m`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
