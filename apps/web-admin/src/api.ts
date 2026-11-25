import type {
  AuthSessionResponse,
  IncidentDetail,
  IncidentListFilter,
  IncidentSummary,
  LoginRequest,
  ReassignTeamRequest,
  ReviewVolunteerEventRequest,
  ReviewVolunteerEventResponse,
  UpdateIncidentStatusRequest,
  VolunteerEventDetail,
  VolunteerEventListFilter,
  VolunteerEventListResponse,
} from '@civicmerge/contracts';

export interface AdminConnection {
  baseUrl: string;
  operatorKey?: string;
  bearerToken?: string;
  userLabel?: string;
}

export interface AdminListResult {
  incidents: IncidentSummary[];
  total?: number;
}

export interface AdminHealthResult {
  status: 'ok';
  mode: 'mock' | 'real';
  capabilities?: {
    persistence: string;
    storage: string;
    vision: string;
    matching: string;
  };
}

export function normalizeAdminBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Nhập URL API đầy đủ, ví dụ http://localhost:3000.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('URL API chỉ gồm origin HTTP/HTTPS, không kèm đường dẫn hoặc tham số.');
  }
  return url.origin;
}

export function createAdminClient(connection: AdminConnection, fetchImpl: typeof fetch = fetch) {
  const origin = normalizeAdminBaseUrl(connection.baseUrl);
  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (connection.bearerToken?.trim()) headers.Authorization = `Bearer ${connection.bearerToken.trim()}`;
    if (connection.operatorKey?.trim()) headers['X-Operator-Key'] = connection.operatorKey.trim();
    return headers;
  };

  async function request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(origin + route, {
      ...init,
      headers: {
        ...authHeaders(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(`Máy chủ trả phản hồi không hợp lệ (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const errorObj = payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error?: { message?: string; code?: string } }).error
        : undefined;
      throw new Error(errorObj?.message || `Yêu cầu thất bại (HTTP ${response.status}).`);
    }
    return payload as T;
  }

  return {
    origin,
    health: () => request<AdminHealthResult>('/health'),
    ready: () => request<{ status: string; checks: { database: string; storage: string } }>('/health/ready'),
    login: (body: LoginRequest) =>
      request<AuthSessionResponse>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    list(filter: IncidentListFilter = {}) {
      const params = new URLSearchParams();
      if (filter.type) params.set('type', filter.type);
      if (filter.status) params.set('status', filter.status);
      if (filter.severity) params.set('severity', filter.severity);
      if (filter.q) params.set('q', filter.q);
      if (filter.limit !== undefined) params.set('limit', String(filter.limit));
      if (filter.offset !== undefined) params.set('offset', String(filter.offset));
      const query = params.toString();
      return request<AdminListResult>(`/api/incidents${query ? `?${query}` : ''}`);
    },
    detail: (id: string) => request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}`),
    updateStatus: (id: string, body: UpdateIncidentStatusRequest) =>
      request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    reassignTeam: (id: string, body: ReassignTeamRequest) =>
      request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}/team`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    uploadResolutionImage(id: string, file: Blob, filename = 'resolution.jpg') {
      const form = new FormData();
      form.append('image', file, filename);
      return request<IncidentDetail>(`/api/incidents/${encodeURIComponent(id)}/resolution-image`, {
        method: 'POST',
        body: form,
      });
    },
    listVolunteerEvents(filter: VolunteerEventListFilter = {}) {
      const params = new URLSearchParams();
      if (filter.status) params.set('status', filter.status);
      if (filter.incidentId) params.set('incidentId', filter.incidentId);
      if (filter.limit !== undefined) params.set('limit', String(filter.limit));
      if (filter.offset !== undefined) params.set('offset', String(filter.offset));
      const query = params.toString();
      return request<VolunteerEventListResponse>(`/api/volunteer-events${query ? `?${query}` : ''}`);
    },
    volunteerEventDetail: (id: string) =>
      request<VolunteerEventDetail>(`/api/volunteer-events/${encodeURIComponent(id)}`),
    reviewVolunteerEvent: (id: string, body: ReviewVolunteerEventRequest) =>
      request<ReviewVolunteerEventResponse>(`/api/volunteer-events/${encodeURIComponent(id)}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    imageDisplayUrl(rawUrl: string): string {
      if (!connection.bearerToken?.trim()) return rawUrl;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.pathname.startsWith('/api/images/')) {
          parsed.searchParams.set('token', connection.bearerToken.trim());
          return parsed.toString();
        }
      } catch {
        // Keep raw URL if not parseable.
      }
      return rawUrl;
    },
  };
}
