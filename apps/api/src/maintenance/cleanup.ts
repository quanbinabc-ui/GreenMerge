import type { ImageStorage, IncidentRepository } from '@civicmerge/contracts';

export interface CleanupOptions {
  repository: IncidentRepository;
  storage: ImageStorage;
  olderThanHours?: number;
  dryRun?: boolean;
  now?: () => Date;
}

export interface CleanupResult {
  dryRun: boolean;
  cutoffIso: string;
  inspected: number;
  deletedReports: number;
  deletedImages: number;
  failedImageCleanups: number;
  candidateReportIds: string[];
}

export async function cleanupExpiredPendingReports(options: CleanupOptions): Promise<CleanupResult> {
  const olderThanHours = options.olderThanHours ?? 48;
  if (!Number.isFinite(olderThanHours) || olderThanHours <= 0) {
    throw new RangeError('olderThanHours must be finite and positive.');
  }
  const dryRun = options.dryRun ?? true;
  const now = options.now ?? (() => new Date());
  const cutoffIso = new Date(now().getTime() - olderThanHours * 3_600_000).toISOString();

  if (!options.repository.listExpiredPendingReports || !options.repository.deletePendingReport) {
    throw new Error('Repository does not support expired pending report cleanup.');
  }

  const expired = await options.repository.listExpiredPendingReports(cutoffIso);
  const pendingOnly = expired.filter(report => report.status === 'pending' && report.incidentId === null);
  const candidateReportIds = pendingOnly.map(report => report.id);

  if (dryRun) {
    return {
      dryRun: true,
      cutoffIso,
      inspected: pendingOnly.length,
      deletedReports: 0,
      deletedImages: 0,
      failedImageCleanups: 0,
      candidateReportIds,
    };
  }

  let deletedReports = 0;
  let deletedImages = 0;
  let failedImageCleanups = 0;

  for (const report of pendingOnly) {
    const deleted = await options.repository.deletePendingReport(report.id);
    if (!deleted) continue;
    deletedReports += 1;
    try {
      await options.storage.remove(report.imageUrl);
      deletedImages += 1;
    } catch {
      failedImageCleanups += 1;
    }
  }

  return {
    dryRun: false,
    cutoffIso,
    inspected: pendingOnly.length,
    deletedReports,
    deletedImages,
    failedImageCleanups,
    candidateReportIds,
  };
}
