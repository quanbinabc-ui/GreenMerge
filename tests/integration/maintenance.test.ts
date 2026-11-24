import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanupExpiredPendingReports } from '../../apps/api/src/maintenance/cleanup.js';
import { createMemoryRepository } from '../../apps/api/src/repositories/memory.js';
import { createLocalStorage } from '../../apps/api/src/storage/local.js';

const png = await readFile(new URL('../../mocks/images/pothole-1.png', import.meta.url));
const analysis = { type: 'pothole' as const, severity: 'medium' as const, description: 'Cleanup fixture.', features: [] };

test('cleanupExpiredPendingReports dry-run inspects safely and apply removes only expired pending reports/images', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'civicmerge-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = createMemoryRepository();
  const storage = createLocalStorage(dir, 'http://images.test');

  const oldImg = await storage.save({ bytes: png, mimeType: 'image/png' });
  const confirmedImg = await storage.save({ bytes: png, mimeType: 'image/png' });
  const expiredPending = await repository.createPending({ analysis, location: null, imageUrl: oldImg });
  const confirmedReport = await repository.createPending({ analysis, location: null, imageUrl: confirmedImg });
  await repository.confirm({ reportId: confirmedReport.id, action: 'create' }, 'Tổ đường bộ');

  // Simulate 72 hours later so both created timestamps are older than 48h, but only pending is eligible.
  const futureNow = () => new Date(Date.now() + 72 * 3_600_000);

  const dry = await cleanupExpiredPendingReports({
    repository,
    storage,
    olderThanHours: 48,
    dryRun: true,
    now: futureNow,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.inspected, 1);
  assert.deepEqual(dry.candidateReportIds, [expiredPending.id]);
  assert.equal(dry.deletedReports, 0);
  assert.equal((await readdir(dir)).length, 2);

  const applied = await cleanupExpiredPendingReports({
    repository,
    storage,
    olderThanHours: 48,
    dryRun: false,
    now: futureNow,
  });
  assert.equal(applied.dryRun, false);
  assert.equal(applied.deletedReports, 1);
  assert.equal(applied.deletedImages, 1);
  assert.equal(applied.failedImageCleanups, 0);
  assert.equal(await repository.findReport(expiredPending.id), null);
  assert.ok(await repository.findReport(confirmedReport.id));
  assert.equal((await readdir(dir)).length, 1);
});
