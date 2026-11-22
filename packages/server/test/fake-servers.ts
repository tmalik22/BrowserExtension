/**
 * Minimal fake model servers for adapter tests: record requests, reply with scripted SSE/JSON.
 */
import http from 'node:http';

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export type Responder = (req: Recorded, n: number) => { status?: number; sse?: unknown[]; json?: unknown; raw?: string; headers?: Record<string, string> };

/**
 * `requests` records model calls only. GET …/models (the context-window lookup) is answered
 * separately: with `opts.models` as the list, or 404 — and counted in `modelLookups`.
 */
export async function fakeServer(
  responder: Responder,
  opts: { models?: unknown[] } = {},
): Promise<{ url: string; requests: Recorded[]; modelLookups: () => number; close(): Promise<void> }> {
  const requests: Recorded[] = [];
  let lookups = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET' && /\/models(\?|$)/.test(req.url ?? '')) {
      lookups++;
      res.writeHead(opts.models ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(opts.models ? { data: opts.models } : { error: { message: 'Not found' } }));
      return;
    }
    const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) : undefined };
    requests.push(rec);
    const r = responder(rec, requests.length);
    const status = r.status ?? 200;
    if (r.sse) {
      res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...(r.headers ?? {}) });
      for (const ev of r.sse) {
        if (typeof ev === 'string') res.write(`data: ${ev}\n\n`);
        else {
          const e = ev as { type?: string };
          res.write(`${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(ev)}\n\n`);
        }
      }
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
    res.end(r.raw ?? JSON.stringify(r.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    modelLookups: () => lookups,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Anthropic Messages SSE for a list of content blocks. */
export function anthropicSse(blocks: any[], opts: { stop?: string; stopDetails?: unknown; model?: string } = {}): unknown[] {
  const ev: unknown[] = [
    {
      type: 'message_start',
      message: { id: 'msg_test', type: 'message', role: 'assistant', model: opts.model ?? 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of b.text.match(/.{1,5}/gs) ?? []) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else if (b.type === 'thinking') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature ?? 'sig' } });
    } else if (b.type === 'tool_use') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {}, toolset_name: b.toolset_name ?? 'browser' } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: opts.stop ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null, ...(opts.stopDetails ? { stop_details: opts.stopDetails } : {}) }, usage: { output_tokens: 42 } });
  ev.push({ type: 'message_stop' });
  return ev;
}

/** OpenAI chat.completion.chunk SSE. */
export function openaiSse(opts: { text?: string; reasoning?: string; calls?: { id: string; name: string; args: string }[]; finish?: string }): unknown[] {
  const out: unknown[] = [];
  const chunk = (delta: any, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
  out.push(chunk({ role: 'assistant' }));
  if (opts.reasoning) out.push(chunk({ reasoning_content: opts.reasoning }));
  if (opts.text) for (const p of opts.text.match(/.{1,4}/gs) ?? []) out.push(chunk({ content: p }));
  opts.calls?.forEach((c, i) => {
    out.push(chunk({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] }));
    const half = Math.ceil(c.args.length / 2);
    out.push(chunk({ tool_calls: [{ index: i, function: { arguments: c.args.slice(0, half) } }] }));
    out.push(chunk({ tool_calls: [{ index: i, function: { arguments: c.args.slice(half) } }] }));
  });
  out.push(chunk({}, opts.finish ?? (opts.calls?.length ? 'tool_calls' : 'stop')));
  out.push({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } });
  out.push('[DONE]');
  return out;
}
