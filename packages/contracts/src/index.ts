import { z } from 'zod';

export const IncidentTypeSchema = z.enum(['pothole', 'trash', 'flood']);
export const SeveritySchema = z.enum(['low', 'medium', 'high']);
export const IncidentStatusSchema = z.enum(['open', 'in_progress', 'resolved']);
export const UserRoleSchema = z.enum(['citizen', 'operator', 'admin']);
export const AuthUserSchema = z.object({
  id: z.string().uuid(),
  role: UserRoleSchema,
  displayName: z.string().max(120).optional(),
});
export const LoginRequestSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(6).max(200),
}).strict();
export const SignupRequestSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(6).max(200),
  displayName: z.string().trim().min(1).max(120).optional(),
}).strict();
export const AuthSessionResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
  user: AuthUserSchema,
});
export const LocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
// Lowercase ASCII tags, e.g. surface:asphalt or shape:irregular; not free prose.
export const FeatureSchema = z.string().regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/);
export const AIAnalysisSchema = z.object({
  type: IncidentTypeSchema, severity: SeveritySchema,
  description: z.string().min(1), features: z.array(FeatureSchema),
});
export const MatchCandidateSchema = z.object({
  incidentId: z.string().uuid(), score: z.number().min(0).max(1),
  distanceMeters: z.number().nonnegative(), reasons: z.array(z.string()),
});
export const ReportSchema = z.object({
  id: z.string().uuid(), incidentId: z.string().uuid().nullable(),
  status: z.enum(['pending', 'confirmed']), analysis: AIAnalysisSchema,
  location: LocationSchema.nullable(), imageUrl: z.string().url(),
  reporterId: z.string().uuid().nullable().optional(),
  userNote: z.string().max(300).nullable().optional(),
  createdAt: z.string().datetime(),
});
export const IncidentSummarySchema = z.object({
  id: z.string().uuid(), type: IncidentTypeSchema, severity: SeveritySchema,
  description: z.string(), location: LocationSchema.nullable(),
  address: z.string().max(300).nullable().optional(),
  features: z.array(FeatureSchema), status: IncidentStatusSchema,
  assignedTeam: z.string(), reportCount: z.number().int().positive(),
  coverImageUrl: z.string().url(),
  resolutionImageUrl: z.string().url().nullable().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export const HistoryEventSchema = z.object({
  at: z.string().datetime(),
  event: z.enum(['created', 'report_merged', 'status_changed', 'team_reassigned']),
  reportId: z.string().uuid().optional(),
  fromStatus: IncidentStatusSchema.optional(),
  toStatus: IncidentStatusSchema.optional(),
  note: z.string().max(500).optional(),
  actor: z.string().max(120).optional(),
  actorId: z.string().uuid().optional(),
});
export const IncidentDetailSchema = IncidentSummarySchema.extend({
  resolutionNote: z.string().nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
  reports: z.array(ReportSchema),
  history: z.array(HistoryEventSchema),
});
export const UpdateIncidentStatusRequestSchema = z.object({
  status: IncidentStatusSchema,
  note: z.string().trim().min(1).max(500).optional(),
  actor: z.string().trim().min(1).max(120).optional(),
}).strict();
export const AnalyzeRequestSchema = z.object({ location: LocationSchema.nullable() });
export const AnalyzeResponseSchema = z.object({
  reportId: z.string().uuid(), analysis: AIAnalysisSchema,
  candidates: z.array(MatchCandidateSchema),
  warnings: z.array(z.object({ code: z.literal('GPS_UNAVAILABLE'), message: z.string() })),
});
export const ConfirmRequestSchema = z.discriminatedUnion('action', [
  z.object({
    reportId: z.string().uuid(),
    action: z.literal('create'),
    userNote: z.string().trim().min(1).max(300).optional(),
    severity: SeveritySchema.optional(),
    description: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    reportId: z.string().uuid(),
    action: z.literal('merge'),
    targetIncidentId: z.string().uuid(),
    userNote: z.string().trim().min(1).max(300).optional(),
  }).strict(),
]);
export const ConfirmResponseSchema = z.object({
  incidentId: z.string().uuid(), action: z.enum(['created', 'merged']),
  reportCount: z.number().int().positive(), assignedTeam: z.string(),
});
export const ReassignTeamRequestSchema = z.object({
  assignedTeam: z.string().trim().min(1).max(120),
  note: z.string().trim().min(1).max(500).optional(),
  actor: z.string().trim().min(1).max(120).optional(),
}).strict();
export const RegisterPushTokenRequestSchema = z.object({
  token: z.string().trim().min(10).max(255),
  platform: z.enum(['ios', 'android', 'web']),
}).strict();
export const MyReportsResponseSchema = z.object({
  reports: z.array(ReportSchema),
});
export const RoutingRuleSchema = z.object({
  id: z.string().uuid().optional(),
  incidentType: IncidentTypeSchema,
  teamName: z.string().min(1).max(120),
  priority: z.number().int().default(0),
  minLat: z.number().min(-90).max(90).nullable().optional(),
  maxLat: z.number().min(-90).max(90).nullable().optional(),
  minLng: z.number().min(-180).max(180).nullable().optional(),
  maxLng: z.number().min(-180).max(180).nullable().optional(),
  active: z.boolean().default(true),
});
export const IncidentListFilterSchema = z.object({
  type: IncidentTypeSchema.optional(),
  status: IncidentStatusSchema.optional(),
  severity: SeveritySchema.optional(),
  reporterId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
}).strict();
export const IncidentListResponseSchema = z.object({
  incidents: z.array(IncidentSummarySchema),
  total: z.number().int().nonnegative().optional(),
});
export const ApiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export const BackendCapabilitiesSchema = z.object({
  persistence: z.enum(['memory', 'postgres']), storage: z.enum(['local', 'supabase']),
  vision: z.enum(['mock', 'openai']), matching: z.enum(['mock', 'real']),
});
export const HealthSchema = z.object({
  status: z.literal('ok'), mode: z.enum(['mock', 'real']), capabilities: BackendCapabilitiesSchema.optional(),
});
// Development controls are separate from the business request schemas.
export const MockScenarioSchema = z.enum(['pothole', 'trash', 'flood', 'ai-error']);
export const MockStateSchema = z.object({ scenario: MockScenarioSchema });

export type IncidentType = z.infer<typeof IncidentTypeSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;
export type UserRole = z.infer<typeof UserRoleSchema>;
export type AuthUser = z.infer<typeof AuthUserSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type SignupRequest = z.infer<typeof SignupRequestSchema>;
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
export type IncidentListFilter = z.infer<typeof IncidentListFilterSchema>;
export type ReassignTeamRequest = z.infer<typeof ReassignTeamRequestSchema>;
export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequestSchema>;
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type AIAnalysis = z.infer<typeof AIAnalysisSchema>;
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;
export type IncidentDetail = z.infer<typeof IncidentDetailSchema>;
export type UpdateIncidentStatusRequest = z.infer<typeof UpdateIncidentStatusRequestSchema>;
export type AnalyzeResponse = z.infer<typeof AnalyzeResponseSchema>;
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;
export type ConfirmResponse = z.infer<typeof ConfirmResponseSchema>;
export type MockScenario = z.infer<typeof MockScenarioSchema>;
export type BackendCapabilities = z.infer<typeof BackendCapabilitiesSchema>;

export interface ImageInput { bytes: Uint8Array; mimeType: string }
export interface VisionAnalyzer { analyzeIncidentImage(image: ImageInput): Promise<AIAnalysis> }
export interface DuplicateMatcher {
  findCandidates(input: { analysis: AIAnalysis; location: Location; incidents: IncidentSummary[] }): Promise<MatchCandidate[]>;
}
export interface AuthVerifier {
  verifyToken(token: string): Promise<AuthUser>;
}
export interface AuthClient {
  signIn(input: LoginRequest): Promise<AuthSessionResponse>;
  signUp(input: SignupRequest): Promise<AuthSessionResponse>;
}
export interface PushNotifier {
  notifyStatusChange(input: {
    tokens: readonly string[];
    incidentId: string;
    status: IncidentStatus;
    title: string;
    body: string;
  }): Promise<void>;
}
export interface ReverseGeocoder {
  resolveAddress(location: Location): Promise<string | null>;
}
export interface IncidentRouter { assignTeam(type: IncidentType, location?: Location | null): string }
export interface ImageStorage { save(image: ImageInput): Promise<string>; remove(url: string): Promise<void> }
export interface NearbyIncidentQuery {
  type: IncidentType;
  location: Location;
  radiusMeters: number;
}
export interface StoredAnalyzeIdempotency {
  fingerprint: string;
  response: AnalyzeResponse;
}
export interface IncidentRepository {
  createPending(input: { analysis: AIAnalysis; location: Location | null; imageUrl: string; reporterId?: string | null }): Promise<Report>;
  list(filter?: IncidentListFilter): Promise<IncidentSummary[]>;
  count?(filter?: Omit<IncidentListFilter, 'limit' | 'offset'>): Promise<number>;
  listNearbyOpen?(query: NearbyIncidentQuery): Promise<IncidentSummary[]>;
  get(id: string): Promise<IncidentDetail | null>;
  // Implementations must perform validation, linking and idempotency atomically.
  confirm(request: ConfirmRequest, assignedTeam: string, options?: { address?: string | null }): Promise<ConfirmResponse>;
  listRoutingRules?(): Promise<RoutingRule[]>;
  updateStatus?(id: string, input: UpdateIncidentStatusRequest & { actorId?: string | null }): Promise<IncidentDetail>;
  reassignTeam?(id: string, input: ReassignTeamRequest & { actorId?: string | null }): Promise<IncidentDetail>;
  attachResolutionImage?(id: string, imageUrl: string): Promise<IncidentDetail>;
  findReport(id: string): Promise<Report | null>;
  findReportsByReporter?(reporterId: string): Promise<Report[]>;
  findAnalyzeIdempotency?(key: string): Promise<StoredAnalyzeIdempotency | null>;
  saveAnalyzeIdempotency?(input: { key: string; fingerprint: string; response: AnalyzeResponse; ttlMs: number }): Promise<void>;
  registerPushToken?(input: { userId: string; token: string; platform: 'ios' | 'android' | 'web' }): Promise<void>;
  listPushTokensForIncident?(incidentId: string): Promise<string[]>;
  listExpiredPendingReports?(olderThanIso: string): Promise<Report[]>;
  deletePendingReport?(id: string): Promise<boolean>;
  reset(): Promise<void>;
}
export class DomainError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
