import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import {
  AIAnalysisSchema, AnalyzeResponseSchema, AuthSessionResponseSchema, ConfirmRequestSchema, ConfirmResponseSchema,
  CreateVolunteerEventRequestSchema, DomainError, IncidentDetailSchema, IncidentListFilterSchema,
  IncidentListResponseSchema, JoinVolunteerEventRequestSchema, LocationSchema, LoginRequestSchema,
  MockStateSchema, MyCertificatesResponseSchema, MyReportsResponseSchema, PublicVolunteerCertificateSchema,
  ReassignTeamRequestSchema, RegisterPushTokenRequestSchema, ReportSchema, ReviewVolunteerEventRequestSchema,
  ReviewVolunteerEventResponseSchema, SignupRequestSchema, UpdateIncidentStatusRequestSchema,
  VolunteerEventDetailSchema, VolunteerEventListFilterSchema, VolunteerEventListResponseSchema,
  type AnalyzeResponse, type AuthClient, type AuthUser, type AuthVerifier, type BackendCapabilities,
  type DuplicateMatcher, type ImageStorage, type IncidentListFilter, type IncidentRepository,
  type IncidentRouter, type IncidentStatus, type IncidentType, type Location, type MockScenario,
  type PushNotifier, type ReverseGeocoder, type VisionAnalyzer, type VolunteerEvent,
  type VolunteerEventDetail, type VolunteerEventListFilter,
} from '@civicmerge/contracts';
import { MAX_IMAGE_BYTES, validateImageInput } from './storage/image.js';
import { publicImageUrl } from './storage/reference.js';
import type { ImageDelivery } from './storage/delivery.js';
import { PendingReportWriteRejected } from './repositories/errors.js';

export interface RequestLogEntry {
  ts: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
}
export interface ReadinessChecks {
  database: 'ok' | 'skipped';
  storage: 'ok' | 'skipped';
}
export interface AppDependencies {
  repository: IncidentRepository; storage: ImageStorage; vision: VisionAnalyzer;
  matcher: DuplicateMatcher; router: IncidentRouter;
  uploadDir: string; mockMode: boolean;
  publicBaseUrl?: string;
  imageDelivery?: ImageDelivery;
  capabilities?: BackendCapabilities;
  matchingRadiusMeters?: number;
  operatorApiKey?: string;
  authVerifier?: AuthVerifier;
  authClient?: AuthClient;
  pushNotifier?: PushNotifier;
  geocoder?: ReverseGeocoder;
  corsAllowedOrigins?: readonly string[];
  analyzeRateLimit?: { maxRequests: number; windowMs: number } | false;
  checkReady?: () => Promise<ReadinessChecks>;
  onRequestLog?: (entry: RequestLogEntry) => void;
  mockControl?: { getScenario(): MockScenario; setScenario(scenario: MockScenario): void };
}
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
function createRateLimiter(config: { maxRequests: number; windowMs: number }) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (key: string): { allowed: boolean; retryAfterSeconds: number } => {
    const now = Date.now();
    if (buckets.size > 2000) {
      for (const [k, v] of buckets) { if (v.resetAt <= now) buckets.delete(k); }
    }
    const entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + config.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (entry.count >= config.maxRequests) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}
