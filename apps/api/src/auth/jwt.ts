import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthUserSchema, DomainError, UserRoleSchema, type AuthUser, type AuthVerifier } from '@civicmerge/contracts';

export interface Hs256JwtOptions {
  secret: string;
  issuer?: string;
  audience?: string;
  now?: () => number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new DomainError('UNAUTHORIZED', 'Token xác thực không hợp lệ.', 401);
  }
  return Buffer.from(input, 'base64url');
}

export function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function createHs256JwtVerifier(options: Hs256JwtOptions): AuthVerifier {
  const secret = options.secret;
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_JWT_SECRET must be at least 16 characters.');
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    async verifyToken(token: string): Promise<AuthUser> {
      const parts = token.trim().split('.');
      if (parts.length !== 3) {
        throw new DomainError('UNAUTHORIZED', 'Token xác thực không hợp lệ.', 401);
      }
      const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];
      let header: Record<string, unknown>;
      let payload: Record<string, unknown>;
      let providedSig: Buffer;
      try {
        header = JSON.parse(base64UrlDecode(rawHeader).toString('utf8')) as Record<string, unknown>;
        payload = JSON.parse(base64UrlDecode(rawPayload).toString('utf8')) as Record<string, unknown>;
        providedSig = base64UrlDecode(rawSig);
      } catch {
        throw new DomainError('UNAUTHORIZED', 'Token xác thực không đọc được.', 401);
      }

      if (header.alg !== 'HS256') {
        throw new DomainError('UNAUTHORIZED', 'Thuật toán token không được hỗ trợ.', 401);
      }

      const expectedSig = createHmac('sha256', secret).update(`${rawHeader}.${rawPayload}`).digest();
      if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
        throw new DomainError('UNAUTHORIZED', 'Chữ ký token không hợp lệ.', 401);
      }

      const currentSeconds = now();
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= currentSeconds) {
        throw new DomainError('UNAUTHORIZED', 'Phiên đăng nhập đã hết hạn.', 401);
      }
      if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > currentSeconds)) {
        throw new DomainError('UNAUTHORIZED', 'Token chưa có hiệu lực.', 401);
      }
      if (options.issuer && payload.iss !== options.issuer) {
        throw new DomainError('UNAUTHORIZED', 'Nguồn phát hành token không hợp lệ.', 401);
      }
      if (options.audience) {
        const aud = payload.aud;
        const matched = aud === options.audience || (Array.isArray(aud) && aud.includes(options.audience));
        if (!matched) throw new DomainError('UNAUTHORIZED', 'Đối tượng token không hợp lệ.', 401);
      }

      const appMeta = payload.app_metadata && typeof payload.app_metadata === 'object'
        ? (payload.app_metadata as Record<string, unknown>) : undefined;
      const userMeta = payload.user_metadata && typeof payload.user_metadata === 'object'
        ? (payload.user_metadata as Record<string, unknown>) : undefined;
      const rawRole = appMeta?.role ?? payload.civicmerge_role ?? payload.role ?? 'citizen';
      // Supabase sets standard claim role="authenticated" for normal users; map that safely to citizen.
      const normalizedRole = rawRole === 'authenticated' ? 'citizen' : rawRole;
      const parsedRole = UserRoleSchema.safeParse(normalizedRole);
      if (!parsedRole.success) {
        throw new DomainError('UNAUTHORIZED', 'Vai trò người dùng trong token không hợp lệ.', 401);
      }

      const displayName = typeof userMeta?.display_name === 'string' && userMeta.display_name.trim()
        ? userMeta.display_name.trim()
        : typeof payload.name === 'string' && payload.name.trim()
          ? payload.name.trim()
          : undefined;

      const user = AuthUserSchema.safeParse({
        id: payload.sub,
        role: parsedRole.data,
        ...(displayName ? { displayName } : {}),
      });
      if (!user.success) {
        throw new DomainError('UNAUTHORIZED', 'Định danh người dùng trong token không hợp lệ.', 401);
      }
      return user.data;
    },
  };
}
