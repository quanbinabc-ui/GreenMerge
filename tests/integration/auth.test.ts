import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { AnalyzeResponseSchema, IncidentDetailSchema, MyReportsResponseSchema } from '@civicmerge/contracts';
import { createMockVision } from '@civicmerge/ai-vision';
import { createGpsFeatureMatcher, ruleRouter } from '@civicmerge/matching';
import { createApp } from '../../apps/api/src/app.js';
import { createHs256JwtVerifier, signHs256Jwt } from '../../apps/api/src/auth/jwt.js';
import { readBackendConfig } from '../../apps/api/src/bootstrap/configured.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createSupabaseStorage } from '../../apps/api/src/storage/supabase.js';
import { fakeStorage } from '../storage/helpers.js';

const SECRET = 'civicmerge-test-jwt-secret-key-0123456789';
const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));

function makeToken(options: { sub?: string; role?: string; expOffsetSec?: number; secret?: string; name?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signHs256Jwt({
    sub: options.sub ?? randomUUID(),
    app_metadata: { role: options.role ?? 'citizen' },
    name: options.name ?? 'Người dùng thử nghiệm',
    exp: now + (options.expOffsetSec ?? 3600),
  }, options.secret ?? SECRET);
}

async function setup(t: TestContext) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'civicmerge-auth-'));
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
    mockMode: false,
    authVerifier: createHs256JwtVerifier({ secret: SECRET }),
    vision: createMockVision(() => 'pothole'),
    matcher: createGpsFeatureMatcher(),
    router: ruleRouter,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const analyze = (token?: string) => {
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'photo.png');
    form.append('latitude', '10.7769');
    form.append('longitude', '106.7009');
    return fetch(base + '/api/reports/analyze', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
  };
  return { base, analyze };
}

test('AUTH_MODE=jwt requires AUTH_JWT_SECRET and rejects missing/short secret without fallback', () => {
  assert.throws(() => readBackendConfig({ PUBLIC_BASE_URL: 'http://api.test', AUTH_MODE: 'jwt' }, '.'), /AUTH_JWT_SECRET/);
  assert.throws(() => readBackendConfig({ PUBLIC_BASE_URL: 'http://api.test', AUTH_MODE: 'jwt', AUTH_JWT_SECRET: 'short' }, '.'), /AUTH_JWT_SECRET/);
  const cfg = readBackendConfig({ PUBLIC_BASE_URL: 'http://api.test', AUTH_MODE: 'jwt', AUTH_JWT_SECRET: SECRET }, '.');
  assert.equal(cfg.authMode, 'jwt');
});

test('JWT verifier rejects expired, wrong-signature, and invalid-subject tokens; accepts Supabase authenticated claim', async () => {
  const verifier = createHs256JwtVerifier({ secret: SECRET });
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(verifier.verifyToken(makeToken({ expOffsetSec: -10 })), { code: 'UNAUTHORIZED', status: 401 });
  await assert.rejects(verifier.verifyToken(makeToken({ secret: 'different-secret-0123456789' })), { code: 'UNAUTHORIZED', status: 401 });
  await assert.rejects(verifier.verifyToken(signHs256Jwt({ sub: 'not-a-uuid', exp: now + 300 }, SECRET)), { code: 'UNAUTHORIZED', status: 401 });
  const user = await verifier.verifyToken(signHs256Jwt({ sub: randomUUID(), role: 'authenticated', exp: now + 300 }, SECRET));
  assert.equal(user.role, 'citizen');
});

test('JWT auth enforces 401, reporter ownership (403), GET /api/me/reports, RBAC status updates, and image auth', async t => {
  const { base, analyze } = await setup(t);
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const opId = randomUUID();
  const aliceToken = makeToken({ sub: aliceId, role: 'citizen', name: 'Alice' });
  const bobToken = makeToken({ sub: bobId, role: 'citizen', name: 'Bob' });
  const opToken = makeToken({ sub: opId, role: 'operator', name: 'Tổ trưởng A' });

  // Unauthenticated analyze and me/reports fail with 401
  assert.equal((await analyze()).status, 401);
  assert.equal((await fetch(base + '/api/me/reports')).status, 401);

  // Alice analyzes and creates pending report
  const analyzeRes = await analyze(aliceToken);
  assert.equal(analyzeRes.status, 201);
  const analyzed = AnalyzeResponseSchema.parse(await analyzeRes.json());

  // Bob cannot view or confirm Alice's pending report (403 FORBIDDEN)
  assert.equal((await fetch(`${base}/api/reports/${analyzed.reportId}`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  })).status, 403);
  assert.equal((await fetch(base + '/api/reports/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ reportId: analyzed.reportId, action: 'create' }),
  })).status, 403);

  // Alice can view and confirm her own report
  const ownReport = await (await fetch(`${base}/api/reports/${analyzed.reportId}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  })).json();
  assert.equal(ownReport.reporterId, aliceId);
  const imagePath = new URL(ownReport.imageUrl).pathname;

  // Protected image proxy rejects anonymous, allows Bearer or ?token=
  assert.equal((await fetch(base + imagePath)).status, 401);
  assert.equal((await fetch(base + imagePath, { headers: { Authorization: `Bearer ${aliceToken}` } })).status, 200);
  assert.equal((await fetch(`${base}${imagePath}?token=${encodeURIComponent(aliceToken)}`)).status, 200);

  const confirmRes = await fetch(base + '/api/reports/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ reportId: analyzed.reportId, action: 'create' }),
  });
  assert.equal(confirmRes.status, 200);
  const created = await confirmRes.json();

  // GET /api/me/reports returns only the authenticated user's reports
  const aliceReports = MyReportsResponseSchema.parse(await (await fetch(base + '/api/me/reports', {
    headers: { Authorization: `Bearer ${aliceToken}` },
  })).json());
  assert.equal(aliceReports.reports.length, 1);
  assert.equal(aliceReports.reports[0].id, analyzed.reportId);

  const bobReports = MyReportsResponseSchema.parse(await (await fetch(base + '/api/me/reports', {
    headers: { Authorization: `Bearer ${bobToken}` },
  })).json());
  assert.equal(bobReports.reports.length, 0);

  // Citizen cannot update status (403); operator can update status and actorId is recorded
  const citizenPatch = await fetch(`${base}/api/incidents/${created.incidentId}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(citizenPatch.status, 403);

  const opPatch = await fetch(`${base}/api/incidents/${created.incidentId}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${opToken}` },
    body: JSON.stringify({ status: 'in_progress', note: 'Đã cử đội kiểm tra.' }),
  });
  assert.equal(opPatch.status, 200);
  const updated = IncidentDetailSchema.parse(await opPatch.json());
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.history[1].actor, 'Tổ trưởng A');
  assert.equal(updated.history[1].actorId, opId);
});
