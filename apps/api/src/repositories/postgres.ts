import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { PendingReportWriteRejected } from './errors.js';
import { assertStatusTransition, boundingBoxFor, escalateSeverity, mergeFeatures } from './bounds.js';
import {
  AIAnalysisSchema, AnalyzeResponseSchema, ConfirmRequestSchema, ConfirmResponseSchema, DomainError,
  IncidentDetailSchema, IncidentListFilterSchema, IncidentSummarySchema, LocationSchema,
  ReassignTeamRequestSchema, ReportSchema, RoutingRuleSchema, UpdateIncidentStatusRequestSchema,
  type HistoryEvent, type IncidentListFilter, type IncidentRepository, type IncidentStatus,
  type NearbyIncidentQuery, type Severity,
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
    async reset() { throw new DomainError('RESET_DISABLED', 'Không được reset dữ liệu PostgreSQL qua ứng dụng.', 403); },
  };
}
