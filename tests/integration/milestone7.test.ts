import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { AnalyzeResponseSchema, IncidentDetailSchema, IncidentListResponseSchema } from '@civicmerge/contracts';
import { createMockVision } from '@civicmerge/ai-vision';
import { createGpsFeatureMatcher, ruleRouter } from '@civicmerge/matching';
import { createApp } from '../../apps/api/src/app.js';
import { createHs256JwtVerifier, signHs256Jwt } from '../../apps/api/src/auth/jwt.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createSupabaseStorage } from '../../apps/api/src/storage/supabase.js';
import { fakeStorage } from '../storage/helpers.js';

const SECRET = 'civicmerge-milestone7-jwt-secret-123456';
const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));
const png2 = await readFile(new URL('../../mocks/images/pothole-2.png', import.meta.url));

function makeToken(sub: string, role: 'citizen' | 'operator' = 'citizen') {
  return signHs256Jwt({
    sub,
    app_metadata: { role },
    name: role === 'operator' ? 'Cán bộ điều phối' : 'Cư dân A',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }, SECRET);
}

async function setup(t: TestContext) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'civicmerge-m7-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const fake = fakeStorage();
  const storage = createSupabaseStorage({
    url: 'https://project.supabase.co',
    secretKey: 'sb_secret_test',
    bucket: 'test',
    fetch: fake.fetcher,
  });
  const repository = createMemoryRepository();
  const app = createApp({
    repository,
    storage,
    imageDelivery: storage,
    publicBaseUrl: 'http://phone.test',
    uploadDir,
    mockMode: false,
    authVerifier: createHs256JwtVerifier({ secret: SECRET }),
    corsAllowedOrigins: ['https://admin.civicmerge.vn'],
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
  return { base, repository, fake };
}

test('CORS allows configured origin, handles OPTIONS preflight, and denies unknown origins', async t => {
  const { base } = await setup(t);
  const allowed = await fetch(base + '/health', {
    method: 'OPTIONS',
    headers: { Origin: 'https://admin.civicmerge.vn' },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://admin.civicmerge.vn');
  assert.match(allowed.headers.get('access-control-allow-methods') ?? '', /PATCH/);

  const denied = await fetch(base + '/health', {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('confirm userNote/override, ?q= & ?mine=true, team reassignment, resolution image upload, and push tokens', async t => {
  const { base, repository } = await setup(t);
  const citizenId = randomUUID();
  const operatorId = randomUUID();
  const citizenToken = makeToken(citizenId, 'citizen');
  const operatorToken = makeToken(operatorId, 'operator');

  // Analyze with persistent repository idempotency
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'pothole.png');
  form.append('latitude', '10.7769');
  form.append('longitude', '106.7009');
  const a1 = AnalyzeResponseSchema.parse(await (await fetch(base + '/api/reports/analyze', {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizenToken}`, 'Idempotency-Key': 'persist-key-1' },
    body: form,
  })).json());
  const stored = await repository.findAnalyzeIdempotency!('persist-key-1');
  assert.ok(stored && stored.response.reportId === a1.reportId);

  // Confirm with userNote + severity/description override
  const created = await (await fetch(base + '/api/reports/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${citizenToken}` },
    body: JSON.stringify({
      reportId: a1.reportId,
      action: 'create',
      userNote: 'Ngay trước cổng B ký túc xá',
      severity: 'high',
      description: 'Ổ gà rất sâu trước cổng B ký túc xá.',
    }),
  })).json();

  // Search by ?q= and ?mine=true
  const qRes = IncidentListResponseSchema.parse(await (await fetch(`${base}/api/incidents?q=${encodeURIComponent('cổng B')}`)).json());
  assert.equal(qRes.incidents.length, 1);
  assert.equal(qRes.incidents[0].severity, 'high');

  const mineRes = IncidentListResponseSchema.parse(await (await fetch(`${base}/api/incidents?mine=true`, {
    headers: { Authorization: `Bearer ${citizenToken}` },
  })).json());
  assert.equal(mineRes.incidents.length, 1);
  assert.equal((await fetch(`${base}/api/incidents?mine=true`)).status, 401);

  // Push token registration
  assert.equal((await fetch(base + '/api/push-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${citizenToken}` },
    body: JSON.stringify({ token: 'ExponentPushToken[test-token-123456]', platform: 'ios' }),
  })).status, 200);
  assert.deepEqual(await repository.listPushTokensForIncident!(created.incidentId), ['ExponentPushToken[test-token-123456]']);

  // Team reassignment (citizen forbidden, operator allowed)
  assert.equal((await fetch(`${base}/api/incidents/${created.incidentId}/team`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${citizenToken}` },
    body: JSON.stringify({ assignedTeam: 'Đội cơ động khu A' }),
  })).status, 403);

  const reassigned = IncidentDetailSchema.parse(await (await fetch(`${base}/api/incidents/${created.incidentId}/team`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ assignedTeam: 'Đội cơ động khu A', note: 'Ưu tiên gần trường học' }),
  })).json());
  assert.equal(reassigned.assignedTeam, 'Đội cơ động khu A');
  assert.equal(reassigned.history[1].event, 'team_reassigned');
  assert.equal(reassigned.reports[0].userNote, 'Ngay trước cổng B ký túc xá');

  // Resolution image upload (operator only)
  const proofForm = new FormData();
  proofForm.append('image', new Blob([png2], { type: 'image/png' }), 'after-fix.png');
  const proofRes = await fetch(`${base}/api/incidents/${created.incidentId}/resolution-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
    body: proofForm,
  });
  assert.equal(proofRes.status, 200);
  const withProof = IncidentDetailSchema.parse(await proofRes.json());
  assert.ok(withProof.resolutionImageUrl?.startsWith('http://phone.test/api/images/'));
  const imgFetch = await fetch(base + new URL(withProof.resolutionImageUrl!).pathname, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  assert.equal(imgFetch.status, 200);
  assert.deepEqual(Buffer.from(await imgFetch.arrayBuffer()), png2);
});
