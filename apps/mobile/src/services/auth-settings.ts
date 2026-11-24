import { File, Paths } from 'expo-file-system';
import { normalizeAuthToken } from './auth-token-format';
export { appendImageAuthToken, normalizeAuthToken } from './auth-token-format';

const tokenFile = () => new File(Paths.document, 'civicmerge-auth-token.txt');

export function readAuthToken(): string {
  try {
    const file = tokenFile();
    if (file.exists) return normalizeAuthToken(file.textSync());
  } catch {
    // Ignore unreadable auth file.
  }
  return '';
}

export function saveAuthToken(raw: string): string {
  const clean = normalizeAuthToken(raw);
  const file = tokenFile();
  if (!clean) {
    if (file.exists) file.delete();
    return '';
  }
  if (!file.exists) file.create();
  file.writeSync(clean);
  return clean;
}
