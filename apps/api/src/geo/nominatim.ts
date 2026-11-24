import type { Location, ReverseGeocoder } from '@civicmerge/contracts';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

export interface NominatimGeocoderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export function formatNominatimAddress(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const addr = obj.address && typeof obj.address === 'object' ? (obj.address as Record<string, unknown>) : null;
  if (addr) {
    const parts = [
      addr.house_number && addr.road ? `${addr.house_number} ${addr.road}` : addr.road ?? addr.pedestrian ?? addr.amenity,
      addr.suburb ?? addr.neighbourhood ?? addr.quarter ?? addr.village,
      addr.city_district ?? addr.county ?? addr.district,
      addr.city ?? addr.town ?? addr.state,
    ]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map(part => part.trim());
    const unique = [...new Set(parts)];
    if (unique.length > 0) {
      return unique.join(', ').slice(0, 300);
    }
  }
  if (typeof obj.display_name === 'string' && obj.display_name.trim()) {
    return obj.display_name.trim().slice(0, 300);
  }
  return null;
}

export function createNominatimGeocoder(options: NominatimGeocoderOptions = {}): ReverseGeocoder {
  const fetcher = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_500;
  const userAgent = options.userAgent ?? 'CivicMerge/1.0 (+https://civicmerge.local)';

  return {
    async resolveAddress(location: Location): Promise<string | null> {
      try {
        const url = `${NOMINATIM_URL}?format=jsonv2&lat=${encodeURIComponent(location.latitude.toFixed(6))}&lon=${encodeURIComponent(location.longitude.toFixed(6))}&accept-language=vi`;
        const response = await fetcher(url, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        return formatNominatimAddress(await response.json());
      } catch {
        return null;
      }
    },
  };
}
