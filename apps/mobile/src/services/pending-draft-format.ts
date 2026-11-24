import { AnalyzeResponseSchema, type Location } from '@civicmerge/contracts';
import { z } from 'zod';

export const PendingDraftSchema = z.object({
  apiUrl: z.string().url(),
  result: AnalyzeResponseSchema,
  capturedImageUri: z.string().nullable(),
  savedAt: z.string().datetime(),
});

export type PendingDraft = z.infer<typeof PendingDraftSchema>;

export function serializePendingDraft(draft: PendingDraft): string {
  return JSON.stringify(PendingDraftSchema.parse(draft));
}

export function parsePendingDraft(raw: string, expectedApiUrl: string): PendingDraft | null {
  try {
    const parsed = PendingDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (parsed.data.apiUrl !== expectedApiUrl) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function mapUrlForLocation(location: Location, platform: 'ios' | 'android' | 'web' | string): string {
  const lat = location.latitude.toFixed(6);
  const lng = location.longitude.toFixed(6);
  if (platform === 'ios') {
    return `https://maps.apple.com/?ll=${lat},${lng}&q=${lat},${lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
