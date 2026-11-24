import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ApiErrorSchema } from '@civicmerge/contracts';
import { createMockVision } from '@civicmerge/ai-vision';
import { mockMatcher, ruleRouter } from '@civicmerge/matching';
import { createApp, type ReadinessChecks, type RequestLogEntry } from '../../apps/api/src/app.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createSupabaseStorage } from '../../apps/api/src/storage/supabase.js';
import { fakeStorage } from '../storage/helpers.js';

const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));

async function setup(t: TestContext, options: {
  analyzeRateLimit?: { maxRequests: number; windowMs: number } | false;
  checkReady?: () => Promise<ReadinessChecks>;
  onRequestLog?: (entry: RequestLogEntry) => void;
} = {}) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'civicmerge-harden-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const fake = fakeStorage();
  const storage = createSupabaseStorage({
    url: 'https://project.supabase.co',
    secretKey: 'sb_secret_test',
    bucket: 'test',
    fetch: fake.fetcher,
  });
  const app = createApp({
    repository: createMemoryRepository(),
    storage,
    imageDelivery: storage,
    publicBaseUrl: 'http://phone.test',
    uploadDir,
    mockMode: true,
    vision: createMockVision(() => 'pothole'),
    matcher: mockMatcher,
    router: ruleRouter,
    analyzeRateLimit: options.analyzeRateLimit,
    checkReady: options.checkReady,
    onRequestLog: options.onRequestLog,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const analyze = () => {
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'photo.png');
    form.append('latitude', '10.7769');
    form.append('longitude', '106.7009');
    return fetch(base + '/api/reports/analyze', { method: 'POST', body: form });
  };
  return { base, analyze };
}

test('security headers, X-Request-Id propagation, and structured safe logging', async t => {
  const logs: RequestLogEntry[] = [];
  const { base } = await setup(t, { onRequestLog: entry => logs.push(entry) });

  const echoed = await fetch(base + '/health', { headers: { 'X-Request-Id': 'req-custom-123', 'X-Operator-Key': 'top-secret' } });
  assert.equal(echoed.status, 200);
  assert.equal(echoed.headers.get('x-request-id'), 'req-custom-123');
  assert.equal(echoed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(echoed.headers.get('x-frame-options'), 'DENY');
  assert.equal(echoed.headers.get('referrer-policy'), 'no-referrer');

  const generated = await fetch(base + '/health', { headers: { 'X-Request-Id': 'invalid id with spaces!' } });
  assert.ok(generated.headers.get('x-request-id'));
  assert.notEqual(generated.headers.get('x-request-id'), 'invalid id with spaces!');

  assert.equal(logs.length, 2);
  assert.equal(logs[0].requestId, 'req-custom-123');
  assert.equal(logs[0].method, 'GET');
  assert.equal(logs[0].path, '/health');
  assert.equal(logs[0].status, 200);
  assert.ok(logs[0].latencyMs >= 0);
  assert.doesNotMatch(JSON.stringify(logs), /top-secret/);
});

test('POST /api/reports/analyze enforces rate limit with 429 RATE_LIMITED and Retry-After', async t => {
  const { analyze } = await setup(t, { analyzeRateLimit: { maxRequests: 2, windowMs: 60_000 } });
  assert.equal((await analyze()).status, 201);
  assert.equal((await analyze()).status, 201);
  const blocked = await analyze();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(ApiErrorSchema.parse(await blocked.json()).error.code, 'RATE_LIMITED');
});

test('GET /api/images returns ETag and private cache headers and responds 304 on If-None-Match', async t => {
  const { base, analyze } = await setup(t);
  const analyzed = await (await analyze()).json();
  const report = await (await fetch(`${base}/api/reports/${analyzed.reportId}`)).json();
  const imagePath = new URL(report.imageUrl).pathname;

  const first = await fetch(base + imagePath);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, max-age=300');
  const etag = first.headers.get('etag');
  assert.ok(etag && etag.startsWith('"'));
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png);

  const cached = await fetch(base + imagePath, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
});

test('GET /health/ready reports readiness and redacts dependency errors on 503', async t => {
  let healthy = true;
  const { base } = await setup(t, {
    checkReady: async () => {
      if (!healthy) throw new Error('postgresql://secret-user:secret-pass@db/prod');
      return { database: 'ok', storage: 'ok' };
    },
  });
  const ok = await fetch(base + '/health/ready');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: 'ready', checks: { database: 'ok', storage: 'ok' } });

  healthy = false;
  const down = await fetch(base + '/health/ready');
  assert.equal(down.status, 503);
  const body = await down.text();
  assert.equal(ApiErrorSchema.parse(JSON.parse(body)).error.code, 'NOT_READY');
  assert.doesNotMatch(body, /secret-user|secret-pass/);
});
