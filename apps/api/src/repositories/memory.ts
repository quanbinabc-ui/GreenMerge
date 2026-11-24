import { randomUUID } from 'node:crypto';
import {
  DomainError, IncidentListFilterSchema, ReassignTeamRequestSchema, UpdateIncidentStatusRequestSchema,
  type AnalyzeResponse, type ConfirmRequest, type ConfirmResponse, type IncidentDetail,
  type IncidentListFilter, type IncidentRepository, type NearbyIncidentQuery, type Report,
} from '@civicmerge/contracts';
import { assertStatusTransition, boundingBoxFor, escalateSeverity, isWithinBounds, mergeFeatures } from './bounds.js';

export function createMemoryRepository(options: { incidents?: Map<string, IncidentDetail> } = {}): IncidentRepository {
  const reports = new Map<string, Report>();
  // Instance-owned backing store allows deterministic status-transition fixtures.
  // No status mutation method or test endpoint is exposed through the HTTP API.
  const incidents = options.incidents ?? new Map<string, IncidentDetail>();
  const confirmations = new Map<string, { request: ConfirmRequest; response: ConfirmResponse }>();
  const analyzeIdempotency = new Map<string, { fingerprint: string; response: AnalyzeResponse; expiresAt: number }>();
  const pushTokens = new Map<string, { userId: string; token: string; platform: 'ios' | 'android' | 'web' }>();
  const copy = <T>(value: T): T => structuredClone(value);
  const filterItems = (filter?: Omit<IncidentListFilter, 'limit' | 'offset'>) => {
    const all = [...incidents.values()].reverse();
    const queryText = filter?.q?.trim().toLowerCase();
    return all.filter(item =>
      (!filter?.type || item.type === filter.type)
      && (!filter?.status || item.status === filter.status)
      && (!filter?.severity || item.severity === filter.severity)
      && (!filter?.reporterId || item.reports.some(report => report.reporterId === filter.reporterId))
      && (!queryText
        || item.description.toLowerCase().includes(queryText)
        || item.assignedTeam.toLowerCase().includes(queryText)
        || (item.address?.toLowerCase().includes(queryText) ?? false)));
  };
  return {
    async createPending(input) {
      const report: Report = {
        ...copy(input),
        id: randomUUID(),
        incidentId: null,
        status: 'pending',
        ...(input.reporterId !== undefined ? { reporterId: input.reporterId } : {}),
        createdAt: new Date().toISOString(),
      };
      reports.set(report.id, report);
      return copy(report);
    },
    async list(filter?: IncidentListFilter) {
      const parsed = filter ? IncidentListFilterSchema.parse(filter) : undefined;
      const filtered = filterItems(parsed);
      const offset = parsed?.offset ?? 0;
      const sliced = parsed?.limit !== undefined ? filtered.slice(offset, offset + parsed.limit) : filtered.slice(offset);
      return sliced.map(({ reports: _reports, history: _history, resolutionNote: _resolutionNote, resolvedAt: _resolvedAt, ...summary }) => copy(summary));
    },
    async count(filter?: Omit<IncidentListFilter, 'limit' | 'offset'>) {
      return filterItems(filter).length;
    },
    async listNearbyOpen(query: NearbyIncidentQuery) {
      const bounds = boundingBoxFor(query.location, query.radiusMeters);
      return [...incidents.values()]
        .reverse()
        .filter(item => item.type === query.type && item.status !== 'resolved' && item.location !== null && isWithinBounds(item.location, bounds))
        .map(({ reports: _reports, history: _history, resolutionNote: _resolutionNote, resolvedAt: _resolvedAt, ...summary }) => copy(summary));
    },
    async get(id) { return copy(incidents.get(id) ?? null); },
    async findReport(id) { return copy(reports.get(id) ?? null); },
    async findReportsByReporter(reporterId: string) {
      return [...reports.values()]
        .filter(item => item.reporterId === reporterId)
        .reverse()
        .map(copy);
    },
    async confirm(request, assignedTeam, options) {
      // No await between validation and writes: atomic within this single-process mock.
      // Member 3 must use a database transaction/unique constraints in the real adapter.
      const prior = confirmations.get(request.reportId);
      if (prior) {
        if (prior.request.action !== request.action || (prior.request.action === 'merge' && request.action === 'merge' && prior.request.targetIncidentId !== request.targetIncidentId)) {
          throw new DomainError('REPORT_ALREADY_CONFIRMED', 'Báo cáo đã được xác nhận với lựa chọn khác.', 409);
        }
        return copy(prior.response);
      }
      const report = reports.get(request.reportId);
      if (!report) throw new DomainError('REPORT_NOT_FOUND', 'Không tìm thấy báo cáo.', 404);
      const now = new Date().toISOString();
      let incident: IncidentDetail;
      if (request.action === 'merge') {
        const target = incidents.get(request.targetIncidentId);
        if (!target) throw new DomainError('INCIDENT_NOT_FOUND', 'Hồ sơ đích không tồn tại.', 404);
        if (target.type !== report.analysis.type) throw new DomainError('INCIDENT_TYPE_MISMATCH', 'Không thể hợp nhất hai loại sự cố khác nhau.', 409);
        if (target.status === 'resolved') throw new DomainError('INCIDENT_RESOLVED', 'Hồ sơ đích đã được xử lý. Hãy tạo hồ sơ mới.', 409);
        target.features = mergeFeatures(target.features, report.analysis.features);
        target.severity = escalateSeverity(target.severity, report.analysis.severity);
        incident = target;
      } else {
        incident = {
          id: randomUUID(),
          ...copy(report.analysis),
          severity: request.severity ?? report.analysis.severity,
          description: request.description ?? report.analysis.description,
          location: copy(report.location),
          ...(options?.address ? { address: options.address } : {}),
          status: 'open', assignedTeam, reportCount: 0, coverImageUrl: report.imageUrl,
          createdAt: now, updatedAt: now, reports: [], history: [],
        };
      }
      if (request.userNote) report.userNote = request.userNote;
      report.incidentId = incident.id;
      report.status = 'confirmed';
      incident.reports.push(copy(report));
      incident.reportCount = incident.reports.length;
      incident.updatedAt = now;
      incident.history.push({ at: now, event: request.action === 'create' ? 'created' : 'report_merged', reportId: report.id });
      incidents.set(incident.id, incident);
      const response: ConfirmResponse = {
        incidentId: incident.id, action: request.action === 'create' ? 'created' : 'merged',
        reportCount: incident.reportCount, assignedTeam: incident.assignedTeam,
      };
      confirmations.set(report.id, { request: copy(request), response: copy(response) });
      return copy(response);
    },
    async updateStatus(id: string, input) {
      const { actorId, ...rest } = input;
      const parsed = UpdateIncidentStatusRequestSchema.safeParse(rest);
      if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu cập nhật trạng thái không hợp lệ.', 400);
      const target = incidents.get(id);
      if (!target) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
      const fromStatus = target.status;
      assertStatusTransition(fromStatus, parsed.data.status);
      const now = new Date().toISOString();
      target.status = parsed.data.status;
      target.updatedAt = now;
      if (parsed.data.status === 'resolved') {
        target.resolvedAt = now;
        target.resolutionNote = parsed.data.note ?? null;
      }
      target.history.push({
        at: now,
        event: 'status_changed',
        fromStatus,
        toStatus: parsed.data.status,
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
        ...(parsed.data.actor ? { actor: parsed.data.actor } : {}),
        ...(actorId ? { actorId } : {}),
      });
      return copy(target);
    },
    async reassignTeam(id: string, input) {
      const { actorId, ...rest } = input;
      const parsed = ReassignTeamRequestSchema.safeParse(rest);
      if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu đổi tổ xử lý không hợp lệ.', 400);
      const target = incidents.get(id);
      if (!target) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
      if (target.status === 'resolved') throw new DomainError('INCIDENT_RESOLVED', 'Hồ sơ đã xử lý xong không thể đổi tổ phụ trách.', 409);
      const previousTeam = target.assignedTeam;
      const now = new Date().toISOString();
      target.assignedTeam = parsed.data.assignedTeam;
      target.updatedAt = now;
      const noteParts = [`Chuyển từ ${previousTeam} sang ${parsed.data.assignedTeam}`];
      if (parsed.data.note) noteParts.push(parsed.data.note);
      target.history.push({
        at: now,
        event: 'team_reassigned',
        note: noteParts.join(' · '),
        ...(parsed.data.actor ? { actor: parsed.data.actor } : {}),
        ...(actorId ? { actorId } : {}),
      });
      return copy(target);
    },
    async attachResolutionImage(id: string, imageUrl: string) {
      const target = incidents.get(id);
      if (!target) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
      target.resolutionImageUrl = imageUrl;
      target.updatedAt = new Date().toISOString();
      return copy(target);
    },
    async findAnalyzeIdempotency(key: string) {
      const entry = analyzeIdempotency.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        analyzeIdempotency.delete(key);
        return null;
      }
      return copy({ fingerprint: entry.fingerprint, response: entry.response });
    },
    async saveAnalyzeIdempotency(input) {
      analyzeIdempotency.set(input.key, {
        fingerprint: input.fingerprint,
        response: copy(input.response),
        expiresAt: Date.now() + input.ttlMs,
      });
    },
    async registerPushToken(input) {
      pushTokens.set(input.token, { ...input });
    },
    async listPushTokensForIncident(incidentId: string) {
      const target = incidents.get(incidentId);
      if (!target) return [];
      const reporterIds = new Set(target.reports.map(r => r.reporterId).filter((v): v is string => Boolean(v)));
      return [...pushTokens.values()].filter(t => reporterIds.has(t.userId)).map(t => t.token);
    },
    async listExpiredPendingReports(olderThanIso: string) {
      const cutoff = Date.parse(olderThanIso);
      return [...reports.values()]
        .filter(item => item.status === 'pending' && item.incidentId === null && Date.parse(item.createdAt) < cutoff)
        .map(copy);
    },
    async deletePendingReport(id: string) {
      const report = reports.get(id);
      if (!report || report.status !== 'pending' || report.incidentId !== null) return false;
      reports.delete(id);
      return true;
    },
    async listRoutingRules() {
      return [];
    },
    async reset() { reports.clear(); incidents.clear(); confirmations.clear(); analyzeIdempotency.clear(); pushTokens.clear(); },
  };
}
