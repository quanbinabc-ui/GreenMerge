import type { IncidentDetail, IncidentStatus, IncidentSummary, IncidentType, Severity } from '@civicmerge/contracts';

const SEVERITY_PRIORITY: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export const TYPE_LABELS: Record<IncidentType, string> = {
  pothole: 'Ổ gà',
  trash: 'Rác thải',
  flood: 'Ngập nước',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  high: 'Cao',
  medium: 'Trung bình',
  low: 'Thấp',
};

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: 'Mới tiếp nhận',
  in_progress: 'Đang xử lý',
  resolved: 'Đã xử lý',
};

export interface AdminKpis {
  totalIncidents: number;
  openCount: number;
  inProgressCount: number;
  resolvedCount: number;
  totalReports: number;
  mergedReports: number;
  duplicateReductionRate: number;
}

export function computeKpis(incidents: readonly IncidentSummary[]): AdminKpis {
  let openCount = 0;
  let inProgressCount = 0;
  let resolvedCount = 0;
  let totalReports = 0;
  for (const item of incidents) {
    if (item.status === 'open') openCount += 1;
    else if (item.status === 'in_progress') inProgressCount += 1;
    else if (item.status === 'resolved') resolvedCount += 1;
    totalReports += item.reportCount;
  }
  const mergedReports = Math.max(0, totalReports - incidents.length);
  const duplicateReductionRate = totalReports > 0 ? Number(((mergedReports / totalReports) * 100).toFixed(1)) : 0;
  return {
    totalIncidents: incidents.length,
    openCount,
    inProgressCount,
    resolvedCount,
    totalReports,
    mergedReports,
    duplicateReductionRate,
  };
}

export function sortQueueByPriority(incidents: readonly IncidentSummary[]): IncidentSummary[] {
  return [...incidents].sort((a, b) => {
    const statusWeight = (status: IncidentStatus) => (status === 'resolved' ? 0 : 1);
    return (
      statusWeight(b.status) - statusWeight(a.status)
      || SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity]
      || b.reportCount - a.reportCount
      || b.updatedAt.localeCompare(a.updatedAt)
    );
  });
}

export function allowedNextStatuses(current: IncidentStatus): IncidentStatus[] {
  if (current === 'open') return ['in_progress', 'resolved'];
  if (current === 'in_progress') return ['resolved', 'open'];
  return [];
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('vi-VN');
}

export function googleMapsUrl(location: IncidentDetail['location']): string | null {
  if (!location) return null;
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function statusStepIndex(status: IncidentStatus): 0 | 1 | 2 {
  if (status === 'resolved') return 2;
  if (status === 'in_progress') return 1;
  return 0;
}

export interface ProjectedHotspot {
  incident: IncidentSummary;
  xPercent: number;
  yPercent: number;
  radius: number;
}

export function projectHotspots(incidents: readonly IncidentSummary[]): ProjectedHotspot[] {
  const located = incidents.filter((item): item is IncidentSummary & { location: NonNullable<IncidentSummary['location']> } =>
    item.location !== null);
  if (located.length === 0) return [];
  const lats = located.map(item => item.location.latitude);
  const lngs = located.map(item => item.location.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = Math.max(0.002, (maxLat - minLat) * 1.35);
  const lngSpan = Math.max(0.002, (maxLng - minLng) * 1.35);
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;

  return located.map((incident) => {
    const xPercent = Math.max(8, Math.min(92, 50 + ((incident.location.longitude - centerLng) / lngSpan) * 76));
    const yPercent = Math.max(10, Math.min(90, 50 - ((incident.location.latitude - centerLat) / latSpan) * 76));
    const radius = Math.min(20, 9 + incident.reportCount * 3);
    return { incident, xPercent: Number(xPercent.toFixed(2)), yPercent: Number(yPercent.toFixed(2)), radius };
  });
}
