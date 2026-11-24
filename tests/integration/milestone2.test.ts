import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  AnalyzeResponseSchema, IncidentDetailSchema, IncidentListResponseSchema, ReportSchema,
  type AIAnalysis,
} from '@civicmerge/contracts';
import { createGpsFeatureMatcher, ruleRouter } from '@civicmerge/matching';
import { createApp } from '../../apps/api/src/app.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createLocalStorage } from '../../apps/api/src/storage/local.js';

const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));

async function setup(t: TestContext) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'civicmerge-m2-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const repository = createMemoryRepository();
  let currentAnalysis: AIAnalysis = {
    type: 'pothole',
    severity: 'low',
    description: 'Ổ gà nhỏ trên mặt đường nhựa.',
    features: ['surface:asphalt'],
  };
  let visionCalls = 0;
  let nearbyCalls = 0;
  let fullListCalls = 0;
  const wrappedRepo = {
    ...repository,
    list: async (...args: Parameters<typeof repository.list>) => { fullListCalls++; return repository.list(...args); },
    listNearbyOpen: async (query: Parameters<NonNullable<typeof repository.listNearbyOpen>>[0]) => {
      nearbyCalls++;
      return repository.listNearbyOpen!(query);
    },
  };
  const app = createApp({
    repository: wrappedRepo,
    storage: createLocalStorage(uploadDir, 'http://images.test'),
    uploadDir,
    mockMode: true,
    vision: { async analyzeIncidentImage() { visionCalls++; return structuredClone(currentAnalysis); } },
    matcher: createGpsFeatureMatcher(),
    router: ruleRouter,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const analyze = (options: { lat?: string; lng?: string; idempotencyKey?: string; bytes?: Uint8Array } = {}) => {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(options.bytes ?? png)], { type: 'image/png' }), 'photo.png');
    if (options.lat !== undefined && options.lng !== undefined) {
      form.append('latitude', options.lat);
      form.append('longitude', options.lng);
    }
    return fetch(base + '/api/reports/analyze', {
      method: 'POST',
      headers: options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
      body: form,
    });
  };
  const confirm = (body: unknown) => fetch(base + '/api/reports/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    base,
    analyze,
    confirm,
    setAnalysis(next: AIAnalysis) { currentAnalysis = next; },
    stats: () => ({ visionCalls, nearbyCalls, fullListCalls }),
  };
}

test('analyze uses listNearbyOpen (not full list), supports Idempotency-Key and GET /api/reports/:id', async t => {
  const { base, analyze, confirm, stats } = await setup(t);
  const firstRes = await analyze({ lat: '10.7769', lng: '106.7009', idempotencyKey: 'req-key-001' });
  assert.equal(firstRes.status, 201);
  const first = AnalyzeResponseSchema.parse(await firstRes.json());
  assert.equal(stats().visionCalls, 1);
  assert.equal(stats().nearbyCalls, 1);
  assert.equal(stats().fullListCalls, 0);

  // Replay with identical key and payload returns same pending report without re-calling AI.
  const replayRes = await analyze({ lat: '10.7769', lng: '106.7009', idempotencyKey: 'req-key-001' });
  assert.equal(replayRes.status, 201);
  assert.deepEqual(await replayRes.json(), first);
  assert.equal(stats().visionCalls, 1);

  // Reusing key with different payload returns 409 IDEMPOTENCY_KEY_CONFLICT.
  const conflictRes = await analyze({ lat: '10.8000', lng: '106.7009', idempotencyKey: 'req-key-001' });
  assert.equal(conflictRes.status, 409);
  assert.equal((await conflictRes.json()).error.code, 'IDEMPOTENCY_KEY_CONFLICT');

  // Invalid Idempotency-Key header returns 400.
  assert.equal((await analyze({ lat: '10.7769', lng: '106.7009', idempotencyKey: 'bad key with spaces!' })).status, 400);

  // GET /api/reports/:id retrieves pending report and reflects confirmed status after confirm.
  const pendingRes = await fetch(`${base}/api/reports/${first.reportId}`);
  assert.equal(pendingRes.status, 200);
  const pending = ReportSchema.parse(await pendingRes.json());
  assert.equal(pending.status, 'pending');
  assert.equal(pending.incidentId, null);

  const created = await (await confirm({ reportId: first.reportId, action: 'create' })).json();
  const confirmedRes = await fetch(`${base}/api/reports/${first.reportId}`);
  assert.equal(confirmedRes.status, 200);
  const confirmed = ReportSchema.parse(await confirmedRes.json());
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.incidentId, created.incidentId);

  assert.equal((await fetch(`${base}/api/reports/${randomUUID()}`)).status, 404);
});

