import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { IncidentSummary, VolunteerEvent } from '@civicmerge/contracts';
import { createAdminClient, normalizeAdminBaseUrl } from '../../apps/web-admin/src/api.js';
import {
  allowedNextStatuses,
  computeKpis,
  escapeHtml,
  googleMapsUrl,
  projectHotspots,
  sortQueueByPriority,
  sortVolunteerEventsForReview,
  statusStepIndex,
  VOLUNTEER_STATUS_LABELS,
} from '../../apps/web-admin/src/state.js';

function makeIncident(overrides: Partial<IncidentSummary> = {}): IncidentSummary {
  const now = '2026-11-24T00:00:00.000Z';
  return {
    id: randomUUID(),
    type: 'pothole',
    severity: 'medium',
    description: 'Ổ gà trên đường',
    location: { latitude: 10.7769, longitude: 106.7009 },
    features: ['surface:asphalt'],
    status: 'open',
    assignedTeam: 'Tổ đường bộ (thí điểm)',
    reportCount: 1,
    coverImageUrl: 'http://api.test/uploads/1.png',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('computeKpis calculates counts and duplicate reduction rate accurately', () => {
  const kpis = computeKpis([
    makeIncident({ status: 'open', reportCount: 3 }),
    makeIncident({ status: 'in_progress', reportCount: 2 }),
    makeIncident({ status: 'resolved', reportCount: 1 }),
  ]);
  assert.equal(kpis.totalIncidents, 3);
  assert.equal(kpis.openCount, 1);
  assert.equal(kpis.inProgressCount, 1);
  assert.equal(kpis.resolvedCount, 1);
  assert.equal(kpis.totalReports, 6);
  assert.equal(kpis.mergedReports, 3);
  assert.equal(kpis.duplicateReductionRate, 50);
});

test('sortQueueByPriority places active high-severity and high-report-count incidents first', () => {
  const resolvedHigh = makeIncident({ status: 'resolved', severity: 'high', reportCount: 10 });
  const openLow = makeIncident({ status: 'open', severity: 'low', reportCount: 5 });
  const openHighMany = makeIncident({ status: 'open', severity: 'high', reportCount: 4 });
  const openHighOne = makeIncident({ status: 'open', severity: 'high', reportCount: 1 });
  const sorted = sortQueueByPriority([resolvedHigh, openLow, openHighOne, openHighMany]);
  assert.deepEqual(sorted.map(item => item.id), [openHighMany.id, openHighOne.id, openLow.id, resolvedHigh.id]);
});

test('allowedNextStatuses, googleMapsUrl, and escapeHtml enforce safe transitions and XSS protection', () => {
  assert.deepEqual(allowedNextStatuses('open'), ['in_progress', 'resolved']);
  assert.deepEqual(allowedNextStatuses('in_progress'), ['resolved', 'open']);
  assert.deepEqual(allowedNextStatuses('resolved'), []);
  assert.equal(
    googleMapsUrl({ latitude: 10.7769, longitude: 106.7009 }),
    'https://www.google.com/maps/search/?api=1&query=10.776900,106.700900',
  );
  assert.equal(googleMapsUrl(null), null);
  assert.equal(escapeHtml('<script>"alert"</script>'), '&lt;script&gt;&quot;alert&quot;&lt;/script&gt;');
});

test('createAdminClient sends operator/bearer headers, builds query params, and attaches token to private images', async () => {
  assert.equal(normalizeAdminBaseUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.throws(() => normalizeAdminBaseUrl('http://localhost:3000/api'));
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const client = createAdminClient({
    baseUrl: 'http://api.test',
    operatorKey: 'op-secret',
    bearerToken: 'jwt-token',
  }, async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Response.json({ incidents: [], total: 0 });
  });
  await client.list({ type: 'pothole', status: 'open', q: 'cổng B', limit: 20, offset: 0 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /type=pothole/);
  assert.match(calls[0].url, /status=open/);
  assert.match(calls[0].url, /limit=20/);
  assert.equal(calls[0].headers['X-Operator-Key'], 'op-secret');
  assert.equal(calls[0].headers.Authorization, 'Bearer jwt-token');
  assert.equal(
    client.imageDisplayUrl('http://api.test/api/images/b/p/a.png'),
    'http://api.test/api/images/b/p/a.png?token=jwt-token',
  );
});

test('projectHotspots maps GPS coordinates cleanly and statusStepIndex maps lifecycle steps', () => {
  assert.equal(statusStepIndex('open'), 0);
  assert.equal(statusStepIndex('in_progress'), 1);
  assert.equal(statusStepIndex('resolved'), 2);

  const projected = projectHotspots([
    makeIncident({ location: { latitude: 10.77, longitude: 106.70 }, reportCount: 3 }),
    makeIncident({ location: { latitude: 10.78, longitude: 106.71 }, reportCount: 1 }),
    makeIncident({ location: null }),
  ]);
  assert.equal(projected.length, 2);
  for (const point of projected) {
    assert.ok(point.xPercent >= 8 && point.xPercent <= 92);
    assert.ok(point.yPercent >= 10 && point.yPercent <= 90);
  }
  assert.ok(projected[0].radius > projected[1].radius);
});

test('sortVolunteerEventsForReview prioritizes pending_review events and admin client calls volunteer endpoints', async () => {
  const baseEvent = (overrides: Partial<VolunteerEvent>): VolunteerEvent => ({
    id: randomUUID(),
    incidentId: randomUUID(),
    title: 'Buổi dọn rác',
    description: '',
    scheduledAt: '2026-11-26T08:00:00.000Z',
    meetingPoint: 'Cổng A',
    maxParticipants: 10,
    participantCount: 3,
    status: 'recruiting',
    organizerId: randomUUID(),
    organizerName: 'SV A',
    beforeImageUrl: 'http://api.test/uploads/before.png',
    afterImageUrl: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
    ...overrides,
  });
  const verified = baseEvent({ status: 'verified' });
  const recruiting = baseEvent({ status: 'recruiting' });
  const pendingReview = baseEvent({ status: 'pending_review', afterImageUrl: 'http://api.test/uploads/after.png' });
  const sorted = sortVolunteerEventsForReview([verified, recruiting, pendingReview]);
  assert.deepEqual(sorted.map(e => e.id), [pendingReview.id, recruiting.id, verified.id]);
  assert.equal(VOLUNTEER_STATUS_LABELS.pending_review, 'Chờ duyệt ảnh Sau');

  const calls: Array<{ url: string; method: string }> = [];
  const client = createAdminClient({ baseUrl: 'http://api.test', operatorKey: 'op-key' }, async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return Response.json({ events: [], total: 0, stats: { verifiedEvents: 1, totalCertificates: 3 } });
  });
  await client.listVolunteerEvents({ status: 'pending_review', limit: 20 });
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/api\/volunteer-events\?status=pending_review&limit=20$/);
});
