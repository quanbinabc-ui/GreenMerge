import {
  AuthSessionResponseSchema,
  DomainError,
  UserRoleSchema,
  type AuthClient,
  type AuthSessionResponse,
  type LoginRequest,
  type SignupRequest,
} from '@civicmerge/contracts';

export interface SupabaseAuthClientOptions {
  url: string;
  publishableKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function parseSupabaseAuthResponse(payload: unknown): AuthSessionResponse {
  if (!payload || typeof payload !== 'object') {
    throw new DomainError('AUTH_UNAVAILABLE', 'Phản hồi xác thực không hợp lệ.', 502);
  }
  const data = payload as Record<string, unknown>;
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  const userObj = data.user && typeof data.user === 'object' ? (data.user as Record<string, unknown>) : null;
  if (!accessToken || !userObj || typeof userObj.id !== 'string') {
    throw new DomainError('SIGNUP_CONFIRMATION_REQUIRED', 'Tài khoản đã được tạo. Vui lòng kiểm tra email để xác nhận trước khi đăng nhập.', 202);
  }
  const appMeta = userObj.app_metadata && typeof userObj.app_metadata === 'object'
    ? (userObj.app_metadata as Record<string, unknown>) : undefined;
  const userMeta = userObj.user_metadata && typeof userObj.user_metadata === 'object'
    ? (userObj.user_metadata as Record<string, unknown>) : undefined;
  const rawRole = appMeta?.role ?? userObj.role ?? 'citizen';
  const normalizedRole = rawRole === 'authenticated' ? 'citizen' : rawRole;
  const parsedRole = UserRoleSchema.safeParse(normalizedRole);
  const displayName = typeof userMeta?.display_name === 'string' && userMeta.display_name.trim()
    ? userMeta.display_name.trim()
    : typeof userObj.email === 'string'
      ? userObj.email.split('@')[0]
      : undefined;
  const expiresAt = typeof data.expires_at === 'number' && Number.isFinite(data.expires_at)
    ? new Date(data.expires_at * 1000).toISOString()
    : typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined;
  return AuthSessionResponseSchema.parse({
    accessToken,
    ...(typeof data.refresh_token === 'string' && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    user: {
      id: userObj.id,
      role: parsedRole.success ? parsedRole.data : 'citizen',
      ...(displayName ? { displayName } : {}),
    },
  });
}

export function createSupabaseAuthClient(options: SupabaseAuthClientOptions): AuthClient {
  let baseUrl: URL;
  try {
    baseUrl = new URL(options.url);
  } catch {
    throw new Error('Invalid SUPABASE_URL for auth client.');
  }
  const apiKey = options.publishableKey.trim();
  if (!apiKey) throw new Error('SUPABASE_PUBLISHABLE_KEY is required for auth client.');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetcher = options.fetchImpl ?? fetch;

  async function call(path: string, body: Record<string, unknown>, failCode: string, failMessage: string) {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl.origin}/auth/v1${path}`, {
        method: 'POST',
        headers: {
          apikey: apiKey,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(body),
      });
    } catch {
      throw new DomainError('AUTH_UNAVAILABLE', 'Không thể kết nối dịch vụ đăng nhập. Hãy thử lại.', 503);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DomainError('AUTH_UNAVAILABLE', 'Dịch vụ đăng nhập trả về dữ liệu không đọc được.', 502);
    }

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        throw new DomainError(failCode, failMessage, response.status === 401 ? 401 : 400);
      }
      if (response.status === 422) {
        throw new DomainError(failCode, failMessage, 422);
      }
      throw new DomainError('AUTH_UNAVAILABLE', 'Dịch vụ đăng nhập đang tạm thời không khả dụng.', 503);
    }
    return parseSupabaseAuthResponse(payload);
  }

  return {
    signIn(input: LoginRequest) {
      return call(
        '/token?grant_type=password',
        { email: input.email, password: input.password },
        'INVALID_CREDENTIALS',
        'Email hoặc mật khẩu không đúng.',
      );
    },
    signUp(input: SignupRequest) {
      return call(
        '/signup',
        {
          email: input.email,
          password: input.password,
          ...(input.displayName ? { data: { display_name: input.displayName } } : {}),
        },
        'SIGNUP_FAILED',
        'Không thể đăng ký tài khoản (email có thể đã tồn tại hoặc mật khẩu chưa đủ mạnh).',
      );
    },
  };
}