test('merge unions features and escalates severity; GET /api/incidents supports filtering and pagination', async t => {
  const { base, analyze, confirm, setAnalysis } = await setup(t);

  // Incident 1: pothole low, surface:asphalt
  const r1 = AnalyzeResponseSchema.parse(await (await analyze({ lat: '10.7769', lng: '106.7009' })).json());
  const c1 = await (await confirm({ reportId: r1.reportId, action: 'create' })).json();

  // Merge report with higher severity & new feature
  setAnalysis({
    type: 'pothole',
    severity: 'high',
    description: 'Ổ gà sâu mở rộng có nguy cơ tai nạn.',
    features: ['shape:irregular', 'surface:asphalt'],
  });
  const r2 = AnalyzeResponseSchema.parse(await (await analyze({ lat: '10.77691', lng: '106.7009' })).json());
  assert.equal(r2.candidates[0].incidentId, c1.incidentId);
  await confirm({ reportId: r2.reportId, action: 'merge', targetIncidentId: c1.incidentId });

  const detail1 = IncidentDetailSchema.parse(await (await fetch(`${base}/api/incidents/${c1.incidentId}`)).json());
  assert.equal(detail1.severity, 'high');
  assert.deepEqual(detail1.features, ['shape:irregular', 'surface:asphalt']);

  // Incident 2: trash medium
  setAnalysis({ type: 'trash', severity: 'medium', description: 'Rác thải sinh hoạt chất đống.', features: ['material:plastic'] });
  const r3 = AnalyzeResponseSchema.parse(await (await analyze({ lat: '10.7775', lng: '106.7010' })).json());
  await confirm({ reportId: r3.reportId, action: 'create' });

  // Incident 3: flood low
  setAnalysis({ type: 'flood', severity: 'low', description: 'Đọng nước nhẹ ven đường.', features: ['surface:water'] });
  const r4 = AnalyzeResponseSchema.parse(await (await analyze({ lat: '10.7780', lng: '106.7015' })).json());
  await confirm({ reportId: r4.reportId, action: 'create' });

  // Filter by type
  const trashList = IncidentListResponseSchema.parse(await (await fetch(`${base}/api/incidents?type=trash`)).json());
  assert.equal(trashList.incidents.length, 1);
  assert.equal(trashList.total, 1);
  assert.equal(trashList.incidents[0].type, 'trash');

  // Filter by severity
  const highList = IncidentListResponseSchema.parse(await (await fetch(`${base}/api/incidents?severity=high`)).json());
  assert.equal(highList.incidents.length, 1);
  assert.equal(highList.total, 1);
  assert.equal(highList.incidents[0].id, c1.incidentId);

  // Pagination limit & offset
  const page1 = IncidentListResponseSchema.parse(await (await fetch(`${base}/api/incidents?limit=2&offset=0`)).json());
  assert.equal(page1.incidents.length, 2);
  assert.equal(page1.total, 3);
  const page2 = IncidentListResponseSchema.parse(await (await fetch(`${base}/api/incidents?limit=2&offset=2`)).json());
  assert.equal(page2.incidents.length, 1);
  assert.equal(page2.total, 3);
  assert.notEqual(page1.incidents[0].id, page2.incidents[0].id);

  // Invalid query params return 400
  assert.equal((await fetch(`${base}/api/incidents?type=unknown`)).status, 400);
  assert.equal((await fetch(`${base}/api/incidents?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/incidents?foo=bar`)).status, 400);
});
