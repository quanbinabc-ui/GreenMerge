import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { PendingReportWriteRejected } from './errors.js';
import {
  assertIncidentSafeForVolunteer, assertStatusTransition, boundingBoxFor,
  escalateSeverity, generateCertificateCode, mergeFeatures,
} from './bounds.js';
import {
  AIAnalysisSchema, AnalyzeResponseSchema, ConfirmRequestSchema, ConfirmResponseSchema, DomainError,
  IncidentDetailSchema, IncidentListFilterSchema, IncidentSummarySchema, LocationSchema,
  ReassignTeamRequestSchema, ReportSchema, RoutingRuleSchema, UpdateIncidentStatusRequestSchema,
  VolunteerCertificateSchema, VolunteerEventDetailSchema, VolunteerEventListFilterSchema,
  VolunteerEventSchema, VolunteerParticipantSchema,
  type HistoryEvent, type IncidentListFilter, type IncidentRepository, type IncidentStatus,
  type IncidentType, type NearbyIncidentQuery, type Severity, type VolunteerCertificate,
  type VolunteerEventListFilter,
} from '@civicmerge/contracts';

const iso = (value: Date) => value.toISOString();
const location = (row: QueryResultRow) => row.latitude === null ? null : { latitude: row.latitude, longitude: row.longitude };
function report(row: QueryResultRow) {
  return ReportSchema.parse({
    id: row.id, incidentId: row.incident_id, status: row.status,
    analysis: { type: row.type, severity: row.severity, description: row.description, features: row.features },
    location: location(row), imageUrl: row.image_url,
    ...(row.reporter_id !== undefined && row.reporter_id !== null ? { reporterId: row.reporter_id } : {}),
    ...(row.user_note !== undefined && row.user_note !== null ? { userNote: row.user_note } : {}),
    createdAt: iso(row.created_at),
  });
}
function summary(row: QueryResultRow) {
  return IncidentSummarySchema.parse({
    id: row.id, type: row.type, severity: row.severity, description: row.description, features: row.features,
    location: location(row),
    ...(row.address !== undefined && row.address !== null ? { address: row.address } : {}),
    status: row.status, assignedTeam: row.assigned_team,
    reportCount: row.report_count, coverImageUrl: row.cover_image_url,
    ...(row.resolution_image_url !== undefined && row.resolution_image_url !== null
      ? { resolutionImageUrl: row.resolution_image_url } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}
function volunteerEventRow(row: QueryResultRow) {
  return VolunteerEventSchema.parse({
    id: row.id,
    incidentId: row.incident_id,
    title: row.title,
    description: row.description ?? '',
    scheduledAt: iso(row.scheduled_at),
    meetingPoint: row.meeting_point,
    maxParticipants: Number(row.max_participants),
    participantCount: Number(row.participant_count),
    status: row.status,
    organizerId: row.organizer_id ?? null,
    organizerName: row.organizer_name,
    beforeImageUrl: row.before_image_url,
    afterImageUrl: row.after_image_url ?? null,
    reviewNote: row.review_note ?? null,
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}
function volunteerParticipantRow(row: QueryResultRow) {
  return VolunteerParticipantSchema.parse({
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    displayName: row.display_name,
    status: row.status,
    joinedAt: iso(row.joined_at),
    certificateCode: row.certificate_code ?? null,
  });
}
function volunteerCertificateRow(row: QueryResultRow) {
  return VolunteerCertificateSchema.parse({
    id: row.id,
    certificateCode: row.certificate_code,
    eventId: row.event_id,
    eventTitle: row.event_title,
    incidentId: row.incident_id,
    userId: row.user_id,
    recipientName: row.recipient_name,
    completedAt: iso(row.completed_at),
    issuedBy: row.issued_by,
    issuedAt: iso(row.issued_at),
  });
}
async function readVolunteerDetailInClient(client: PoolClient, eventId: string) {
  const evResult = await client.query('SELECT * FROM civicmerge.volunteer_events WHERE id = $1', [eventId]);
  if (!evResult.rows[0]) return null;
  const evRow = evResult.rows[0];
  const incidentResult = await client.query('SELECT * FROM civicmerge.incidents WHERE id = $1', [evRow.incident_id]);
  if (!incidentResult.rows[0]) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố liên kết.', 404);
  const incRow = incidentResult.rows[0];
  const participantsResult = await client.query(
    `SELECT vp.*, vc.certificate_code
     FROM civicmerge.volunteer_participants vp
     LEFT JOIN civicmerge.volunteer_certificates vc
       ON vc.event_id = vp.event_id AND vc.user_id = vp.user_id
     WHERE vp.event_id = $1
     ORDER BY vp.joined_at ASC, vp.id ASC`,
    [eventId],
  );
  return VolunteerEventDetailSchema.parse({
    ...volunteerEventRow(evRow),
    participants: participantsResult.rows.map(volunteerParticipantRow),
    incidentSummary: {
      id: incRow.id,
      type: incRow.type,
      severity: incRow.severity,
      description: incRow.description,
      status: incRow.status,
      ...(incRow.address !== undefined && incRow.address !== null ? { address: incRow.address } : {}),
      location: location(incRow),
      coverImageUrl: incRow.cover_image_url,
    },
  });
}

async function readDetailInClient(client: PoolClient, id: string) {
  const result = await client.query('SELECT * FROM civicmerge.incidents WHERE id = $1', [id]);
  if (!result.rows[0]) return null;
  const incidentRow = result.rows[0];
  const reports = await client.query('SELECT * FROM civicmerge.reports WHERE incident_id = $1 ORDER BY created_at, id', [id]);
  const historyRows = await client.query('SELECT * FROM civicmerge.history WHERE incident_id = $1 ORDER BY at, report_id', [id]);
  const eventRows = await client.query('SELECT * FROM civicmerge.incident_events WHERE incident_id = $1 ORDER BY at, id', [id]);
  const legacyEvents: HistoryEvent[] = historyRows.rows.map(row => ({
    at: iso(row.at),
    event: row.event,
    reportId: row.report_id,
  }));
  const extraEvents: HistoryEvent[] = eventRows.rows.map(row => ({
    at: iso(row.at),
    event: row.event,
    ...(row.report_id ? { reportId: row.report_id } : {}),
    ...(row.from_status ? { fromStatus: row.from_status } : {}),
    ...(row.to_status ? { toStatus: row.to_status } : {}),
    ...(row.note ? { note: row.note } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
  }));
  const mergedHistory = [...legacyEvents, ...extraEvents].sort((a, b) => a.at.localeCompare(b.at));
  return IncidentDetailSchema.parse({
    ...summary(incidentRow),
    ...(incidentRow.resolution_note !== undefined && incidentRow.resolution_note !== null
      ? { resolutionNote: incidentRow.resolution_note } : {}),
    ...(incidentRow.resolved_at !== undefined && incidentRow.resolved_at !== null
      ? { resolvedAt: iso(incidentRow.resolved_at) } : {}),
    reports: reports.rows.map(report),
    history: mergedHistory,
  });
}

// All statements in a transaction use one checked-out client, never pool.query.
async function transaction<T>(pool: Pool, begin: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failedConnection: Error | undefined;
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { failedConnection = new Error('Database rollback failed'); }
    throw error;
  } finally { client.release(failedConnection); }
}

export function createPostgresRepository(pool: Pool): IncidentRepository {
  return {
    async createPending(input) {
      const analysis = AIAnalysisSchema.parse(input.analysis);
      const point = LocationSchema.nullable().parse(input.location);
      const imageUrl = ReportSchema.shape.imageUrl.parse(input.imageUrl);
      let result;
      try {
        result = input.reporterId
          ? await pool.query(`
            INSERT INTO civicmerge.reports (id, type, severity, description, features, latitude, longitude, image_url, reporter_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [randomUUID(), analysis.type, analysis.severity, analysis.description, analysis.features,
            point?.latitude ?? null, point?.longitude ?? null, imageUrl, input.reporterId])
          : await pool.query(`
            INSERT INTO civicmerge.reports (id, type, severity, description, features, latitude, longitude, image_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [randomUUID(), analysis.type, analysis.severity, analysis.description, analysis.features,
            point?.latitude ?? null, point?.longitude ?? null, imageUrl]);
      }
      catch (error) {
        // SQLSTATE data/constraint/syntax/rollback failures mean this single
        // INSERT was rejected. Transport/cancellation/unknown errors do not.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (/^(22|23|40|42)[A-Z0-9]{3}$/.test(code) || code === 'P0001') throw new PendingReportWriteRejected();
        throw new DomainError('DATABASE_UNAVAILABLE', 'Chưa xác định được kết quả lưu báo cáo. Không tự động gửi lại.', 503);
      }
      return report(result.rows[0]);
    },
    async findReport(id) {
      if (!ReportSchema.shape.id.safeParse(id).success) return null;
      const result = await pool.query('SELECT * FROM civicmerge.reports WHERE id = $1', [id]);
      return result.rows[0] ? report(result.rows[0]) : null;
    },
    async findReportsByReporter(reporterId: string) {
      if (!ReportSchema.shape.id.safeParse(reporterId).success) return [];
      const result = await pool.query(
        'SELECT * FROM civicmerge.reports WHERE reporter_id = $1 ORDER BY created_at DESC, id DESC',
        [reporterId],
      );
      return result.rows.map(report);
    },
    async list(filter?: IncidentListFilter) {
      const parsed = filter ? IncidentListFilterSchema.parse(filter) : undefined;
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (parsed?.type) { params.push(parsed.type); clauses.push(`type = $${params.length}`); }
      if (parsed?.status) { params.push(parsed.status); clauses.push(`status = $${params.length}`); }
      if (parsed?.severity) { params.push(parsed.severity); clauses.push(`severity = $${params.length}`); }
      if (parsed?.reporterId) {
        params.push(parsed.reporterId);
        clauses.push(`EXISTS (SELECT 1 FROM civicmerge.reports r WHERE r.incident_id = civicmerge.incidents.id AND r.reporter_id = $${params.length})`);
      }
      if (parsed?.q) {
        params.push(`%${parsed.q}%`);
        clauses.push(`(description ILIKE $${params.length} OR assigned_team ILIKE $${params.length} OR COALESCE(address, '') ILIKE $${params.length})`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      let pagination = '';
      if (parsed?.limit !== undefined) { params.push(parsed.limit); pagination += ` LIMIT $${params.length}`; }
      if (parsed?.offset !== undefined) { params.push(parsed.offset); pagination += ` OFFSET $${params.length}`; }
      const result = await pool.query(`SELECT * FROM civicmerge.incidents ${where} ORDER BY created_at DESC, id DESC${pagination}`, params);
      return result.rows.map(summary);
    },
    async count(filter?: Omit<IncidentListFilter, 'limit' | 'offset'>) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.type) { params.push(filter.type); clauses.push(`type = $${params.length}`); }
      if (filter?.status) { params.push(filter.status); clauses.push(`status = $${params.length}`); }
      if (filter?.severity) { params.push(filter.severity); clauses.push(`severity = $${params.length}`); }
      if (filter?.reporterId) {
        params.push(filter.reporterId);
        clauses.push(`EXISTS (SELECT 1 FROM civicmerge.reports r WHERE r.incident_id = civicmerge.incidents.id AND r.reporter_id = $${params.length})`);
      }
      if (filter?.q) {
        params.push(`%${filter.q}%`);
        clauses.push(`(description ILIKE $${params.length} OR assigned_team ILIKE $${params.length} OR COALESCE(address, '') ILIKE $${params.length})`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(`SELECT count(*)::int AS total FROM civicmerge.incidents ${where}`, params);
      return Number(result.rows[0]?.total ?? 0);
    },
    async listNearbyOpen(query: NearbyIncidentQuery) {
      const point = LocationSchema.parse(query.location);
      const bounds = boundingBoxFor(point, query.radiusMeters);
      const lngClause = bounds.wrapsAntimeridian
        ? '(longitude >= $4 OR longitude <= $5)'
        : 'longitude BETWEEN $4 AND $5';
      const result = await pool.query(
        `SELECT * FROM civicmerge.incidents
         WHERE type = $1 AND status <> 'resolved'
           AND latitude IS NOT NULL AND longitude IS NOT NULL
           AND latitude BETWEEN $2 AND $3 AND ${lngClause}
         ORDER BY created_at DESC, id DESC`,
        [query.type, bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng],
      );
      return result.rows.map(summary);
    },
    async get(id) {
      if (!IncidentSummarySchema.shape.id.safeParse(id).success) return null;
      // One consistent snapshot even while another connection is confirming.
      return transaction(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', client => readDetailInClient(client, id));
    },
    async confirm(input, assignedTeam, options) {
      const parsed = ConfirmRequestSchema.safeParse(input);
      if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu xác nhận không hợp lệ.', 400);
      const request = parsed.data;
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        // Global lock order: report -> target incident. Retries wait here.
        const locked = await client.query('SELECT * FROM civicmerge.reports WHERE id = $1 FOR UPDATE', [request.reportId]);
        if (!locked.rows[0]) throw new DomainError('REPORT_NOT_FOUND', 'Không tìm thấy báo cáo.', 404);
        const pending = report(locked.rows[0]);
        const prior = await client.query('SELECT * FROM civicmerge.confirmations WHERE report_id = $1', [request.reportId]);
        if (prior.rows[0]) {
          const saved = prior.rows[0];
          if (saved.action !== request.action || (request.action === 'merge' && saved.target_incident_id !== request.targetIncidentId.toLowerCase())) {
            throw new DomainError('REPORT_ALREADY_CONFIRMED', 'Báo cáo đã được xác nhận với lựa chọn khác.', 409);
          }
          return ConfirmResponseSchema.parse(saved.response);
        }
        if (pending.status !== 'pending') throw new Error('Confirmed report is missing its confirmation snapshot');

        let incident: QueryResultRow;
        if (request.action === 'merge') {
          const target = await client.query('SELECT * FROM civicmerge.incidents WHERE id = $1 FOR UPDATE', [request.targetIncidentId]);
          if (!target.rows[0]) throw new DomainError('INCIDENT_NOT_FOUND', 'Hồ sơ đích không tồn tại.', 404);
          if (target.rows[0].type !== pending.analysis.type) throw new DomainError('INCIDENT_TYPE_MISMATCH', 'Không thể hợp nhất hai loại sự cố khác nhau.', 409);
          if (target.rows[0].status === 'resolved') throw new DomainError('INCIDENT_RESOLVED', 'Hồ sơ đích đã được xử lý. Hãy tạo hồ sơ mới.', 409);
          const mergedFeatures = mergeFeatures(target.rows[0].features as string[], pending.analysis.features);
          const mergedSeverity = escalateSeverity(target.rows[0].severity as Severity, pending.analysis.severity);
          const updated = await client.query(`UPDATE civicmerge.incidents
            SET report_count = report_count + 1, features = $2, severity = $3, updated_at = clock_timestamp()
            WHERE id = $1 RETURNING *`, [request.targetIncidentId, mergedFeatures, mergedSeverity]);
          incident = updated.rows[0];
        } else {
          const created = options?.address
            ? await client.query(`INSERT INTO civicmerge.incidents
              (id, type, severity, description, features, latitude, longitude, address, assigned_team, report_count, cover_image_url)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10) RETURNING *`,
            [randomUUID(), pending.analysis.type, request.severity ?? pending.analysis.severity,
              request.description ?? pending.analysis.description, pending.analysis.features,
              pending.location?.latitude ?? null, pending.location?.longitude ?? null, options.address,
              assignedTeam, pending.imageUrl])
            : await client.query(`INSERT INTO civicmerge.incidents
              (id, type, severity, description, features, latitude, longitude, assigned_team, report_count, cover_image_url)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING *`,
            [randomUUID(), pending.analysis.type, request.severity ?? pending.analysis.severity,
              request.description ?? pending.analysis.description, pending.analysis.features,
              pending.location?.latitude ?? null, pending.location?.longitude ?? null, assignedTeam, pending.imageUrl]);
          incident = created.rows[0];
        }
        if (request.userNote) {
          await client.query("UPDATE civicmerge.reports SET incident_id = $1, status = 'confirmed', user_note = $3 WHERE id = $2", [incident.id, pending.id, request.userNote]);
        } else {
          await client.query("UPDATE civicmerge.reports SET incident_id = $1, status = 'confirmed' WHERE id = $2", [incident.id, pending.id]);
        }
        await client.query('INSERT INTO civicmerge.history (report_id, incident_id, event, at) VALUES ($1, $2, $3, $4)',
          [pending.id, incident.id, request.action === 'create' ? 'created' : 'report_merged', incident.updated_at]);
        const response = ConfirmResponseSchema.parse({
          incidentId: incident.id, action: request.action === 'create' ? 'created' : 'merged',
          reportCount: incident.report_count, assignedTeam: incident.assigned_team,
        });
        await client.query(`INSERT INTO civicmerge.confirmations
          (report_id, incident_id, action, target_incident_id, response, confirmed_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [pending.id, incident.id, request.action, request.action === 'merge' ? request.targetIncidentId : null,
          JSON.stringify(response), incident.updated_at]);
        return response;
      });
    },
    async updateStatus(id: string, input) {
      if (!IncidentSummarySchema.shape.id.safeParse(id).success) {
        throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
      }
      const { actorId, ...rest } = input;
      const parsed = UpdateIncidentStatusRequestSchema.safeParse(rest);
      if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu cập nhật trạng thái không hợp lệ.', 400);
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const locked = await client.query('SELECT * FROM civicmerge.incidents WHERE id = $1 FOR UPDATE', [id]);
        if (!locked.rows[0]) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
        const fromStatus = locked.rows[0].status as IncidentStatus;
        assertStatusTransition(fromStatus, parsed.data.status);
        const updated = await client.query(
          `UPDATE civicmerge.incidents
           SET status = $2,
               updated_at = clock_timestamp(),
               resolved_at = CASE WHEN $2 = 'resolved' THEN clock_timestamp() ELSE resolved_at END,
               resolution_note = CASE WHEN $2 = 'resolved' THEN COALESCE($3, resolution_note) ELSE resolution_note END
           WHERE id = $1 RETURNING updated_at`,
          [id, parsed.data.status, parsed.data.note ?? null],
        );
        await client.query(
          `INSERT INTO civicmerge.incident_events (id, incident_id, event, from_status, to_status, note, actor, actor_id, at)
           VALUES ($1, $2, 'status_changed', $3, $4, $5, $6, $7, $8)`,
          [randomUUID(), id, fromStatus, parsed.data.status, parsed.data.note ?? null, parsed.data.actor ?? null, actorId ?? null, updated.rows[0].updated_at],
        );
        const detail = await readDetailInClient(client, id);
        if (!detail) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
        return detail;
      });
    },
    async reassignTeam(id: string, input) {
      if (!IncidentSummarySchema.shape.id.safeParse(id).success) {
        throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
      }
      const { actorId, ...rest } = input;
      const parsed = ReassignTeamRequestSchema.safeParse(rest);
      if (!parsed.success) throw new DomainError('VALIDATION_ERROR', 'Yêu cầu đổi tổ xử lý không hợp lệ.', 400);
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const locked = await client.query('SELECT * FROM civicmerge.incidents WHERE id = $1 FOR UPDATE', [id]);
        if (!locked.rows[0]) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
        if (locked.rows[0].status === 'resolved') {
          throw new DomainError('INCIDENT_RESOLVED', 'Hồ sơ đã xử lý xong không thể đổi tổ phụ trách.', 409);
        }
        const previousTeam = String(locked.rows[0].assigned_team);
        const updated = await client.query(
          'UPDATE civicmerge.incidents SET assigned_team = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING updated_at',
          [id, parsed.data.assignedTeam],
        );
        const noteParts = [`Chuyển từ ${previousTeam} sang ${parsed.data.assignedTeam}`];
        if (parsed.data.note) noteParts.push(parsed.data.note);
        await client.query(
          `INSERT INTO civicmerge.incident_events (id, incident_id, event, note, actor, actor_id, at)
           VALUES ($1, $2, 'team_reassigned', $3, $4, $5, $6)`,
          [randomUUID(), id, noteParts.join(' · '), parsed.data.actor ?? null, actorId ?? null, updated.rows[0].updated_at],
        );
        const detail = await readDetailInClient(client, id);
        if (!detail) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
        return detail;
      });
    },
    async attachResolutionImage(id: string, imageUrl: string) {
      if (!IncidentSummarySchema.shape.id.safeParse(id).success) {
        throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
      }
      const validUrl = ReportSchema.shape.imageUrl.parse(imageUrl);
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const updated = await client.query(
          'UPDATE civicmerge.incidents SET resolution_image_url = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING id',
          [id, validUrl],
        );
        if (!updated.rows[0]) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
        const detail = await readDetailInClient(client, id);
        if (!detail) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ.', 404);
        return detail;
      });
    },
    async findAnalyzeIdempotency(key: string) {
      const result = await pool.query(
        'SELECT fingerprint, response FROM civicmerge.analyze_idempotency WHERE key = $1 AND expires_at > clock_timestamp()',
        [key],
      );
      if (!result.rows[0]) return null;
      return {
        fingerprint: String(result.rows[0].fingerprint),
        response: AnalyzeResponseSchema.parse(result.rows[0].response),
      };
    },
    async saveAnalyzeIdempotency(input) {
      const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
      await pool.query(
        `INSERT INTO civicmerge.analyze_idempotency (key, fingerprint, response, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
        [input.key, input.fingerprint, JSON.stringify(input.response), expiresAt],
      );
    },
    async registerPushToken(input) {
      await pool.query(
        `INSERT INTO civicmerge.push_tokens (id, user_id, expo_push_token, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (expo_push_token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = clock_timestamp()`,
        [randomUUID(), input.userId, input.token, input.platform],
      );
    },
    async listPushTokensForIncident(incidentId: string) {
      if (!IncidentSummarySchema.shape.id.safeParse(incidentId).success) return [];
      const result = await pool.query(
        `SELECT DISTINCT pt.expo_push_token
         FROM civicmerge.push_tokens pt
         JOIN civicmerge.reports r ON r.reporter_id = pt.user_id
         WHERE r.incident_id = $1`,
        [incidentId],
      );
      return result.rows.map(row => String(row.expo_push_token));
    },
    async listExpiredPendingReports(olderThanIso: string) {
      const result = await pool.query(
        `SELECT * FROM civicmerge.reports
         WHERE status = 'pending' AND incident_id IS NULL AND created_at < $1
         ORDER BY created_at ASC, id ASC`,
        [olderThanIso],
      );
      return result.rows.map(report);
    },
    async deletePendingReport(id: string) {
      if (!ReportSchema.shape.id.safeParse(id).success) return false;
      const result = await pool.query(
        "DELETE FROM civicmerge.reports WHERE id = $1 AND status = 'pending' AND incident_id IS NULL RETURNING id",
        [id],
      );
      return result.rows.length > 0;
    },
    async listRoutingRules() {
      const result = await pool.query(
        'SELECT * FROM civicmerge.routing_rules WHERE active = true ORDER BY priority DESC, created_at ASC',
      );
      return result.rows.map(row => RoutingRuleSchema.parse({
        id: row.id,
        incidentType: row.incident_type,
        teamName: row.team_name,
        priority: Number(row.priority),
        minLat: row.min_lat ?? null,
        maxLat: row.max_lat ?? null,
        minLng: row.min_lng ?? null,
        maxLng: row.max_lng ?? null,
        active: Boolean(row.active),
      }));
    },
    async createVolunteerEvent(input) {
      if (!IncidentSummarySchema.shape.id.safeParse(input.incidentId).success) {
        throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố.', 404);
      }
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const lockedIncident = await client.query('SELECT * FROM civicmerge.incidents WHERE id = $1 FOR UPDATE', [input.incidentId]);
        if (!lockedIncident.rows[0]) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố.', 404);
        const inc = lockedIncident.rows[0];
        assertIncidentSafeForVolunteer({
          type: inc.type as IncidentType,
          severity: inc.severity as Severity,
          status: inc.status as IncidentStatus,
        });
        const eventId = randomUUID();
        const initialCount = input.organizerId ? 1 : 0;
        let createdRow: QueryResultRow;
        try {
          const inserted = await client.query(
            `INSERT INTO civicmerge.volunteer_events (
               id, incident_id, title, description, scheduled_at, meeting_point,
               max_participants, participant_count, status, organizer_id, organizer_name, before_image_url
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'recruiting', $9, $10, $11)
             RETURNING *`,
            [
              eventId, input.incidentId, input.title, input.description, input.scheduledAt,
              input.meetingPoint, input.maxParticipants, initialCount,
              input.organizerId, input.organizerName, inc.cover_image_url,
            ],
          );
          createdRow = inserted.rows[0];
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (code === '23505') {
            throw new DomainError('VOLUNTEER_EVENT_EXISTS', 'Sự cố này đã có một Buổi Tình Nguyện Xanh đang diễn ra.', 409);
          }
          throw error;
        }
        if (input.organizerId) {
          await client.query(
            `INSERT INTO civicmerge.volunteer_participants (id, event_id, user_id, display_name, status, joined_at)
             VALUES ($1, $2, $3, $4, 'joined', $5)`,
            [randomUUID(), eventId, input.organizerId, input.organizerName, createdRow.created_at],
          );
        }
        await client.query(
          'UPDATE civicmerge.incidents SET updated_at = $2 WHERE id = $1',
          [input.incidentId, createdRow.created_at],
        );
        await client.query(
          `INSERT INTO civicmerge.incident_events (id, incident_id, event, note, actor, actor_id, at)
           VALUES ($1, $2, 'volunteer_event_created', $3, $4, $5, $6)`,
          [randomUUID(), input.incidentId, `Khởi tạo buổi tình nguyện: ${input.title}`, input.organizerName, input.organizerId, createdRow.created_at],
        );
        const detail = await readVolunteerDetailInClient(client, eventId);
        if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        return detail;
      });
    },
    async listVolunteerEvents(filter?: VolunteerEventListFilter) {
      const parsed = filter ? VolunteerEventListFilterSchema.parse(filter) : undefined;
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (parsed?.status) { params.push(parsed.status); clauses.push(`status = $${params.length}`); }
      if (parsed?.incidentId) { params.push(parsed.incidentId); clauses.push(`incident_id = $${params.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      let pagination = '';
      if (parsed?.limit !== undefined) { params.push(parsed.limit); pagination += ` LIMIT $${params.length}`; }
      if (parsed?.offset !== undefined) { params.push(parsed.offset); pagination += ` OFFSET $${params.length}`; }
      const result = await pool.query(
        `SELECT * FROM civicmerge.volunteer_events ${where} ORDER BY created_at DESC, id DESC${pagination}`,
        params,
      );
      return result.rows.map(volunteerEventRow);
    },
    async countVolunteerEvents(filter?: Omit<VolunteerEventListFilter, 'limit' | 'offset'>) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter?.status) { params.push(filter.status); clauses.push(`status = $${params.length}`); }
      if (filter?.incidentId) { params.push(filter.incidentId); clauses.push(`incident_id = $${params.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(`SELECT count(*)::int AS total FROM civicmerge.volunteer_events ${where}`, params);
      return Number(result.rows[0]?.total ?? 0);
    },
    async getVolunteerStats() {
      const result = await pool.query(`SELECT
        (SELECT count(*)::int FROM civicmerge.volunteer_events WHERE status = 'verified') AS verified_events,
        (SELECT count(*)::int FROM civicmerge.volunteer_certificates) AS total_certificates`);
      return {
        verifiedEvents: Number(result.rows[0]?.verified_events ?? 0),
        totalCertificates: Number(result.rows[0]?.total_certificates ?? 0),
      };
    },
    async getVolunteerEvent(id: string) {
      if (!VolunteerEventSchema.shape.id.safeParse(id).success) return null;
      return transaction(pool, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', client => readVolunteerDetailInClient(client, id));
    },
    async joinVolunteerEvent(eventId: string, input) {
      if (!VolunteerEventSchema.shape.id.safeParse(eventId).success) {
        throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      }
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const locked = await client.query('SELECT * FROM civicmerge.volunteer_events WHERE id = $1 FOR UPDATE', [eventId]);
        if (!locked.rows[0]) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        const ev = locked.rows[0];
        if (ev.status !== 'recruiting' && ev.status !== 'in_progress') {
          throw new DomainError('VOLUNTEER_EVENT_CLOSED', 'Buổi tình nguyện này đã đóng đăng ký.', 409);
        }
        const existing = await client.query(
          'SELECT * FROM civicmerge.volunteer_participants WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
          [eventId, input.userId],
        );
        if (existing.rows[0] && ['joined', 'checked_in', 'certified'].includes(String(existing.rows[0].status))) {
          const detail = await readVolunteerDetailInClient(client, eventId);
          if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
          return detail;
        }
        if (Number(ev.participant_count) >= Number(ev.max_participants)) {
          throw new DomainError('VOLUNTEER_EVENT_FULL', 'Buổi tình nguyện đã đủ số lượng người tham gia.', 409);
        }
        if (existing.rows[0]) {
          await client.query(
            `UPDATE civicmerge.volunteer_participants
             SET status = 'joined', display_name = $3, joined_at = clock_timestamp()
             WHERE event_id = $1 AND user_id = $2`,
            [eventId, input.userId, input.displayName],
          );
        } else {
          await client.query(
            `INSERT INTO civicmerge.volunteer_participants (id, event_id, user_id, display_name, status)
             VALUES ($1, $2, $3, $4, 'joined')`,
            [randomUUID(), eventId, input.userId, input.displayName],
          );
        }
        await client.query(
          'UPDATE civicmerge.volunteer_events SET participant_count = participant_count + 1, updated_at = clock_timestamp() WHERE id = $1',
          [eventId],
        );
        const detail = await readVolunteerDetailInClient(client, eventId);
        if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        return detail;
      });
    },
    async leaveVolunteerEvent(eventId: string, userId: string) {
      if (!VolunteerEventSchema.shape.id.safeParse(eventId).success) {
        throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      }
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const locked = await client.query('SELECT * FROM civicmerge.volunteer_events WHERE id = $1 FOR UPDATE', [eventId]);
        if (!locked.rows[0]) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        const ev = locked.rows[0];
        if (ev.status === 'verified' || ev.status === 'pending_review') {
          throw new DomainError('VOLUNTEER_EVENT_CLOSED', 'Không thể hủy tham gia khi buổi tình nguyện đang chờ duyệt hoặc đã hoàn tất.', 409);
        }
        const updatedParticipant = await client.query(
          `UPDATE civicmerge.volunteer_participants
           SET status = 'cancelled'
           WHERE event_id = $1 AND user_id = $2 AND status IN ('joined', 'checked_in')
           RETURNING id`,
          [eventId, userId],
        );
        if (updatedParticipant.rows.length > 0) {
          await client.query(
            'UPDATE civicmerge.volunteer_events SET participant_count = GREATEST(0, participant_count - 1), updated_at = clock_timestamp() WHERE id = $1',
            [eventId],
          );
        }
        const detail = await readVolunteerDetailInClient(client, eventId);
        if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        return detail;
      });
    },
    async submitVolunteerAfterImage(eventId: string, input) {
      if (!VolunteerEventSchema.shape.id.safeParse(eventId).success) {
        throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      }
      const validUrl = ReportSchema.shape.imageUrl.parse(input.imageUrl);
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const locked = await client.query('SELECT * FROM civicmerge.volunteer_events WHERE id = $1 FOR UPDATE', [eventId]);
        if (!locked.rows[0]) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        const ev = locked.rows[0];
        if (ev.status === 'verified' || ev.status === 'cancelled') {
          throw new DomainError('VOLUNTEER_EVENT_CLOSED', 'Buổi tình nguyện đã kết thúc, không thể nộp ảnh Sau.', 409);
        }
        const updated = await client.query(
          `UPDATE civicmerge.volunteer_events
           SET after_image_url = $2, status = 'pending_review', review_note = NULL, updated_at = clock_timestamp()
           WHERE id = $1 RETURNING updated_at`,
          [eventId, validUrl],
        );
        await client.query(
          'UPDATE civicmerge.incidents SET updated_at = $2 WHERE id = $1',
          [ev.incident_id, updated.rows[0].updated_at],
        );
        await client.query(
          `INSERT INTO civicmerge.incident_events (id, incident_id, event, note, actor, actor_id, at)
           VALUES ($1, $2, 'volunteer_after_submitted', $3, $4, $5, $6)`,
          [randomUUID(), ev.incident_id, `Đã nộp ảnh Sau hoàn thành cho buổi "${ev.title}"`, input.actor ?? null, input.actorId ?? null, updated.rows[0].updated_at],
        );
        const detail = await readVolunteerDetailInClient(client, eventId);
        if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        return detail;
      });
    },
    async reviewVolunteerEvent(eventId: string, input) {
      if (!VolunteerEventSchema.shape.id.safeParse(eventId).success) {
        throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
      }
      return transaction(pool, 'BEGIN ISOLATION LEVEL READ COMMITTED', async client => {
        const locked = await client.query('SELECT * FROM civicmerge.volunteer_events WHERE id = $1 FOR UPDATE', [eventId]);
        if (!locked.rows[0]) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        const ev = locked.rows[0];
        if (ev.status === 'verified' || ev.status === 'cancelled') {
          throw new DomainError('VOLUNTEER_EVENT_ALREADY_REVIEWED', 'Buổi tình nguyện này đã được xử lý xong trước đó.', 409);
        }
        const reviewerName = input.actor?.trim() || 'Ban quản lý GreenMerge';
        if (input.decision === 'reject') {
          const rejectNote = input.note ?? 'Cần bổ sung ảnh Sau khi hoàn thành rõ nét hơn.';
          await client.query(
            `UPDATE civicmerge.volunteer_events
             SET status = 'in_progress', review_note = $2, reviewed_by = $3, reviewed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1`,
            [eventId, rejectNote, reviewerName],
          );
          const detail = await readVolunteerDetailInClient(client, eventId);
          if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
          return { event: detail, certificates: [] };
        }
        if (!ev.after_image_url) {
          throw new DomainError('AFTER_IMAGE_REQUIRED', 'Cần có ảnh Sau khi hoàn thành trước khi phê duyệt buổi tình nguyện.', 409);
        }
        const lockedIncident = await client.query('SELECT * FROM civicmerge.incidents WHERE id = $1 FOR UPDATE', [ev.incident_id]);
        if (!lockedIncident.rows[0]) throw new DomainError('INCIDENT_NOT_FOUND', 'Không tìm thấy hồ sơ sự cố liên kết.', 404);
        const fromStatus = lockedIncident.rows[0].status as IncidentStatus;
        const updatedEv = await client.query(
          `UPDATE civicmerge.volunteer_events
           SET status = 'verified', review_note = $2, reviewed_by = $3, reviewed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = $1 RETURNING reviewed_at`,
          [eventId, input.note ?? null, reviewerName],
        );
        const reviewedAt: Date = updatedEv.rows[0].reviewed_at;
        const resolutionNote = input.note ?? `Đã xử lý bởi Buổi Tình Nguyện Xanh: ${ev.title}`;
        await client.query(
          `UPDATE civicmerge.incidents
           SET status = 'resolved',
               resolution_image_url = $2,
               resolution_note = $3,
               resolved_at = COALESCE(resolved_at, $4),
               updated_at = $4
           WHERE id = $1`,
          [ev.incident_id, ev.after_image_url, resolutionNote, reviewedAt],
        );
        await client.query(
          `INSERT INTO civicmerge.incident_events (id, incident_id, event, from_status, to_status, note, actor, actor_id, at)
           VALUES ($1, $2, 'volunteer_verified', $3, 'resolved', $4, $5, $6, $7)`,
          [randomUUID(), ev.incident_id, fromStatus, resolutionNote, reviewerName, input.actorId ?? null, reviewedAt],
        );
        const certificates: VolunteerCertificate[] = [];
        if (input.issueCertificates !== false) {
          const year = reviewedAt.getUTCFullYear();
          const eligible = await client.query(
            `SELECT * FROM civicmerge.volunteer_participants
             WHERE event_id = $1 AND status IN ('joined', 'checked_in')
             ORDER BY joined_at ASC, id ASC FOR UPDATE`,
            [eventId],
          );
          for (const participant of eligible.rows) {
            let insertedCert: QueryResultRow | undefined;
            for (let attempt = 0; attempt < 10; attempt += 1) {
              const code = generateCertificateCode(year);
              try {
                const certRes = await client.query(
                  `INSERT INTO civicmerge.volunteer_certificates (
                     id, certificate_code, event_id, event_title, incident_id,
                     user_id, recipient_name, completed_at, issued_by, issued_at
                   )
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8)
                   ON CONFLICT (event_id, user_id) DO NOTHING
                   RETURNING *`,
                  [
                    randomUUID(), code, eventId, ev.title, ev.incident_id,
                    participant.user_id, participant.display_name, reviewedAt, reviewerName,
                  ],
                );
                insertedCert = certRes.rows[0];
                break;
              } catch (error) {
                const pgCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
                if (pgCode === '23505') continue;
                throw error;
              }
            }
            if (insertedCert) certificates.push(volunteerCertificateRow(insertedCert));
          }
          await client.query(
            `UPDATE civicmerge.volunteer_participants
             SET status = 'certified'
             WHERE event_id = $1 AND status IN ('joined', 'checked_in')`,
            [eventId],
          );
        }
        const detail = await readVolunteerDetailInClient(client, eventId);
        if (!detail) throw new DomainError('VOLUNTEER_EVENT_NOT_FOUND', 'Không tìm thấy buổi tình nguyện.', 404);
        return { event: detail, certificates };
      });
    },
    async listCertificatesByUser(userId: string) {
      if (!ReportSchema.shape.id.safeParse(userId).success) return [];
      const result = await pool.query(
        'SELECT * FROM civicmerge.volunteer_certificates WHERE user_id = $1 ORDER BY issued_at DESC, id DESC',
        [userId],
      );
      return result.rows.map(volunteerCertificateRow);
    },
    async findCertificateByCode(code: string) {
      const normalized = code.trim().toUpperCase();
      if (!normalized) return null;
      const result = await pool.query(
        'SELECT * FROM civicmerge.volunteer_certificates WHERE UPPER(certificate_code) = $1',
        [normalized],
      );
      return result.rows[0] ? volunteerCertificateRow(result.rows[0]) : null;
    },
    async listPushTokensForVolunteerEvent(eventId: string) {
      if (!VolunteerEventSchema.shape.id.safeParse(eventId).success) return [];
      const result = await pool.query(
        `SELECT DISTINCT pt.expo_push_token
         FROM civicmerge.push_tokens pt
         JOIN civicmerge.volunteer_participants vp ON vp.user_id = pt.user_id
         WHERE vp.event_id = $1 AND vp.status IN ('joined', 'checked_in', 'certified')`,
        [eventId],
      );
      return result.rows.map(row => String(row.expo_push_token));
    },
    async reset() { throw new DomainError('RESET_DISABLED', 'Không được reset dữ liệu PostgreSQL qua ứng dụng.', 403); },
  };
}