function extractBearerToken(req: express.Request, allowQueryToken = false): string | null {
  const header = req.header('Authorization');
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) throw new DomainError('UNAUTHORIZED', 'Header Authorization không hợp lệ.', 401);
    return match[1];
  }
  if (allowQueryToken && typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return null;
}
async function resolveOptionalUser(req: express.Request, verifier: AuthVerifier | undefined, allowQueryToken = false): Promise<AuthUser | null> {
  if (!verifier) return null;
  const token = extractBearerToken(req, allowQueryToken);
  if (!token) return null;
  return verifier.verifyToken(token);
}
async function requireAuthenticatedUser(req: express.Request, verifier: AuthVerifier | undefined, allowQueryToken = false): Promise<AuthUser | null> {
  if (!verifier) return null;
  const token = extractBearerToken(req, allowQueryToken);
  if (!token) throw new DomainError('UNAUTHORIZED', 'Yêu cầu đăng nhập (thiếu Bearer token).', 401);
  return verifier.verifyToken(token);
}
function hasValidOperatorKey(req: express.Request, operatorApiKey: string | undefined): boolean {
  if (!operatorApiKey) return false;
  const provided = req.header('X-Operator-Key');
  if (!provided) return false;
  const expectedBuf = Buffer.from(operatorApiKey, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}
async function requireOperatorAccess(
  req: express.Request,
  deps: Pick<AppDependencies, 'operatorApiKey' | 'authVerifier' | 'mockMode'>,
): Promise<AuthUser | null> {
  if (hasValidOperatorKey(req, deps.operatorApiKey)) return null;
  if (deps.authVerifier) {
    const token = extractBearerToken(req);
    if (token) {
      const user = await deps.authVerifier.verifyToken(token);
      if (user.role === 'operator' || user.role === 'admin') return user;
      throw new DomainError('FORBIDDEN', 'Chỉ tài khoản đơn vị xử lý (operator/admin) mới có quyền thực hiện thao tác này.', 403);
    }
    if (!deps.operatorApiKey) {
      throw new DomainError('UNAUTHORIZED', 'Yêu cầu xác thực tài khoản đơn vị xử lý.', 401);
    }
  }
  if (deps.operatorApiKey) {
    const provided = req.header('X-Operator-Key');
    if (!provided) throw new DomainError('UNAUTHORIZED', 'Thiếu header X-Operator-Key để cập nhật trạng thái hồ sơ.', 401);
    throw new DomainError('FORBIDDEN', 'Khóa xác thực đơn vị xử lý không hợp lệ.', 403);
  }
  if (!deps.mockMode) {
    throw new DomainError('OPERATOR_KEY_REQUIRED', 'Chức năng cập nhật trạng thái yêu cầu cấu hình AUTH_MODE=jwt hoặc OPERATOR_API_KEY trên máy chủ.', 403);
  }
  return null;
}
function assertReportOwnership(report: { reporterId?: string | null }, user: AuthUser | null): void {
  if (!user) return;
  if (user.role === 'operator' || user.role === 'admin') return;
  if (report.reporterId && report.reporterId !== user.id) {
    throw new DomainError('FORBIDDEN', 'Bạn không có quyền truy cập hoặc xác nhận báo cáo của người dùng khác.', 403);
  }
}
const DEMO_VOLUNTEER_USER_ID = '00000000-0000-4000-8000-000000000101';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function resolveVolunteerActor(
  req: express.Request,
  deps: Pick<AppDependencies, 'authVerifier' | 'mockMode'>,
): Promise<{ id: string; displayName: string }> {
  const user = await requireAuthenticatedUser(req, deps.authVerifier);
  if (user) {
    return {
      id: user.id,
      displayName: user.displayName?.trim() || 'Tình nguyện viên',
    };
  }
  const demoHeader = req.header('X-Demo-User-Id')?.trim();
  const userId = demoHeader && UUID_PATTERN.test(demoHeader) ? demoHeader.toLowerCase() : DEMO_VOLUNTEER_USER_ID;
  const demoName = req.header('X-Demo-User-Name')?.trim();
  return {
    id: userId,
    displayName: demoName && demoName.length <= 120 ? demoName : 'Sinh viên Tình nguyện (Demo)',
  };
}
function parseVolunteerListFilter(query: Record<string, unknown>): VolunteerEventListFilter {
  const allowed = new Set(['status', 'incidentId', 'limit', 'offset']);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new DomainError('VALIDATION_ERROR', 'Tham số lọc buổi tình nguyện không được hỗ trợ.', 400);
  }
  const readString = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  const parseIntParam = (value: unknown, name: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
      throw new DomainError('VALIDATION_ERROR', `Tham số ${name} phải là số nguyên không âm.`, 400);
    }
    return Number(value.trim());
  };
  const candidate = {
    ...(readString(query.status) !== undefined ? { status: readString(query.status) } : {}),
    ...(readString(query.incidentId) !== undefined ? { incidentId: readString(query.incidentId) } : {}),
    ...(query.limit !== undefined ? { limit: parseIntParam(query.limit, 'limit') } : {}),
    ...(query.offset !== undefined ? { offset: parseIntParam(query.offset, 'offset') } : {}),
  };
  const parsed = VolunteerEventListFilterSchema.safeParse(candidate);
  if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Tham số lọc buổi tình nguyện không hợp lệ.', 400);
  return parsed.data;
}
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 500;
function validateImage(file: Express.Multer.File | undefined) {
  if (!file) throw new DomainError('VALIDATION_ERROR', 'Cần gửi ảnh trong field image.', 400);
  return validateImageInput({ bytes: file.buffer, mimeType: file.mimetype });
}
function parseIdempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    throw new DomainError('VALIDATION_ERROR', 'Header Idempotency-Key không hợp lệ.', 400);
  }
  return trimmed;
}
function parseListFilter(query: Record<string, unknown>): { filter: IncidentListFilter; hasQuery: boolean; mine: boolean } {
  const allowed = new Set(['type', 'status', 'severity', 'q', 'mine', 'limit', 'offset']);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw new DomainError('VALIDATION_ERROR', 'Tham số lọc không được hỗ trợ.', 400);
  }
  const hasQuery = Object.keys(query).length > 0;
  const readString = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  const parseIntParam = (value: unknown, name: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
      throw new DomainError('VALIDATION_ERROR', `Tham số ${name} phải là số nguyên không âm.`, 400);
    }
    return Number(value.trim());
  };
  const mineRaw = readString(query.mine);
  if (mineRaw !== undefined && mineRaw !== 'true' && mineRaw !== 'false') {
    throw new DomainError('VALIDATION_ERROR', 'Tham số mine phải là true hoặc false.', 400);
  }
  const candidate = {
    ...(readString(query.type) !== undefined ? { type: readString(query.type) } : {}),
    ...(readString(query.status) !== undefined ? { status: readString(query.status) } : {}),
    ...(readString(query.severity) !== undefined ? { severity: readString(query.severity) } : {}),
    ...(readString(query.q) !== undefined ? { q: readString(query.q) } : {}),
    ...(query.limit !== undefined ? { limit: parseIntParam(query.limit, 'limit') } : {}),
    ...(query.offset !== undefined ? { offset: parseIntParam(query.offset, 'offset') } : {}),
  };
  const parsed = IncidentListFilterSchema.safeParse(candidate);
  if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Tham số lọc danh sách không hợp lệ.', 400);
  return { filter: parsed.data, hasQuery, mine: mineRaw === 'true' };
}

