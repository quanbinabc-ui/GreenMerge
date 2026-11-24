import {
  AnalyzeResponseSchema, ApiErrorSchema, AuthSessionResponseSchema, ConfirmResponseSchema, HealthSchema,
  IncidentDetailSchema, IncidentListResponseSchema, MockStateSchema, MyReportsResponseSchema, ReportSchema,
  type BackendCapabilities, type ConfirmRequest, type IncidentListFilter, type Location,
  type LoginRequest, type MockScenario, type SignupRequest,
} from '@civicmerge/contracts';
import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { z } from 'zod';
import { appendImageAuthToken, readAuthToken, saveAuthToken } from './auth-settings';
import { readBackendUrl, saveBackendUrl } from './backend-settings';
import { ApiRequestError } from './http-error';
import { describeProviders } from './provider-state';

export let API_URL = readBackendUrl();
export let AUTH_TOKEN = readAuthToken();
let capabilities: BackendCapabilities | undefined;
export function setApiUrl(value: string) { API_URL = saveBackendUrl(value); capabilities = undefined; }
export function setAuthToken(value: string) { AUTH_TOKEN = saveAuthToken(value); }
export function imageSourceUrl(rawUrl: string) { return appendImageAuthToken(rawUrl, AUTH_TOKEN); }
export const MOCK_MODE = process.env.EXPO_PUBLIC_MOCK_MODE === 'true';
// A persistent backend may still use mock AI without exposing reset/scenario APIs.
export const MOCK_CONTROLS = process.env.EXPO_PUBLIC_MOCK_CONTROLS === undefined
  ? MOCK_MODE : process.env.EXPO_PUBLIC_MOCK_CONTROLS === 'true';
export const providerState = () => describeProviders(capabilities, MOCK_CONTROLS);
export interface UploadImage { uri: string; name: string; type: string }

const OkSchema = z.object({ ok: z.literal(true) });

async function request<T>(route: string, schema: { parse(value: unknown): T }, init: RequestInit = {}): Promise<T> {
  if (!/^https?:\/\//.test(API_URL)) throw new Error('Hãy nhập và lưu địa chỉ máy chủ trên Trang chủ.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const headers: Record<string, string> = {
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const response = await fetch(API_URL + route, { ...init, headers, signal: controller.signal });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new ApiRequestError('Máy chủ trả phản hồi không hợp lệ. Kết quả thao tác chưa xác định.', 'INVALID_RESPONSE', response.status); }
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(body);
      throw new ApiRequestError(parsed.success ? parsed.data.error.message : `API trả lỗi HTTP ${response.status}.`,
        parsed.success ? parsed.data.error.code : 'HTTP_ERROR', response.status);
    }
    return schema.parse(body);
  } catch (error) {
    if (controller.signal.aborted) throw new ApiRequestError('Yêu cầu quá thời gian chờ. Khi xác nhận, hãy thử lại cùng lựa chọn.', 'REQUEST_TIMEOUT');
    if (error instanceof TypeError) throw new ApiRequestError('Không kết nối được API. Kiểm tra địa chỉ LAN và Wi-Fi.', 'NETWORK_ERROR');
    throw error;
  } finally { clearTimeout(timeout); }
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function listQuery(filter?: IncidentListFilter & { mine?: boolean }): string {
  if (!filter) return '';
  const params = new URLSearchParams();
  if (filter.type) params.set('type', filter.type);
  if (filter.status) params.set('status', filter.status);
  if (filter.severity) params.set('severity', filter.severity);
  if (filter.q) params.set('q', filter.q);
  if (filter.mine) params.set('mine', 'true');
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  if (filter.offset !== undefined) params.set('offset', String(filter.offset));
  const query = params.toString();
  return query ? `?${query}` : '';
}
export const api = {
  health: async () => {
    capabilities = undefined;
    const health = await request('/health', HealthSchema);
    capabilities = health.capabilities;
    return health;
  },
  login: (body: LoginRequest) => request('/api/auth/login', AuthSessionResponseSchema, json(body)),
  signup: (body: SignupRequest) => request('/api/auth/signup', AuthSessionResponseSchema, json(body)),
  list: (filter?: IncidentListFilter & { mine?: boolean }) => request(`/api/incidents${listQuery(filter)}`, IncidentListResponseSchema),
  myReports: () => request('/api/me/reports', MyReportsResponseSchema),
  detail: (id: string) => request(`/api/incidents/${encodeURIComponent(id)}`, IncidentDetailSchema),
  report: (id: string) => request(`/api/reports/${encodeURIComponent(id)}`, ReportSchema),
  confirm: (body: ConfirmRequest) => request('/api/reports/confirm', ConfirmResponseSchema, json(body)),
  registerPushToken: (token: string, platform: 'ios' | 'android' | 'web') =>
    request('/api/push-tokens', OkSchema, json({ token, platform })),
  async analyze(image: UploadImage, location: Location | null, idempotencyKey?: string) {
    const form = new FormData();
    // Expo's fetch requires Blob/File bytes, not React Native's legacy URI object.
    form.append('image', new File(image.uri));
    if (location) { form.append('latitude', String(location.latitude)); form.append('longitude', String(location.longitude)); }
    return request('/api/reports/analyze', AnalyzeResponseSchema, {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: form,
    });
  },
  scenario: (scenario: MockScenario) => request('/api/mock/scenario', MockStateSchema, json({ scenario })),
  reset: () => request('/api/mock/reset', MockStateSchema, { method: 'POST' }),
};

export async function tryRegisterPushToken(token: string | null | undefined, platform: 'ios' | 'android' | 'web'): Promise<boolean> {
  if (!AUTH_TOKEN || !token?.trim()) return false;
  try {
    await api.registerPushToken(token.trim(), platform);
    return true;
  } catch {
    return false;
  }
}
