import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AuthSessionResponseSchema, IncidentDetailSchema } from '@civicmerge/contracts';
import { createMockVision } from '@civicmerge/ai-vision';
import { createGpsFeatureMatcher, ruleRouter } from '@civicmerge/matching';
import { createApp } from '../../apps/api/src/app.js';
import { createHs256JwtVerifier, signHs256Jwt } from '../../apps/api/src/auth/jwt.js';
import { createSupabaseAuthClient } from '../../apps/api/src/auth/supabase-auth.js';
import { createNominatimGeocoder, formatNominatimAddress } from '../../apps/api/src/geo/nominatim.js';
import { createExpoPushNotifier } from '../../apps/api/src/notifications/expo-push.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createLocalStorage } from '../../apps/api/src/storage/local.js';

const SECRET = 'civicmerge-m11-jwt-secret-key-0123456789';
const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));

test('formatNominatimAddress builds concise Vietnamese address and handles missing data safely', () => {
  assert.equal(
    formatNominatimAddress({
      address: { house_number: '227', road: 'Nguyễn Văn Cừ', suburb: 'Phường 4', city_district: 'Quận 5', city: 'TP. Hồ Chí Minh' },
    }),
    '227 Nguyễn Văn Cừ, Phường 4, Quận 5, TP. Hồ Chí Minh',
  );
  assert.equal(formatNominatimAddress({ display_name: 'Khu đô thị ĐHQG' }), 'Khu đô thị ĐHQG');
  assert.equal(formatNominatimAddress(null), null);
});

test('POST /api/auth/login & /signup, reverse geocoding on create, and Expo Push notification on status change', async t => {
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'civicmerge-m11-'));
  t.after(() => rm(uploadDir, { recursive: true, force: true }));
  const citizenId = randomUUID();
  const operatorId = randomUUID();
  const citizenJwt = signHs256Jwt({ sub: citizenId, app_metadata: { role: 'citizen' }, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const operatorJwt = signHs256Jwt({ sub: operatorId, app_metadata: { role: 'operator' }, name: 'Cán bộ X', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);

  const authClient = createSupabaseAuthClient({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_test',
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (url.includes('/token?grant_type=password')) {
        if (body.password === 'wrongpass') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({
          access_token: citizenJwt,
          refresh_token: 'refresh-123',
          expires_in: 3600,
          user: { id: citizenId, email: body.email, app_metadata: { role: 'citizen' }, user_metadata: { display_name: 'Sinh viên A' } },
        });
      }
      return Response.json({
        access_token: citizenJwt,
        expires_in: 3600,
        user: { id: citizenId, email: body.email, app_metadata: { role: 'citizen' }, user_metadata: { display_name: 'Tài khoản mới' } },
      });
    },
  });

  const pushedPayloads: unknown[] = [];
  const pushNotifier = createExpoPushNotifier({
    fetchImpl: async (_input, init) => {
      pushedPayloads.push(JSON.parse(String(init?.body ?? '[]')));
      return Response.json({ data: [{ status: 'ok' }] });
    },
  });

  const geocoder = createNominatimGeocoder({
    fetchImpl: async () => Response.json({
      address: { road: 'Đường Tạ Quang Bửu', suburb: 'Đông Hòa', city: 'Dĩ An' },
    }),
  });

  const app = createApp({
    repository: createMemoryRepository(),
    storage: createLocalStorage(uploadDir, 'http://images.test'),
    uploadDir,
    mockMode: false,
    authVerifier: createHs256JwtVerifier({ secret: SECRET }),
    authClient,
    pushNotifier,
    geocoder,
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

  // Login failure & success
  assert.equal((await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sv@uni.edu.vn', password: 'wrongpass' }),
  })).status, 400);

  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sv@uni.edu.vn', password: 'validpassword' }),
  });
  assert.equal(loginRes.status, 200);
  const session = AuthSessionResponseSchema.parse(await loginRes.json());
  assert.equal(session.user.id, citizenId);
  assert.equal(session.user.displayName, 'Sinh viên A');

  // Signup success
  const signupRes = await fetch(base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new@uni.edu.vn', password: 'validpassword', displayName: 'Tài khoản mới' }),
  });
  assert.equal(signupRes.status, 201);

  // Register push token for citizen
  assert.equal((await fetch(base + '/api/push-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ token: 'ExponentPushToken[citizen-m11-token]', platform: 'ios' }),
  })).status, 200);

  // Analyze + confirm create triggers reverse geocoder and saves readable address
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'photo.png');
  form.append('latitude', '10.878');
  form.append('longitude', '106.806');
  const analyzed = await (await fetch(base + '/api/reports/analyze', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` },
    body: form,
  })).json();
  const created = await (await fetch(base + '/api/reports/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({ reportId: analyzed.reportId, action: 'create' }),
  })).json();

  const detail = IncidentDetailSchema.parse(await (await fetch(`${base}/api/incidents/${created.incidentId}`)).json());
  assert.equal(detail.address, 'Đường Tạ Quang Bửu, Đông Hòa, Dĩ An');

  // Operator updates status -> triggers Expo Push notification to citizen's registered token
  const patchRes = await fetch(`${base}/api/incidents/${created.incidentId}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${operatorJwt}` },
    body: JSON.stringify({ status: 'in_progress', note: 'Đội thi công đang di chuyển tới hiện trường.' }),
  });
  assert.equal(patchRes.status, 200);
  assert.equal(pushedPayloads.length, 1);
  const batch = pushedPayloads[0] as Array<{ to: string; title: string; body: string; data: { incidentId: string; status: string } }>;
  assert.equal(batch[0].to, 'ExponentPushToken[citizen-m11-token]');
  assert.equal(batch[0].data.incidentId, created.incidentId);
  assert.equal(batch[0].data.status, 'in_progress');
});
