import { DomainError, type IncidentStatus, type Location, type Severity } from '@civicmerge/contracts';

const METERS_PER_DEGREE_LAT = 111_000;
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  open: ['in_progress', 'resolved'],
  in_progress: ['open', 'resolved'],
  resolved: [],
};

export function assertStatusTransition(from: IncidentStatus, to: IncidentStatus): void {
  if (from === to) {
    throw new DomainError('INVALID_STATUS_TRANSITION', 'Hồ sơ đã ở trạng thái này.', 409);
  }
  if (!ALLOWED_STATUS_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      'INVALID_STATUS_TRANSITION',
      from === 'resolved'
        ? 'Hồ sơ đã xử lý xong không thể chuyển trạng thái.'
        : 'Chuyển trạng thái hồ sơ không hợp lệ.',
      409,
    );
  }
}

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  wrapsAntimeridian: boolean;
}

export function boundingBoxFor(location: Location, radiusMeters: number): GeoBounds {
  const safeRadius = Math.max(1, radiusMeters) * 1.05;
  const latDelta = safeRadius / METERS_PER_DEGREE_LAT;
  const minLat = Math.max(-90, location.latitude - latDelta);
  const maxLat = Math.min(90, location.latitude + latDelta);

  const cosLat = Math.cos((location.latitude * Math.PI) / 180);
  if (Math.abs(cosLat) < 1e-4) {
    return { minLat, maxLat, minLng: -180, maxLng: 180, wrapsAntimeridian: false };
  }
  const lngDelta = Math.min(180, safeRadius / (METERS_PER_DEGREE_LAT * Math.abs(cosLat)));
  if (lngDelta >= 180) {
    return { minLat, maxLat, minLng: -180, maxLng: 180, wrapsAntimeridian: false };
  }
  let minLng = location.longitude - lngDelta;
  let maxLng = location.longitude + lngDelta;
  let wrapsAntimeridian = false;
  if (minLng < -180) {
    minLng += 360;
    wrapsAntimeridian = true;
  } else if (maxLng > 180) {
    maxLng -= 360;
    wrapsAntimeridian = true;
  }
  return { minLat, maxLat, minLng, maxLng, wrapsAntimeridian };
}

export function isWithinBounds(point: Location, bounds: GeoBounds): boolean {
  if (point.latitude < bounds.minLat || point.latitude > bounds.maxLat) return false;
  if (bounds.wrapsAntimeridian) {
    return point.longitude >= bounds.minLng || point.longitude <= bounds.maxLng;
  }
  return point.longitude >= bounds.minLng && point.longitude <= bounds.maxLng;
}

export function mergeFeatures(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming])].sort();
}

export function escalateSeverity(existing: Severity, incoming: Severity): Severity {
  return SEVERITY_RANK[incoming] > SEVERITY_RANK[existing] ? incoming : existing;
}
