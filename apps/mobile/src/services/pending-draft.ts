import { File, Paths } from 'expo-file-system';
import type { AnalyzeResponse } from '@civicmerge/contracts';
import {
  parsePendingDraft,
  serializePendingDraft,
  type PendingDraft,
} from './pending-draft-format';

export type { PendingDraft } from './pending-draft-format';

const draftFile = () => new File(Paths.document, 'civicmerge-pending-draft.json');

export function readPendingDraft(expectedApiUrl: string): PendingDraft | null {
  if (!expectedApiUrl) return null;
  try {
    const file = draftFile();
    if (!file.exists) return null;
    return parsePendingDraft(file.textSync(), expectedApiUrl);
  } catch {
    return null;
  }
}

export function savePendingDraft(apiUrl: string, result: AnalyzeResponse, capturedImageUri: string | null): void {
  if (!apiUrl) return;
  try {
    const file = draftFile();
    if (!file.exists) file.create();
    file.writeSync(
      serializePendingDraft({
        apiUrl,
        result,
        capturedImageUri,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Draft persistence is best-effort and must never block the main reporting flow.
  }
}

export function clearPendingDraft(): void {
  try {
    const file = draftFile();
    if (file.exists) file.delete();
  } catch {
    // Ignore cleanup errors on local draft file.
  }
}
