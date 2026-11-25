import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  AnalyzeResponseSchema,
  IncidentDetailSchema,
  MyCertificatesResponseSchema,
  PublicVolunteerCertificateSchema,
  ReviewVolunteerEventResponseSchema,
  VolunteerEventDetailSchema,
  VolunteerEventListResponseSchema,
  type AIAnalysis,
  type PushNotifier,
} from '@civicmerge/contracts';
import { createGpsFeatureMatcher, ruleRouter } from '@civicmerge/matching';
import { createApp } from '../../apps/api/src/app.js';
import { createHs256JwtVerifier } from '../../apps/api/src/auth/jwt.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createLocalStorage } from '../../apps/api/src/storage/local.js';

const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));
const JWT_SECRET = 'greenmerge-test-jwt-secret-key-2026';

function signJwt(payload: { sub: string; role: 'citizen' | 'operator' | 'admin'; name?: string }) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    sub: payload.sub,
    app_metadata: { role: payload.role },
    user_metadata: payload.name ? { display_name: payload.name } : {},
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function setup(
  t: TestContext,
  options: {
    analysis?: () => AIAnalysis;
    authJwt?: boolean;
    operatorApiKey?: string;
    pushNotifier?: PushNotifier;
    failAfterImageWrite?: boolean;
  } = {},
) {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'greenmerge-volunteer-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const baseRepo = createMemoryRepository();
  const repository = options.failAfterImageWrite
    ? {
      ...baseRepo,
      async submitVolunteerAfterImage() {
        throw new Error('simulated db error');
      },
    }
    : baseRepo;
  let currentAnalysis: AIAnalysis = {
    type: 'trash',
    severity: 'medium',
    description: 'Bãi rác tự phát ven khu ký túc xá.',
    features: ['waste:plastic'],
  };
  const app = createApp({
    repository,
    storage: createLocalStorage(uploadDir, 'http://images.test'),
    uploadDir,
    mockMode: true,
    operatorApiKey: options.operatorApiKey,
    authVerifier: options.authJwt ? createHs256JwtVerifier({ secret: JWT_SECRET }) : undefined,
    pushNotifier: options.pushNotifier,
    vision: {
      async analyzeIncidentImage() {
        return options.analysis ? options.analysis() : currentAnalysis;
      },
    },
    matcher: createGpsFeatureMatcher(),
    router: ruleRouter,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function createIncident(analysis: AIAnalysis, token?: string): Promise<string> {
    currentAnalysis = analysis;
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'before.png');
    form.append('latitude', '10.7769');
    form.append('longitude', '106.7009');
    const analyzeRes = await fetch(`${base}/api/reports/analyze`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    assert.equal(analyzeRes.status, 201);
    const analyzed = AnalyzeResponseSchema.parse(await analyzeRes.json());
    const confirmRes = await fetch(`${base}/api/reports/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ reportId: analyzed.reportId, action: 'create' }),
    });
    assert.equal(confirmRes.status, 200);
    return (await confirmRes.json()).incidentId as string;
  }

  return { base, uploadDir, repository: baseRepo, createIncident };
}

test('Tier-2 safety rule blocks pothole and medium/high flood, allows trash and low flood', async t => {
  const { base, createIncident } = await setup(t);
  const scheduledAt = new Date(Date.now() + 3600_000).toISOString();
  const payload = {
    title: 'Dọn dẹp xanh cuối tuần',
    description: 'Mang găng tay và bao rác.',
    scheduledAt,
    meetingPoint: 'Cổng B ký túc xá',
    maxParticipants: 10,
  };

  const potholeId = await createIncident({
    type: 'pothole', severity: 'low', description: 'Ổ gà nhỏ', features: ['surface:asphalt'],
  });
  const potholeRes = await fetch(`${base}/api/incidents/${potholeId}/volunteer-events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(potholeRes.status, 409);
  assert.equal((await potholeRes.json()).error.code, 'UNSAFE_FOR_COMMUNITY');

  const floodMedId = await createIncident({
    type: 'flood', severity: 'medium', description: 'Ngập vừa', features: ['water:standing'],
  });
  const floodMedRes = await fetch(`${base}/api/incidents/${floodMedId}/volunteer-events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(floodMedRes.status, 409);
  assert.equal((await floodMedRes.json()).error.code, 'UNSAFE_FOR_COMMUNITY');

  const floodLowId = await createIncident({
    type: 'flood', severity: 'low', description: 'Đọng nước nhẹ do lá cây', features: ['water:puddle'],
  });
  const floodLowRes = await fetch(`${base}/api/incidents/${floodLowId}/volunteer-events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(floodLowRes.status, 201);
  const floodEvent = VolunteerEventDetailSchema.parse(await floodLowRes.json());
  assert.equal(floodEvent.incidentId, floodLowId);

  // Duplicate active event on same incident is rejected
  const dupRes = await fetch(`${base}/api/incidents/${floodLowId}/volunteer-events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(dupRes.status, 409);
  assert.equal((await dupRes.json()).error.code, 'VOLUNTEER_EVENT_EXISTS');
});

test('Full volunteer workflow: create -> join/full/leave -> after-image -> reject -> resubmit -> approve -> resolve & certificates + push', async t => {
  const pushCalls: Array<{ tokens: readonly string[]; title: string; incidentId: string }> = [];
  const { base, createIncident } = await setup(t, {
    authJwt: true,
    pushNotifier: {
      async notifyStatusChange(input) {
        pushCalls.push({ tokens: input.tokens, title: input.title, incidentId: input.incidentId });
      },
    },
  });

  const studentA = randomUUID();
  const studentB = randomUUID();
  const studentC = randomUUID();
  const operatorId = randomUUID();
  const tokenA = signJwt({ sub: studentA, role: 'citizen', name: 'Nguyễn Minh An' });
  const tokenB = signJwt({ sub: studentB, role: 'citizen', name: 'Trần Gia Bảo' });
  const tokenC = signJwt({ sub: studentC, role: 'citizen', name: 'Lê Thảo Chi' });
  const tokenOp = signJwt({ sub: operatorId, role: 'operator', name: 'Ban quản lý GreenMerge' });

  // Register push token for Student A and Student C
  for (const [tok, expo] of [[tokenA, 'ExponentPushToken[student-a-123]'], [tokenC, 'ExponentPushToken[student-c-456]']] as const) {
    const pushRes = await fetch(`${base}/api/push-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ token: expo, platform: 'ios' }),
    });
    assert.equal(pushRes.status, 200);
  }

  const trashId = await createIncident({
    type: 'trash', severity: 'high', description: 'Rác nhựa ven công viên sinh viên', features: ['waste:plastic'],
  }, tokenA);

  // Unauthenticated create fails in JWT mode
  const unauthCreate = await fetch(`${base}/api/incidents/${trashId}/volunteer-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Chiến dịch Xanh khu A',
      scheduledAt: new Date(Date.now() + 7200_000).toISOString(),
      meetingPoint: 'Cổng chính',
      maxParticipants: 2,
    }),
  });
  assert.equal(unauthCreate.status, 401);

  // Student A creates volunteer event (max 2 participants; A auto-joined -> 1/2)
  const createRes = await fetch(`${base}/api/incidents/${trashId}/volunteer-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({
      title: 'Chiến dịch Xanh khu A',
      description: 'Thu gom rác nhựa và phân loại.',
      scheduledAt: new Date(Date.now() + 7200_000).toISOString(),
      meetingPoint: 'Cổng chính công viên',
      maxParticipants: 2,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = VolunteerEventDetailSchema.parse(await createRes.json());
  assert.equal(created.participantCount, 1);
  assert.equal(created.status, 'recruiting');

  // Student A joining again is idempotent (still 1/2)
  const retryJoinA = await fetch(`${base}/api/volunteer-events/${created.id}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({}),
  });
  assert.equal(retryJoinA.status, 200);
  assert.equal(VolunteerEventDetailSchema.parse(await retryJoinA.json()).participantCount, 1);

  // Student B joins -> 2/2
  const joinB = await fetch(`${base}/api/volunteer-events/${created.id}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({}),
  });
  assert.equal(joinB.status, 200);
  assert.equal(VolunteerEventDetailSchema.parse(await joinB.json()).participantCount, 2);

  // Student C rejected because event is full (409 VOLUNTEER_EVENT_FULL)
  const joinCFull = await fetch(`${base}/api/volunteer-events/${created.id}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenC}` },
    body: JSON.stringify({}),
  });
  assert.equal(joinCFull.status, 409);
  assert.equal((await joinCFull.json()).error.code, 'VOLUNTEER_EVENT_FULL');

  // Student B leaves -> 1/2, then Student C joins -> 2/2
  const leaveB = await fetch(`${base}/api/volunteer-events/${created.id}/join`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  assert.equal(leaveB.status, 200);
  assert.equal(VolunteerEventDetailSchema.parse(await leaveB.json()).participantCount, 1);

  const joinC = await fetch(`${base}/api/volunteer-events/${created.id}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenC}` },
    body: JSON.stringify({ displayName: 'Lê Thảo Chi (K65)' }),
  });
  assert.equal(joinC.status, 200);
  assert.equal(VolunteerEventDetailSchema.parse(await joinC.json()).participantCount, 2);

  // Approve before After image fails with 409 AFTER_IMAGE_REQUIRED
  const approveNoImg = await fetch(`${base}/api/volunteer-events/${created.id}/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenOp}` },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(approveNoImg.status, 409);
  assert.equal((await approveNoImg.json()).error.code, 'AFTER_IMAGE_REQUIRED');

  // Citizen cannot review (403 FORBIDDEN)
  const citizenReview = await fetch(`${base}/api/volunteer-events/${created.id}/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ decision: 'reject', note: 'test' }),
  });
  assert.equal(citizenReview.status, 403);

  // Upload After image
  const uploadAfter = async () => {
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'after.png');
    return fetch(`${base}/api/volunteer-events/${created.id}/after-image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form,
    });
  };
  const afterRes1 = await uploadAfter();
  assert.equal(afterRes1.status, 200);
  const pendingReview = VolunteerEventDetailSchema.parse(await afterRes1.json());
  assert.equal(pendingReview.status, 'pending_review');
  assert.ok(pendingReview.afterImageUrl);

  // Operator rejects -> back to in_progress with note, incident stays open
  const rejectRes = await fetch(`${base}/api/volunteer-events/${created.id}/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenOp}` },
    body: JSON.stringify({ decision: 'reject', note: 'Vui lòng chụp góc rộng hơn.' }),
  });
  assert.equal(rejectRes.status, 200);
  const rejected = ReviewVolunteerEventResponseSchema.parse(await rejectRes.json());
  assert.equal(rejected.event.status, 'in_progress');
  assert.equal(rejected.event.reviewNote, 'Vui lòng chụp góc rộng hơn.');
  assert.equal(rejected.certificatesIssued, 0);

  // Re-upload After image -> pending_review
  const afterRes2 = await uploadAfter();
  assert.equal(afterRes2.status, 200);
  assert.equal(VolunteerEventDetailSchema.parse(await afterRes2.json()).status, 'pending_review');

  // Operator approves -> verified + incident auto-resolved + 2 certificates issued + push sent
  const approveRes = await fetch(`${base}/api/volunteer-events/${created.id}/review`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tokenOp}` },
    body: JSON.stringify({ decision: 'approve', note: 'Dọn dẹp rất sạch đẹp!' }),
  });
  assert.equal(approveRes.status, 200);
  const approved = ReviewVolunteerEventResponseSchema.parse(await approveRes.json());
  assert.equal(approved.event.status, 'verified');
  assert.equal(approved.certificatesIssued, 2);
  const activeCerts = approved.event.participants.filter(p => p.status === 'certified');
  assert.equal(activeCerts.length, 2);
  assert.ok(activeCerts.every(p => p.certificateCode && /^GM-\d{4}-[A-Z0-9]{6}$/.test(p.certificateCode)));

  // Incident is now resolved with afterImageUrl and volunteer history events
  const incRes = await fetch(`${base}/api/incidents/${trashId}`);
  assert.equal(incRes.status, 200);
  const incDetail = IncidentDetailSchema.parse(await incRes.json());
  assert.equal(incDetail.status, 'resolved');
  assert.equal(incDetail.resolutionImageUrl, approved.event.afterImageUrl);
  assert.equal(incDetail.resolutionNote, 'Dọn dẹp rất sạch đẹp!');
  const eventTypes = incDetail.history.map(h => h.event);
  assert.ok(eventTypes.includes('volunteer_event_created'));
  assert.ok(eventTypes.includes('volunteer_after_submitted'));
  assert.ok(eventTypes.includes('volunteer_verified'));

  // Push notifications sent to Student A and Student C
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].tokens.length, 2);

  // List endpoint reports stats accurately
  const listRes = await fetch(`${base}/api/volunteer-events?status=verified`);
  assert.equal(listRes.status, 200);
  const listed = VolunteerEventListResponseSchema.parse(await listRes.json());
  assert.equal(listed.events.length, 1);
  assert.deepEqual(listed.stats, { verifiedEvents: 1, totalCertificates: 2 });

  // Student C retrieves own certificates
  const myCertsRes = await fetch(`${base}/api/me/certificates`, {
    headers: { Authorization: `Bearer ${tokenC}` },
  });
  assert.equal(myCertsRes.status, 200);
  const myCerts = MyCertificatesResponseSchema.parse(await myCertsRes.json());
  assert.equal(myCerts.certificates.length, 1);
  assert.equal(myCerts.certificates[0].recipientName, 'Lê Thảo Chi (K65)');
  const code = myCerts.certificates[0].certificateCode;

  // Public lookup succeeds without auth and does NOT expose userId
  const publicRes = await fetch(`${base}/api/certificates/${code.toLowerCase()}`);
  assert.equal(publicRes.status, 200);
  const rawPublic = await publicRes.json() as Record<string, unknown>;
  assert.equal('userId' in rawPublic, false);
  const publicCert = PublicVolunteerCertificateSchema.parse(rawPublic);
  assert.equal(publicCert.certificateCode, code);
  assert.equal(publicCert.recipientName, 'Lê Thảo Chi (K65)');

  // Unknown certificate returns 404
  assert.equal((await fetch(`${base}/api/certificates/GM-2026-NOTFND`)).status, 404);
});

test('POST /api/volunteer-events/:id/after-image rolls back uploaded file if database write fails', async t => {
  const { base, uploadDir, createIncident } = await setup(t, { failAfterImageWrite: true });
  const trashId = await createIncident({
    type: 'trash', severity: 'low', description: 'Rác công viên', features: ['waste:paper'],
  });
  const createRes = await fetch(`${base}/api/incidents/${trashId}/volunteer-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Nhặt rác sáng Chủ nhật',
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      meetingPoint: 'Sân trường',
      maxParticipants: 5,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = VolunteerEventDetailSchema.parse(await createRes.json());
  const beforeFiles = await readdir(uploadDir);

  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'after.png');
  const failRes = await fetch(`${base}/api/volunteer-events/${created.id}/after-image`, {
    method: 'POST',
    body: form,
  });
  assert.equal(failRes.status, 503);
  const afterFiles = await readdir(uploadDir);
  assert.deepEqual(afterFiles, beforeFiles);
});
