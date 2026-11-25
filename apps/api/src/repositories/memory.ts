import { randomUUID } from 'node:crypto';
import {
  DomainError, IncidentListFilterSchema, ReassignTeamRequestSchema, UpdateIncidentStatusRequestSchema,
  VolunteerEventListFilterSchema,
  type AnalyzeResponse, type ConfirmRequest, type ConfirmResponse, type IncidentDetail,
  type IncidentListFilter, type IncidentRepository, type NearbyIncidentQuery, type Report,
  type VolunteerCertificate, type VolunteerEvent, type VolunteerEventDetail,
  type VolunteerEventListFilter, type VolunteerParticipant,
} from '@civicmerge/contracts';
import {
  assertIncidentSafeForVolunteer, assertStatusTransition, boundingBoxFor,
  escalateSeverity, generateCertificateCode, isWithinBounds, mergeFeatures,
} from './bounds.js';

export function createMemoryRepository(options: { incidents?: Map<string, IncidentDetail> } = {}): IncidentRepository {
  const reports = new Map<string, Report>();
  // Instance-owned backing store allows deterministic status-transition fixtures.
  // No status mutation method or test endpoint is exposed through the HTTP API.
  const incidents = options.incidents ?? new Map<string, IncidentDetail>();
  const confirmations = new Map<string, { request: ConfirmRequest; response: ConfirmResponse }>();
  const analyzeIdempotency = new Map<string, { fingerprint: string; response: AnalyzeResponse; expiresAt: number }>();
  const pushTokens = new Map<string, { userId: string; token: string; platform: 'ios' | 'android' | 'web' }>();
  const volunteerEvents = new Map<string, VolunteerEvent>();
  const volunteerParticipants = new Map<string, VolunteerParticipant[]>();
  const volunteerCertificates = new Map<string, VolunteerCertificate>();
  const copy = <T>(value: T): T => structuredClone(value);
  const ACTIVE_VOLUNTEER_STATUSES = new Set<VolunteerEvent['status']>(['recruiting', 'in_progress', 'pending_review']);
  const buildVolunteerDetail = (event: VolunteerEvent): VolunteerEventDetail => {
    const incident = incidents.get(event.incidentId);
    if (!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố liên kết.', 404);
    const certByUser = new Map<string, string>();
    for (const cert of volunteerCertificates.values()) {
      if (cert.eventId === event.id) certByUser.set(cert.userId, cert.certificateCode);
    }
    const participants = (volunteerParticipants.get(event.id) ?? []).map(p => ({
      ...copy(p),
      certificateCode: certByUser.get(p.userId) ?? null,
    }));
    return copy({
      ...event,
      participants,
      incidentSummary: {
        id: incident.id,
        type: incident.type,
        severity: incident.severity,
        description: incident.description,
        status: incident.status,
        ...(incident.address !== undefined ? { address: incident.address } : {}),
        location: copy(incident.location),
        coverImageUrl: incident.coverImageUrl,
      },
    });
  };
  const filterVolunteerEvents = (filter?: Omit<VolunteerEventListFilter, 'limit' | 'offset'>) =>
    [...volunteerEvents.values()]
      .reverse()
      .filter(ev => (!filter?.status || ev.status === filter.status) && (!filter?.incidentId || ev.incidentId === filter.incidentId));
  const nextUniqueCertificateCode = (year: number): string => {
    const used = new Set([...volunteerCertificates.values()].map(c => c.certificateCode));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateCertificateCode(year);
      if (!used.has(code)) return code;
    }
    return generateCertificateCode(year);
  };
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
    async createVolunteerEvent(input) {
      const incident = incidents.get(input.incidentId);
      if (!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố.', 404);
      assertIncidentSafeForVolunteer(incident);
      const existingActive = [...volunteerEvents.values()].find(
        ev => ev.incidentId === incident.id && ACTIVE_VOLUNTEER_STATUSES.has(ev.status),
      );
      if (existingActive) {
        throw new DomainError('VOLUNTEER_EVENT_EXISTS', 'Sự cố này đã có một Buổi Tình Nguyện Xanh đang diễn ra.', 409);
      }
      const now = new Date().toISOString();
      const eventId = randomUUID();
      const participants: VolunteerParticipant[] = [];
      if (input.organizerId) {
        participants.push({
          id: randomUUID(),
          eventId,
          userId: input.organizerId,
          displayName: input.organizerName,
          status: 'joined',
          joinedAt: now,
        });
      }
      const created: VolunteerEvent = {
        id: eventId,
        incidentId: incident.id,
        title: input.title,
        description: input.description,
        scheduledAt: input.scheduledAt,
        meetingPoint: input.meetingPoint,
        maxParticipants: input.maxParticipants,
        participantCount: participants.length,
        status: 'recruiting',
        organizerId: input.organizerId,
        organizerName: input.organizerName,
        beforeImageUrl: incident.coverImageUrl,
        afterImageUrl: null,
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      volunteerEvents.set(eventId, created);
      volunteerParticipants.set(eventId, participants);
      incident.updatedAt = now;
      incident.history.push({
        at: now,
        event: 'volunteer_event_created',
        note: `Khởi tạo buổi tình nguyện: ${input.title}`,
        actor: input.organizerName,
        ...(input.organizerId ? { actorId: input.organizerId } : {}),
      });
      return buildVolunteerDetail(created);
    },
    async listVolunteerEvents(filter?: VolunteerEventListFilter) {
      const parsed = filter ? VolunteerEventListFilterSchema.parse(filter) : undefined;
      const filtered = filterVolunteerEvents(parsed);
      const offset = parsed?.offset ?? 0;
      const sliced = parsed?.limit !== undefined ? filtered.slice(offset, offset + parsed.limit) : filtered.slice(offset);
      return sliced.map(copy);
    },
    async countVolunteerEvents(filter?: Omit<VolunteerEventListFilter, 'limit' | 'offset'>) {
      return filterVolunteerEvents(filter).length;
    },
    async getVolunteerStats() {
      let verifiedEvents = 0;
      for (const ev of volunteerEvents.values()) {
        if (ev.status === 'verified') verifiedEvents += 1;
      }
      return {
        verifiedEvents,
        totalCertificates: volunteerCertificates.size,
      };
    },
    async getVolunteerEvent(id: string) {
      const ev = volunteerEvents.get(id);
      return ev ? buildVolunteerDetail(ev) : null;
    },
    async joinVolunteerEvent(eventId: string, input) {
      const ev = volunteerEvents.get(eventId);
      if (!ev) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      if (ev.status !== 'recruiting' && ev.status !== 'in_progress') {
        throw new DomainError('VOLUNTEER_EVENT_CLOSED', 'Buổi tình nguyện này đã đóng đăng ký.', 409);
      }
      const list = volunteerParticipants.get(eventId) ?? [];
      const existing = list.find(p => p.userId === input.userId);
      if (existing && (existing.status === 'joined' || existing.status === 'checked_in' || existing.status === 'certified')) {
        return buildVolunteerDetail(ev);
      }
      if (ev.participantCount >= ev.maxParticipants) {
        throw new DomainError('VOLUNTEER_EVENT_FULL', 'Buổi tình nguyện đã đủ số lượng người tham gia.', 409);
      }
      const now = new Date().toISOString();
      if (existing) {
        existing.status = 'joined';
        existing.displayName = input.displayName;
        existing.joinedAt = now;
      } else {
        list.push({
          id: randomUUID(),
          eventId,
          userId: input.userId,
          displayName: input.displayName,
          status: 'joined',
          joinedAt: now,
        });
      }
      volunteerParticipants.set(eventId, list);
      ev.participantCount += 1;
      ev.updatedAt = now;
      return buildVolunteerDetail(ev);
    },
    async leaveVolunteerEvent(eventId: string, userId: string) {
      const ev = volunteerEvents.get(eventId);
      if (!ev) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      if (ev.status === 'verified' || ev.status === 'pending_review') {
        throw new DomainError('VOLUNTEER_EVENT_CLOSED', 'Không thể hủy tham gia khi buổi tình nguyện đang chờ duyệt hoặc đã hoàn tất.', 409);
      }
      const list = volunteerParticipants.get(eventId) ?? [];
      const existing = list.find(p => p.userId === userId);
      if (existing && (existing.status === 'joined' || existing.status === 'checked_in')) {
        existing.status = 'cancelled';
        ev.participantCount = Math.max(0, ev.participantCount - 1);
        ev.updatedAt = new Date().toISOString();
      }
      return buildVolunteerDetail(ev);
    },
    async submitVolunteerAfterImage(eventId: string, input) {
      const ev = volunteerEvents.get(eventId);
      if (!ev) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      if (ev.status === 'verified' || ev.status === 'cancelled') {
        throw new DomainError('VOLUNTEER_EVENT_CLOSED', 'Buổi tình nguyện đã kết thúc, không thể nộp ảnh Sau.', 409);
      }
      const incident = incidents.get(ev.incidentId);
      if (!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố liên kết.', 404);
      const now = new Date().toISOString();
      ev.afterImageUrl = input.imageUrl;
      ev.status = 'pending_review';
      ev.reviewNote = null;
      ev.updatedAt = now;
      incident.updatedAt = now;
      incident.history.push({
        at: now,
        event: 'volunteer_after_submitted',
        note: `Đã nộp ảnh Sau hoàn thành cho buổi "${ev.title}"`,
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
      });
      return buildVolunteerDetail(ev);
    },
    async reviewVolunteerEvent(eventId: string, input) {
      const ev = volunteerEvents.get(eventId);
      if (!ev) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      if (ev.status === 'verified' || ev.status === 'cancelled') {
        throw new DomainError('VOLUNTEER_EVENT_ALREADY_REVIEWED', 'Buổi tình nguyện này đã được xử lý xong trước đó.', 409);
      }
      const now = new Date().toISOString();
      const reviewerName = input.actor?.trim() || 'Ban quản lý GreenMerge';
      if (input.decision === 'reject') {
        ev.status = 'in_progress';
        ev.reviewNote = input.note ?? 'Cần bổ sung ảnh Sau khi hoàn thành rõ nét hơn.';
        ev.reviewedBy = reviewerName;
        ev.reviewedAt = now;
        ev.updatedAt = now;
        return { event: buildVolunteerDetail(ev), certificates: [] };
      }
      if (!ev.afterImageUrl) {
        throw new DomainError('AFTER_IMAGE_REQUIRED', 'Cần có ảnh Sau khi hoàn thành trước khi phê duyệt buổi tình nguyện.', 409);
      }
      const incident = incidents.get(ev.incidentId);
      if (!incident) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố liên kết.', 404);
      const fromStatus = incident.status;
      ev.status = 'verified';
      ev.reviewNote = input.note ?? null;
      ev.reviewedBy = reviewerName;
      ev.reviewedAt = now;
      ev.updatedAt = now;

      const resolutionNote = input.note ?? `Đã xử lý bởi Buổi Tình Nguyện Xanh: ${ev.title}`;
      incident.status = 'resolved';
      incident.resolutionImageUrl = ev.afterImageUrl;
      incident.resolutionNote = resolutionNote;
      incident.resolvedAt = incident.resolvedAt ?? now;
      incident.updatedAt = now;
      incident.history.push({
        at: now,
        event: 'volunteer_verified',
        fromStatus,
        toStatus: 'resolved',
        note: resolutionNote,
        actor: reviewerName,
        ...(input.actorId ? { actorId: input.actorId } : {}),
      });

      const issued: VolunteerCertificate[] = [];
      if (input.issueCertificates !== false) {
        const year = new Date(now).getUTCFullYear();
        const participants = volunteerParticipants.get(eventId) ?? [];
        for (const p of participants) {
          if (p.status === 'joined' || p.status === 'checked_in') {
            p.status = 'certified';
            const cert: VolunteerCertificate = {
              id: randomUUID(),
              certificateCode: nextUniqueCertificateCode(year),
              eventId: ev.id,
              eventTitle: ev.title,
              incidentId: ev.incidentId,
              userId: p.userId,
              recipientName: p.displayName,
              completedAt: now,
              issuedBy: reviewerName,
              issuedAt: now,
            };
            volunteerCertificates.set(cert.id, cert);
            issued.push(copy(cert));
          }
        }
      }
      return { event: buildVolunteerDetail(ev), certificates: issued };
    },
    async listCertificatesByUser(userId: string) {
      return [...volunteerCertificates.values()]
        .filter(c => c.userId === userId)
        .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
        .map(copy);
    },
    async findCertificateByCode(code: string) {
      const normalized = code.trim().toUpperCase();
      const found = [...volunteerCertificates.values()].find(c => c.certificateCode.toUpperCase() === normalized);
      return copy(found ?? null);
    },
    async listPushTokensForVolunteerEvent(eventId: string) {
      const participants = volunteerParticipants.get(eventId) ?? [];
      const userIds = new Set(
        participants
          .filter(p => p.status === 'joined' || p.status === 'checked_in' || p.status === 'certified')
          .map(p => p.userId),
      );
      return [...pushTokens.values()].filter(t => userIds.has(t.userId)).map(t => t.token);
    },
    async reset() {
      reports.clear();
      incidents.clear();
      confirmations.clear();
      analyzeIdempotency.clear();
      pushTokens.clear();
      volunteerEvents.clear();
      volunteerParticipants.clear();
      volunteerCertificates.clear();
    },
  };
}