async function dependency<T>(code: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(code, 'Dịch vụ tạm thời không khả dụng. Hãy thử lại.', 503);
  }
}

export function createApp(deps: AppDependencies) {
  const app = express();
  let generation = 0;
  const analyzeCache = new Map<string, { generation: number; fingerprint: string; createdAt: number; promise: Promise<AnalyzeResponse> }>();
  const pruneAnalyzeCache = () => {
    const now = Date.now();
    for (const [key, entry] of analyzeCache) {
      if (entry.generation !== generation || now - entry.createdAt > IDEMPOTENCY_TTL_MS) analyzeCache.delete(key);
    }
    while (analyzeCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = analyzeCache.keys().next().value;
      if (oldest === undefined) break;
      analyzeCache.delete(oldest);
    }
  };
  const analyzeLimit = deps.analyzeRateLimit ? createRateLimiter(deps.analyzeRateLimit) : null;
  const allowedOrigins = new Set((deps.corsAllowedOrigins ?? []).map(origin => origin.trim()).filter(Boolean));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const incomingId = req.header('X-Request-Id')?.trim();
    const requestId = incomingId && REQUEST_ID_PATTERN.test(incomingId) ? incomingId : randomUUID();
    const startedAt = Date.now();
    const origin = req.header('Origin');
    if (origin && allowedOrigins.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Operator-Key, Idempotency-Key, X-Request-Id',
        'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After, ETag',
      });
    }
    res.set({
      'X-Request-Id': requestId,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    if (deps.onRequestLog) {
      res.on('finish', () => {
        deps.onRequestLog!({
          ts: new Date().toISOString(),
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          latencyMs: Date.now() - startedAt,
        });
      });
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', mode: deps.mockMode ? 'mock' : 'real',
    ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
  }));
  app.get('/health/ready', async (_req, res) => {
    if (!deps.checkReady) {
      res.json({ status: 'ready', checks: { database: 'skipped', storage: 'skipped' } });
      return;
    }
    try {
      const checks = await deps.checkReady();
      res.json({ status: 'ready', checks });
    } catch {
      throw new DomainError('NOT_READY', 'Hệ thống chưa sẵn sàng nhận yêu cầu.', 503);
    }
  });
  app.use('/uploads', express.static(deps.uploadDir, { dotfiles: 'deny', index: false }));
  if (deps.imageDelivery) app.get('/api/images/:bucket/:prefix/:name', async (req, res) => {
    await requireAuthenticatedUser(req, deps.authVerifier, true);
    const image = await deps.imageDelivery!.readObject(req.params.bucket, req.params.prefix, req.params.name);
    const etag = `"${createHash('sha256').update(image.bytes).digest('hex')}"`;
    res.set({
      'Content-Type': image.mimeType,
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.header('If-None-Match') === etag) {
      res.status(304).end();
      return;
    }
    res.send(Buffer.from(image.bytes));
  });
  const imageUrl = (value: string) => deps.publicBaseUrl ? publicImageUrl(value, deps.publicBaseUrl) : value;
  const mapSummary = <T extends { coverImageUrl: string; resolutionImageUrl?: string | null }>(incident: T) => ({
    ...incident,
    coverImageUrl: imageUrl(incident.coverImageUrl),
    ...(incident.resolutionImageUrl ? { resolutionImageUrl: imageUrl(incident.resolutionImageUrl) } : {}),
  });
  const mapVolunteerEvent = (event: VolunteerEvent): VolunteerEvent => ({
    ...event,
    beforeImageUrl: imageUrl(event.beforeImageUrl),
    afterImageUrl: event.afterImageUrl ? imageUrl(event.afterImageUrl) : null,
  });
  const mapVolunteerEventDetail = (detail: VolunteerEventDetail): VolunteerEventDetail => ({
    ...mapVolunteerEvent(detail),
    participants: detail.participants,
    incidentSummary: {
      ...detail.incidentSummary,
      coverImageUrl: imageUrl(detail.incidentSummary.coverImageUrl),
    },
  });
  const summaries = async (filter?: IncidentListFilter) => (await dependency('DATABASE_UNAVAILABLE', () => deps.repository.list(filter)))
    .map(mapSummary);
  const nearbyOpenSummaries = async (type: IncidentType, location: Location) => {
    const items = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.listNearbyOpen
      ? deps.repository.listNearbyOpen({ type, location, radiusMeters: deps.matchingRadiusMeters ?? 100 })
      : deps.repository.list({ type }));
    return items.map(mapSummary);
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 2, parts: 3 } });

  app.post('/api/reports/analyze', (req, res, next) => {
    if (analyzeLimit) {
      const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
      const decision = analyzeLimit(clientKey);
      if (!decision.allowed) {
        res.set('Retry-After', String(decision.retryAfterSeconds));
        next(new DomainError('RATE_LIMITED', 'Bạn gửi quá nhiều yêu cầu phân tích ảnh. Vui lòng thử lại sau ít phút.', 429));
        return;
      }
    }
    next();
  }, upload.single('image'), async (req, res) => {
    const user = await requireAuthenticatedUser(req, deps.authVerifier);
    const image = validateImage(req.file);
    const idempotencyKey = parseIdempotencyKey(req.header('Idempotency-Key'));
    const { latitude, longitude, ...unknown } = req.body ?? {};
    if (Object.keys(unknown).length) throw new DomainError('VALIDATION_ERROR', 'Field không được hỗ trợ.', 400);
    const missing = latitude === undefined && longitude === undefined;
    if (!missing && (typeof latitude !== 'string' || typeof longitude !== 'string' || !latitude.trim() || !longitude.trim())) {
      throw new DomainError('VALIDATION_ERROR', 'Cần gửi đủ latitude và longitude hợp lệ.', 400);
    }
    const parsed = missing ? null : LocationSchema.safeParse({ latitude: Number(latitude), longitude: Number(longitude) });
    if (parsed && !parsed.success) throw new DomainError('VALIDATION_ERROR', 'Tọa độ không hợp lệ.', 400);
    const location = parsed?.data ?? null;
    const startedAtGeneration = generation;
    const fingerprint = idempotencyKey
      ? createHash('sha256').update(image.bytes).update('|').update(image.mimeType).update('|').update(JSON.stringify(location)).digest('hex')
      : '';
    if (idempotencyKey) {
      pruneAnalyzeCache();
      const cached = analyzeCache.get(idempotencyKey);
      if (cached && cached.generation === startedAtGeneration) {
        if (cached.fingerprint !== fingerprint) {
          throw new DomainError('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key đã được dùng cho một yêu cầu phân tích khác.', 409);
        }
        res.status(201).json(await cached.promise);
        return;
      }
      if (deps.repository.findAnalyzeIdempotency) {
        const persisted = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.findAnalyzeIdempotency!(idempotencyKey));
        if (persisted) {
          if (persisted.fingerprint !== fingerprint) {
            throw new DomainError('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key đã được dùng cho một yêu cầu phân tích khác.', 409);
          }
          res.status(201).json(persisted.response);
          return;
        }
      }
    }
    const work = (async (): Promise<AnalyzeResponse> => {
      const visionResult = await dependency('AI_UNAVAILABLE', () => deps.vision.analyzeIncidentImage(image));
      const parsedAnalysis = AIAnalysisSchema.safeParse(visionResult);
      if (!parsedAnalysis.success) throw new DomainError('PROVIDER_INVALID_RESPONSE', 'Kết quả phân tích không hợp lệ.', 502);
      const analysis = parsedAnalysis.data;
      const candidates = location
        ? await dependency('MATCHING_UNAVAILABLE', async () => deps.matcher.findCandidates({
          analysis, location, incidents: await nearbyOpenSummaries(analysis.type, location),
        }))
        : [];
      // Validate module output before saving report or image.
      if (!AnalyzeResponseSchema.omit({ reportId: true }).safeParse({ analysis, candidates, warnings: [] }).success) {
        throw new DomainError('PROVIDER_INVALID_RESPONSE', 'Kết quả tìm trùng không hợp lệ.', 502);
      }
      const savedImage = await dependency('STORAGE_UNAVAILABLE', () => deps.storage.save(image));
      let writeStarted = false;
      let saved = false;
      try {
        if (startedAtGeneration !== generation) throw new DomainError('MOCK_RESET', 'Dữ liệu vừa được reset. Hãy gửi lại ảnh.', 409);
        writeStarted = true;
        const report = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.createPending({
          analysis, location, imageUrl: savedImage, ...(user ? { reporterId: user.id } : {}),
        }));
        saved = true;
        const responsePayload = AnalyzeResponseSchema.parse({
          reportId: report.id, analysis, candidates,
          warnings: location ? [] : [{ code: 'GPS_UNAVAILABLE', message: 'Không có GPS; chức năng tìm trùng theo vị trí bị hạn chế.' }],
        });
        if (idempotencyKey && deps.repository.saveAnalyzeIdempotency) {
          try {
            await deps.repository.saveAnalyzeIdempotency({
              key: idempotencyKey, fingerprint, response: responsePayload, ttlMs: IDEMPOTENCY_TTL_MS,
            });
          } catch {
            // Do not fail a committed pending report if idempotency persistence fails.
          }
        }
        return responsePayload;
      } catch (error) {
        if (!saved && (!writeStarted || error instanceof PendingReportWriteRejected)) {
          try { await deps.storage.remove(savedImage); }
          catch { console.error('Image cleanup failed; retain object for operator review.'); }
        }
        throw error;
      }
    })();
    if (idempotencyKey) {
      analyzeCache.set(idempotencyKey, { generation: startedAtGeneration, fingerprint, createdAt: Date.now(), promise: work });
      work.catch(() => {
        const entry = analyzeCache.get(idempotencyKey);
        if (entry?.promise === work) analyzeCache.delete(idempotencyKey);
      });
    }
    res.status(201).json(await work);
  });
  app.post('/api/auth/login', async (req, res) => {
    if (!deps.authClient) {
      throw new DomainError('AUTH_NOT_CONFIGURED', 'Máy chủ chưa cấu hình đăng nhập Email/Mật khẩu (Supabase Auth).', 501);
    }
    const parsed = LoginRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Email hoặc mật khẩu không đúng định dạng.', 400);
    const session = await dependency('AUTH_UNAVAILABLE', () => deps.authClient!.signIn(parsed.data));
    res.json(AuthSessionResponseSchema.parse(session));
  });
  app.post('/api/auth/signup', async (req, res) => {
    if (!deps.authClient) {
      throw new DomainError('AUTH_NOT_CONFIGURED', 'Máy chủ chưa cấu hình đăng ký tài khoản (Supabase Auth).', 501);
    }
    const parsed = SignupRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Thông tin đăng ký không hợp lệ (mật khẩu tối thiểu 6 ký tự).', 400);
    const session = await dependency('AUTH_UNAVAILABLE', () => deps.authClient!.signUp(parsed.data));
    res.status(201).json(AuthSessionResponseSchema.parse(session));
  });
  app.get('/api/me/reports', async (req, res) => {
    const user = await resolveOptionalUser(req, deps.authVerifier);
    if (!user) throw new DomainError('UNAUTHORIZED', 'Cần đăng nhập để xem danh sách phản ánh của bạn.', 401);
    const items = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.findReportsByReporter
      ? deps.repository.findReportsByReporter(user.id)
      : Promise.resolve([]));
    res.json(MyReportsResponseSchema.parse({
      reports: items.map(item => ({ ...item, imageUrl: imageUrl(item.imageUrl) })),
    }));
  });
  app.get('/api/reports/:id', async (req, res) => {
    const user = await requireAuthenticatedUser(req, deps.authVerifier);
    const report = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.findReport(req.params.id));
    if (!report) throw new DomainError('REPORT_NOT_FOUND', 'Không tìm thấy báo cáo.', 404);
    assertReportOwnership(report, user);
    res.json(ReportSchema.parse({ ...report, imageUrl: imageUrl(report.imageUrl) }));
  });
  app.post('/api/reports/confirm', async (req, res) => {
    const user = await requireAuthenticatedUser(req, deps.authVerifier);
    const parsed = ConfirmRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu xác nhận không hợp lệ.', 400);
    const report = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.findReport(parsed.data.reportId));
    if (!report) throw new DomainError('REPORT_NOT_FOUND', 'Không tìm thấy báo cáo.', 404);
    assertReportOwnership(report, user);
    let address: string | null | undefined;
    if (parsed.data.action === 'create' && report.location && deps.geocoder) {
      try { address = await deps.geocoder.resolveAddress(report.location); } catch { address = null; }
    }
    res.json(ConfirmResponseSchema.parse(await dependency('DATABASE_UNAVAILABLE', () => deps.repository.confirm(
      parsed.data,
      deps.router.assignTeam(report.analysis.type, report.location),
      address ? { address } : undefined,
    ))));
  });
  app.post('/api/push-tokens', async (req, res) => {
    const user = await resolveOptionalUser(req, deps.authVerifier);
    if (!user) throw new DomainError('UNAUTHORIZED', 'Cần đăng nhập để đăng ký thông báo đẩy.', 401);
    const parsed = RegisterPushTokenRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Push token không hợp lệ.', 400);
    if (deps.repository.registerPushToken) {
      await dependency('DATABASE_UNAVAILABLE', () => deps.repository.registerPushToken!({
        userId: user.id, token: parsed.data.token, platform: parsed.data.platform,
      }));
    }
    res.json({ ok: true });
  });
  app.get('/api/incidents', async (req, res) => {
    const { filter, hasQuery, mine } = parseListFilter(req.query as Record<string, unknown>);
    const effectiveFilter: IncidentListFilter = { ...filter };
    if (mine) {
      const user = await resolveOptionalUser(req, deps.authVerifier);
      if (!user) throw new DomainError('UNAUTHORIZED', 'Cần đăng nhập để lọc hồ sơ của bạn.', 401);
      effectiveFilter.reporterId = user.id;
    }
    const incidents = await summaries(hasQuery ? effectiveFilter : undefined);
    if (!hasQuery) {
      res.json(IncidentListResponseSchema.parse({ incidents }));
      return;
    }
    const countFilter = {
      type: effectiveFilter.type,
      status: effectiveFilter.status,
      severity: effectiveFilter.severity,
      reporterId: effectiveFilter.reporterId,
      q: effectiveFilter.q,
    };
    const total = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.count
      ? deps.repository.count(countFilter)
      : deps.repository.list(countFilter).then(rows => rows.length));
    res.json(IncidentListResponseSchema.parse({ incidents, total }));
  });
  app.get('/api/incidents/:id', async (req, res) => {
    const incident = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.get(req.params.id));
    if (!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
    res.json(IncidentDetailSchema.parse({
      ...mapSummary(incident),
      reports: incident.reports.map(report => ({ ...report, imageUrl: imageUrl(report.imageUrl) })),
    }));
  });
  app.patch('/api/incidents/:id/status', async (req, res) => {
    const operator = await requireOperatorAccess(req, deps);
    const parsed = UpdateIncidentStatusRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu cập nhật trạng thái không hợp lệ.', 400);
    if (!deps.repository.updateStatus) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ cập nhật trạng thái.', 501);
    }
    const updated = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.updateStatus!(req.params.id, {
      ...parsed.data,
      actor: parsed.data.actor ?? operator?.displayName,
      actorId: operator?.id ?? null,
    }));
    if (deps.pushNotifier && deps.repository.listPushTokensForIncident && (updated.status === 'in_progress' || updated.status === 'resolved')) {
      const statusText: Record<IncidentStatus, string> = {
        open: 'Mới tiếp nhận',
        in_progress: 'Đang được xử lý',
        resolved: 'Đã xử lý xong',
      };
      try {
        const tokens = await deps.repository.listPushTokensForIncident(updated.id);
        if (tokens.length > 0) {
          await deps.pushNotifier.notifyStatusChange({
            tokens,
            incidentId: updated.id,
            status: updated.status,
            title: `CivicMerge · ${statusText[updated.status]}`,
            body: parsed.data.note
              ? `${updated.description.slice(0, 80)} — ${parsed.data.note}`
              : `Hồ sơ #${updated.id.slice(0, 8).toUpperCase()} đã chuyển sang "${statusText[updated.status]}".`,
          });
        }
      } catch {
        // Notification failure must never revert or fail status update.
      }
    }
    res.json(IncidentDetailSchema.parse({
      ...mapSummary(updated),
      reports: updated.reports.map(report => ({ ...report, imageUrl: imageUrl(report.imageUrl) })),
    }));
  });
  app.patch('/api/incidents/:id/team', async (req, res) => {
    const operator = await requireOperatorAccess(req, deps);
    const parsed = ReassignTeamRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu đổi tổ xử lý không hợp lệ.', 400);
    if (!deps.repository.reassignTeam) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ đổi tổ xử lý.', 501);
    }
    const updated = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.reassignTeam!(req.params.id, {
      ...parsed.data,
      actor: parsed.data.actor ?? operator?.displayName,
      actorId: operator?.id ?? null,
    }));
    res.json(IncidentDetailSchema.parse({
      ...mapSummary(updated),
      reports: updated.reports.map(report => ({ ...report, imageUrl: imageUrl(report.imageUrl) })),
    }));
  });
  app.post('/api/incidents/:id/resolution-image', upload.single('image'), async (req, res) => {
    await requireOperatorAccess(req, deps);
    const incidentId = String(req.params.id);
    const image = validateImage(req.file);
    if (!deps.repository.attachResolutionImage) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ ảnh nghiệm thu.', 501);
    }
    const existing = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.get(incidentId));
    if (!existing) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
    const savedImage = await dependency('STORAGE_UNAVAILABLE', () => deps.storage.save(image));
    try {
      const updated = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.attachResolutionImage!(incidentId, savedImage));
      res.json(IncidentDetailSchema.parse({
        ...mapSummary(updated),
        reports: updated.reports.map(report => ({ ...report, imageUrl: imageUrl(report.imageUrl) })),
      }));
    } catch (error) {
      try { await deps.storage.remove(savedImage); } catch { /* retain for operator review */ }
      throw error;
    }
  });

  // Tier-2 Community Volunteer Actions ("Buổi Tình Nguyện Xanh")
  app.get('/api/volunteer-events', async (req, res) => {
    if (!deps.repository.listVolunteerEvents) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ Buổi Tình Nguyện Xanh.', 501);
    }
    const filter = parseVolunteerListFilter(req.query as Record<string, unknown>);
    const hasFilter = Object.keys(filter).length > 0;
    const events = (await dependency('DATABASE_UNAVAILABLE', () => deps.repository.listVolunteerEvents!(hasFilter ? filter : undefined)))
      .map(mapVolunteerEvent);
    const countFilter = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.incidentId ? { incidentId: filter.incidentId } : {}),
    };
    const total = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.countVolunteerEvents
      ? deps.repository.countVolunteerEvents(countFilter)
      : Promise.resolve(events.length));
    const stats = deps.repository.getVolunteerStats
      ? await dependency('DATABASE_UNAVAILABLE', () => deps.repository.getVolunteerStats!())
      : undefined;
    res.json(VolunteerEventListResponseSchema.parse({
      events,
      total,
      ...(stats ? { stats } : {}),
    }));
  });

  app.get('/api/volunteer-events/:id', async (req, res) => {
    if (!deps.repository.getVolunteerEvent) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ Buổi Tình Nguyện Xanh.', 501);
    }
    const detail = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.getVolunteerEvent!(req.params.id));
    if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
    res.json(VolunteerEventDetailSchema.parse(mapVolunteerEventDetail(detail)));
  });

  app.post('/api/incidents/:id/volunteer-events', async (req, res) => {
    if (!deps.repository.createVolunteerEvent) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ Buổi Tình Nguyện Xanh.', 501);
    }
    const actor = await resolveVolunteerActor(req, deps);
    const parsed = CreateVolunteerEventRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'Thông tin khởi tạo buổi tình nguyện không hợp lệ.', 400);
    }
    const created = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.createVolunteerEvent!({
      incidentId: req.params.id,
      title: parsed.data.title,
      description: parsed.data.description,
      scheduledAt: parsed.data.scheduledAt,
      meetingPoint: parsed.data.meetingPoint,
      maxParticipants: parsed.data.maxParticipants,
      organizerId: actor.id,
      organizerName: parsed.data.organizerName ?? actor.displayName,
    }));
    res.status(201).json(VolunteerEventDetailSchema.parse(mapVolunteerEventDetail(created)));
  });

  app.post('/api/volunteer-events/:id/join', async (req, res) => {
    if (!deps.repository.joinVolunteerEvent) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ Buổi Tình Nguyện Xanh.', 501);
    }
    const actor = await resolveVolunteerActor(req, deps);
    const parsed = JoinVolunteerEventRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'Thông tin đăng ký tham gia không hợp lệ.', 400);
    }
    const updated = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.joinVolunteerEvent!(req.params.id, {
      userId: actor.id,
      displayName: parsed.data.displayName ?? actor.displayName,
    }));
    res.json(VolunteerEventDetailSchema.parse(mapVolunteerEventDetail(updated)));
  });

  app.delete('/api/volunteer-events/:id/join', async (req, res) => {
    if (!deps.repository.leaveVolunteerEvent) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ Buổi Tình Nguyện Xanh.', 501);
    }
    const actor = await resolveVolunteerActor(req, deps);
    const updated = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.leaveVolunteerEvent!(req.params.id, actor.id));
    res.json(VolunteerEventDetailSchema.parse(mapVolunteerEventDetail(updated)));
  });

  app.post('/api/volunteer-events/:id/after-image', upload.single('image'), async (req, res) => {
    if (!deps.repository.submitVolunteerAfterImage || !deps.repository.getVolunteerEvent) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ nộp ảnh Sau buổi tình nguyện.', 501);
    }
    const actor = await resolveVolunteerActor(req, deps);
    const eventId = String(req.params.id);
    const image = validateImage(req.file);
    const existing = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.getVolunteerEvent!(eventId));
    if (!existing) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
    if (existing.status === 'verified' || existing.status === 'cancelled') {
      throw new DomainError('VOLUNTEER_EVENT_CLOSED', 'Buổi tình nguyện đã kết thúc, không thể nộp ảnh Sau.', 409);
    }
    const savedImage = await dependency('STORAGE_UNAVAILABLE', () => deps.storage.save(image));
    try {
      const updated = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.submitVolunteerAfterImage!(eventId, {
        imageUrl: savedImage,
        actorId: actor.id,
        actor: actor.displayName,
      }));
      res.json(VolunteerEventDetailSchema.parse(mapVolunteerEventDetail(updated)));
    } catch (error) {
      try { await deps.storage.remove(savedImage); } catch { /* retain for operator review */ }
      throw error;
    }
  });

  app.patch('/api/volunteer-events/:id/review', async (req, res) => {
    if (!deps.repository.reviewVolunteerEvent) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ duyệt buổi tình nguyện.', 501);
    }
    const operator = await requireOperatorAccess(req, deps);
    const parsed = ReviewVolunteerEventRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_ERROR', 'Yêu cầu đánh giá buổi tình nguyện không hợp lệ.', 400);
    }
    const result = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.reviewVolunteerEvent!(req.params.id, {
      decision: parsed.data.decision,
      note: parsed.data.note,
      actor: parsed.data.actor ?? operator?.displayName,
      actorId: operator?.id ?? null,
      issueCertificates: parsed.data.issueCertificates,
    }));
    if (parsed.data.decision === 'approve' && deps.pushNotifier && deps.repository.listPushTokensForVolunteerEvent) {
      try {
        const tokens = await deps.repository.listPushTokensForVolunteerEvent(result.event.id);
        if (tokens.length > 0) {
          await deps.pushNotifier.notifyStatusChange({
            tokens,
            incidentId: result.event.incidentId,
            status: 'resolved',
            title: 'GreenMerge · Đã cấp Giấy chứng nhận Tình nguyện Xanh',
            body: `Buổi "${result.event.title}" đã được phê duyệt. Mở mục Chứng nhận để xem mã của bạn!`,
          });
        }
      } catch {
        // Notification failure must never fail or revert an approved volunteer event.
      }
    }
    res.json(ReviewVolunteerEventResponseSchema.parse({
      event: mapVolunteerEventDetail(result.event),
      certificatesIssued: result.certificates.length,
    }));
  });

  app.get('/api/me/certificates', async (req, res) => {
    if (!deps.repository.listCertificatesByUser) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ tra cứu giấy chứng nhận.', 501);
    }
    const actor = await resolveVolunteerActor(req, deps);
    const certificates = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.listCertificatesByUser!(actor.id));
    res.json(MyCertificatesResponseSchema.parse({ certificates }));
  });

  app.get('/api/certificates/:code', async (req, res) => {
    if (!deps.repository.findCertificateByCode) {
      throw new DomainError('NOT_SUPPORTED', 'Repository hiện tại chưa hỗ trợ tra cứu giấy chứng nhận.', 501);
    }
    const cert = await dependency('DATABASE_UNAVAILABLE', () => deps.repository.findCertificateByCode!(req.params.code));
    if (!cert) throw new DomainError('CERTIFICATE_NOT_FOUND', 'Không tìm thấy giấy chứng nhận với mã này.', 404);
    res.json(PublicVolunteerCertificateSchema.parse(cert));
  });

  // Development-only controls. Never register them on a real backend.
  if (deps.mockMode && deps.mockControl) {
    app.get('/api/mock/state', (_req, res) => res.json({ scenario: deps.mockControl!.getScenario() }));
    app.post('/api/mock/scenario', (req, res) => {
      const result = MockStateSchema.strict().safeParse(req.body);
      if (!result.success) throw new DomainError('VALIDATION_ERROR', 'Kịch bản mock không hợp lệ.', 400);
      deps.mockControl!.setScenario(result.data.scenario);
      res.json(result.data);
    });
    app.post('/api/mock/reset', async (_req, res) => {
      generation += 1;
      analyzeCache.clear();
      await deps.repository.reset();
      deps.mockControl!.setScenario('pothole');
      res.json({ scenario: 'pothole' });
    });
  }
  app.use((_req, _res, next) => next(new DomainError('NOT_FOUND', 'Đường dẫn không tồn tại.', 404)));
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof DomainError) { res.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof multer.MulterError) {
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { code: 'VALIDATION_ERROR', message: error.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt giới hạn 8 MB.' : 'Multipart không hợp lệ.' } });
      return;
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'JSON không hợp lệ.' } }); return;
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'JSON vượt giới hạn 32 KiB.' } }); return;
    }
    console.error('API request failed.');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Không thể xử lý yêu cầu. Hãy thử lại.' } });
  };
  app.use(handleError);
  return app;
}
