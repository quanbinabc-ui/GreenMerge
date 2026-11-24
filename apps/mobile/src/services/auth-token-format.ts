export function normalizeAuthToken(raw: string): string {
  const trimmed = raw.trim().replace(/^Bearer\s+/i, '').trim();
  if (!trimmed) return '';
  if (/\s/.test(trimmed) || trimmed.length > 4096) {
    throw new Error('Token xác thực không hợp lệ (không chứa khoảng trắng).');
  }
  return trimmed;
}

export function appendImageAuthToken(rawUrl: string, token: string): string {
  const clean = token.trim();
  if (!clean) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname.startsWith('/api/images/')) {
      parsed.searchParams.set('token', clean);
      return parsed.toString();
    }
  } catch {
    // Keep non-HTTP/local file URIs untouched.
  }
  return rawUrl;
}
