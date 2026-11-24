import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ADMIN_PORT ?? 4173);
const host = process.env.ADMIN_HOST ?? '127.0.0.1';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  let relativePath = url.pathname === '/' ? 'public/index.html' : url.pathname.slice(1);
  if (!relativePath.startsWith('dist/')) {
    relativePath = path.join('public', relativePath);
  }
  const resolved = path.resolve(dir, relativePath);
  if (!resolved.startsWith(dir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(resolved);
    const ext = path.extname(resolved);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not Found');
  }
});

server.listen(port, host, () => {
  console.log(`CivicMerge Web Admin running at http://${host}:${port}`);
});
