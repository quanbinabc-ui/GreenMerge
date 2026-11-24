import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { AnalyzeResponseSchema, IncidentDetailSchema } from '@civicmerge/contracts';
import { createMockVision } from '@civicmerge/ai-vision';
import { createGpsFeatureMatcher, ruleRouter } from '@civicmerge/matching';
import { createApp } from '../../apps/api/src/app.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createLocalStorage } from '../../apps/api/src/storage/local.js';

const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));

async function setup(t: TestContext, options: { mockMode?: boolean; operatorApiKey?: string } = {}) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'civicmerge-lifecycle-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const repository = createMemoryRepository();
  const app = createApp({
    repository,
    storage: createLocalStorage(uploadDir, 'http://images.test'),
    uploadDir,
    mockMode: options.mockMode ?? true,
    operatorApiKey: options.operatorApiKey,
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
  const analyze = async () => {
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'photo.png');
    form.append('latitude', '10.7769');
    form.append('longitude', '106.7009');
    const response = await fetch(base + '/api/reports/analyze', { method: 'POST', body: form });
    assert.equal(response.status, 201);
    return AnalyzeResponseSchema.parse(await response.json());
  };
  const confirm = (body: unknown) => fetch(base + '/api/reports/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const patchStatus = (id: string, body: unknown, operatorKey?: string) => fetch(`${base}/api/incidents/${id}/status`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(operatorKey !== undefined ? { 'X-Operator-Key': operatorKey } : {}),
    },
    body: JSON.stringify(body),
  });
  return { base, repository, analyze, confirm, patchStatus };
}

test('PATCH /api/incidents/:id/status transitions open -> in_progress -> resolved and activates INCIDENT_RESOLVED guard', async t => {
  const { analyze, confirm, patchStatus } = await setup(t);
  const first = await analyze();
  const created = await (await confirm({ reportId: first.reportId, action: 'create' })).json();

  // Invalid same-status transition
  const sameRes = await patchStatus(created.incidentId, { status: 'open' });
  assert.equal(sameRes.status, 409);
  assert.equal((await sameRes.json()).error.code, 'INVALID_STATUS_TRANSITION');

  // open -> in_progress
  const inProgressRes = await patchStatus(created.incidentId, {
    status: 'in_progress',
    note: 'Tổ đường bộ đã tiếp nhận và cử đội khảo sát.',
    actor: 'Tổ trưởng đường bộ',
  });
  assert.equal(inProgressRes.status, 200);
  const inProgress = IncidentDetailSchema.parse(await inProgressRes.json());
  assert.equal(inProgress.status, 'in_progress');
  assert.equal(inProgress.history.length, 2);
  assert.equal(inProgress.history[1].event, 'status_changed');
  assert.equal(inProgress.history[1].fromStatus, 'open');
  assert.equal(inProgress.history[1].toStatus, 'in_progress');
  assert.equal(inProgress.history[1].actor, 'Tổ trưởng đường bộ');

  // Pending report created before resolution
  const second = await analyze();
  assert.equal(second.candidates[0].incidentId, created.incidentId);

  // in_progress -> resolved
  const resolvedRes = await patchStatus(created.incidentId, {
    status: 'resolved',
    note: 'Đã vá nhựa hoàn thiện mặt đường.',
    actor: 'Đội thi công #1',
  });
  assert.equal(resolvedRes.status, 200);
  const resolved = IncidentDetailSchema.parse(await resolvedRes.json());
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolutionNote, 'Đã vá nhựa hoàn thiện mặt đường.');
  assert.ok(resolved.resolvedAt);
  assert.equal(resolved.history.length, 3);

  // Terminal resolved state rejects further transitions
  const reopenRes = await patchStatus(created.incidentId, { status: 'open' });
  assert.equal(reopenRes.status, 409);
  assert.equal((await reopenRes.json()).error.code, 'INVALID_STATUS_TRANSITION');

  // Merge into API-resolved incident is rejected with INCIDENT_RESOLVED and keeps pending report intact
  const mergeRes = await confirm({ reportId: second.reportId, action: 'merge', targetIncidentId: created.incidentId });
  assert.equal(mergeRes.status, 409);
  assert.equal((await mergeRes.json()).error.code, 'INCIDENT_RESOLVED');

  // Unknown incident returns 404
  assert.equal((await patchStatus(randomUUID(), { status: 'in_progress' })).status, 404);
});

test('PATCH /api/incidents/:id/status enforces X-Operator-Key when configured and fails closed in real mode', async t => {
  const secured = await setup(t, { mockMode: true, operatorApiKey: 'secret-op-key-123' });
  const r1 = await secured.analyze();
  const c1 = await (await secured.confirm({ reportId: r1.reportId, action: 'create' })).json();

  assert.equal((await secured.patchStatus(c1.incidentId, { status: 'in_progress' })).status, 401);
  assert.equal((await secured.patchStatus(c1.incidentId, { status: 'in_progress' }, 'wrong-key')).status, 403);
  assert.equal((await secured.patchStatus(c1.incidentId, { status: 'in_progress' }, 'secret-op-key-123')).status, 200);

  const realWithoutKey = await setup(t, { mockMode: false });
  const r2 = await realWithoutKey.analyze();
  const c2 = await (await realWithoutKey.confirm({ reportId: r2.reportId, action: 'create' })).json();
  const blocked = await realWithoutKey.patchStatus(c2.incidentId, { status: 'in_progress' });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'OPERATOR_KEY_REQUIRED');
});
