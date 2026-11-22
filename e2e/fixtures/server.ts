/**
 * Fixture web server for browser tests: serves e2e/fixtures/site, plus /download/* (attachment)
 * and /slow (delayed). Tests use "localhost" and "127.0.0.1" as two different sites, so the
 * cross-origin iframe is out-of-process.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');

export interface FixtureServer {
  port: number;
  url(pathname: string, host?: string): string;
  close(): Promise<void>;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/download/')) {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${path.basename(u.pathname)}"` });
      res.end('a,b\n1,2\n');
      return;
    }
    if (u.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Slow</title><h1>Finally loaded</h1>');
      }, Number(u.searchParams.get('ms') ?? 1500));
      return;
    }
    const file = path.normalize(path.join(root, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(port, '0.0.0.0', () => r()));
  const p = (server.address() as { port: number }).port;
  return {
    port: p,
    url: (pathname: string, host = 'localhost') => `http://${host}:${p}/${pathname.replace(/^\//, '')}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
