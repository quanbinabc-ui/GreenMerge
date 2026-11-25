import type {
  IncidentDetail,
  IncidentStatus,
  IncidentSummary,
  IncidentType,
  Severity,
  VolunteerEvent,
  VolunteerEventDetail,
  VolunteerEventStatus,
  VolunteerStats,
} from '@civicmerge/contracts';
import { createAdminClient, type AdminConnection } from './api.js';
import {
  allowedNextStatuses,
  computeKpis,
  escapeHtml,
  formatDateTime,
  googleMapsUrl,
  PARTICIPANT_STATUS_LABELS,
  projectHotspots,
  SEVERITY_LABELS,
  sortQueueByPriority,
  sortVolunteerEventsForReview,
  STATUS_LABELS,
  statusStepIndex,
  TYPE_LABELS,
  VOLUNTEER_STATUS_LABELS,
} from './state.js';

const STORAGE_KEY = 'civicmerge_admin_session_v2';
const THEME_KEY = 'civicmerge_admin_theme_v1';
const PAGE_SIZE = 20;

interface UiState {
  connection: AdminConnection;
  connected: boolean;
  healthText: string;
  incidents: IncidentSummary[];
  total: number;
  offset: number;
  selectedId: string | null;
  detail: IncidentDetail | null;
  volunteerEvents: VolunteerEvent[];
  volunteerTotal: number;
  volunteerStats: VolunteerStats;
  volunteerStatusFilter: VolunteerEventStatus | '';
  selectedVolunteerId: string | null;
  volunteerDetail: VolunteerEventDetail | null;
  activeView: 'list' | 'map' | 'volunteer';
  activeDetailTab: 'actions' | 'evidence' | 'history';
  authInputMode: 'email' | 'key';
  typeFilter: IncidentType | '';
  statusFilter: IncidentStatus | '';
  severityFilter: Severity | '';
  searchText: string;
  error: string;
  notice: string;
  busy: boolean;
}

function loadSavedConnection(): AdminConnection {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AdminConnection>;
      if (typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()) {
        return {
          baseUrl: parsed.baseUrl,
          operatorKey: parsed.operatorKey ?? '',
          bearerToken: parsed.bearerToken ?? '',
          userLabel: parsed.userLabel ?? '',
        };
      }
    }
  } catch {
    // Ignore storage read issues.
  }
  return { baseUrl: 'http://127.0.0.1:3055', operatorKey: '', bearerToken: '', userLabel: '' };
}

function saveConnection(connection: AdminConnection): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
  } catch {
    // Ignore storage write issues.
  }
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Ignore storage write issues.
  }
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️ Giao diện sáng' : '🌙 Giao diện tối';
}

const state: UiState = {
  connection: loadSavedConnection(),
  connected: false,
  healthText: 'Chưa kết nối máy chủ',
  incidents: [],
  total: 0,
  offset: 0,
  selectedId: null,
  detail: null,
  volunteerEvents: [],
  volunteerTotal: 0,
  volunteerStats: { verifiedEvents: 0, totalCertificates: 0 },
  volunteerStatusFilter: '',
  selectedVolunteerId: null,
  volunteerDetail: null,
  activeView: 'list',
  activeDetailTab: 'actions',
  authInputMode: 'email',
  typeFilter: '',
  statusFilter: '',
  severityFilter: '',
  searchText: '',
  error: '',
  notice: '',
  busy: false,
};

function getClient() {
  return createAdminClient(state.connection);
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function renderBanner() {
  const box = byId<HTMLDivElement>('feedback-box');
  if (state.error) {
    box.className = 'feedback error';
    box.textContent = state.error;
  } else if (state.notice) {
    box.className = 'feedback success';
    box.textContent = state.notice;
  } else {
    box.className = 'feedback hidden';
    box.textContent = '';
  }
}

function renderKpis() {
  const kpis = computeKpis(state.incidents);
  byId('kpi-open').textContent = String(kpis.openCount);
  byId('kpi-progress').textContent = String(kpis.inProgressCount);
  byId('kpi-resolved').textContent = String(kpis.resolvedCount);
  byId('kpi-reports').textContent = `${kpis.totalReports} ảnh`;
  byId('kpi-merge-sub').textContent = `${kpis.duplicateReductionRate}% báo cáo trùng đã được hợp nhất`;
  byId('kpi-volunteer-verified').textContent = `${state.volunteerStats.verifiedEvents} buổi`;
  byId('kpi-volunteer-certs').textContent = `${state.volunteerStats.totalCertificates} chứng nhận đã cấp`;

  const pill = byId('health-status');
  pill.className = `health-pill ${state.connected ? 'online' : 'offline'}`;
  const userSuffix = state.connection.userLabel ? ` · ${state.connection.userLabel}` : '';
  byId('health-label').textContent = `${state.healthText}${userSuffix}`;

  const signedInBar = byId('signed-in-bar');
  if (state.connection.bearerToken) {
    signedInBar.classList.remove('hidden');
    byId('signed-in-label').textContent = `Đang dùng phiên JWT${state.connection.userLabel ? ` (${state.connection.userLabel})` : ''}`;
  } else {
    signedInBar.classList.add('hidden');
  }
}

function renderViews() {
  const isList = state.activeView === 'list';
  const isMap = state.activeView === 'map';
  const isVolunteer = state.activeView === 'volunteer';
  byId('view-list').classList.toggle('hidden', !isList);
  byId('view-map').classList.toggle('hidden', !isMap);
  byId('view-volunteer').classList.toggle('hidden', !isVolunteer);
  byId('incident-filter-bar').classList.toggle('hidden', isVolunteer);
  byId('volunteer-filter-bar').classList.toggle('hidden', !isVolunteer);
  byId('search-form').classList.toggle('hidden', isVolunteer);
  byId('tab-list').classList.toggle('active', isList);
  byId('tab-map').classList.toggle('active', isMap);
  byId('tab-volunteer').classList.toggle('active', isVolunteer);
  byId('tab-list').setAttribute('aria-selected', String(isList));
  byId('tab-map').setAttribute('aria-selected', String(isMap));
  byId('tab-volunteer').setAttribute('aria-selected', String(isVolunteer));
  renderQueue();
  renderHotspotMap();
  renderVolunteerQueue();
}

function renderVolunteerQueue() {
  const tbody = byId<HTMLTableSectionElement>('volunteer-body');
  const sorted = sortVolunteerEventsForReview(state.volunteerEvents);
  byId('volunteer-summary-badge').textContent = `${sorted.length} / ${state.volunteerTotal} buổi tình nguyện`;
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Chưa có Buổi Tình Nguyện Xanh nào phù hợp bộ lọc.</td></tr>';
    return;
  }
  const client = getClient();
  tbody.innerHTML = sorted.map((ev) => {
    const selected = ev.id === state.selectedVolunteerId ? 'selected' : '';
    const beforeThumb = client.imageDisplayUrl(ev.beforeImageUrl);
    const afterThumb = ev.afterImageUrl ? client.imageDisplayUrl(ev.afterImageUrl) : null;
    return `
      <tr class="queue-row ${selected}" data-vid="${escapeHtml(ev.id)}">
        <td>
          <div class="thumb-pair">
            <img class="row-thumb" src="${escapeHtml(beforeThumb)}" alt="Ảnh Trước" />
            ${afterThumb
              ? `<img class="row-thumb" src="${escapeHtml(afterThumb)}" alt="Ảnh Sau" />`
              : '<span class="thumb-placeholder">Chưa có<br/>ảnh Sau</span>'}
          </div>
        </td>
        <td>
          <div class="desc-cell">${escapeHtml(ev.title)}</div>
          <div class="sub-cell">📍 ${escapeHtml(ev.meetingPoint)} · Trưởng nhóm: ${escapeHtml(ev.organizerName)}</div>
          <div class="sub-cell">Lịch: ${escapeHtml(formatDateTime(ev.scheduledAt))}</div>
        </td>
        <td>
          <span class="badge vstatus-${ev.status}">${escapeHtml(VOLUNTEER_STATUS_LABELS[ev.status])}</span>
        </td>
        <td class="num-cell"><span class="count-pill">${ev.participantCount}/${ev.maxParticipants} TNV</span></td>
        <td class="sub-cell">${escapeHtml(formatDateTime(ev.updatedAt))}</td>
      </tr>
    `;
  }).join('');
  tbody.querySelectorAll<HTMLTableRowElement>('tr[data-vid]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.vid;
      if (id) void loadVolunteerDetail(id);
    });
  });
}

function renderQueue() {
  const tbody = byId<HTMLTableSectionElement>('queue-body');
  const sorted = sortQueueByPriority(state.incidents);
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Không có hồ sơ sự cố phù hợp. Bấm "Kết nối &amp; Đăng nhập" để tải dữ liệu.</td></tr>';
  } else {
    const client = getClient();
    tbody.innerHTML = sorted.map((item) => {
      const selected = item.id === state.selectedId ? 'selected' : '';
      const thumb = client.imageDisplayUrl(item.coverImageUrl);
      return `
        <tr class="queue-row ${selected}" data-id="${escapeHtml(item.id)}">
          <td><img class="row-thumb" src="${escapeHtml(thumb)}" alt="${escapeHtml(TYPE_LABELS[item.type])}" /></td>
          <td>
            <div class="badge-stack">
              <span class="badge type-${item.type}">${escapeHtml(TYPE_LABELS[item.type])}</span>
              <span class="badge sev-${item.severity}">${escapeHtml(SEVERITY_LABELS[item.severity])}</span>
              <span class="badge status-${item.status}">${escapeHtml(STATUS_LABELS[item.status])}</span>
            </div>
          </td>
          <td>
            <div class="desc-cell">${escapeHtml(item.description)}</div>
            <div class="sub-cell">${escapeHtml(item.address || item.assignedTeam)}</div>
            ${item.address ? `<div class="sub-cell">${escapeHtml(item.assignedTeam)}</div>` : ''}
          </td>
          <td class="num-cell"><span class="count-pill">${item.reportCount} ảnh</span></td>
          <td class="sub-cell">${escapeHtml(formatDateTime(item.updatedAt))}</td>
        </tr>
      `;
    }).join('');
    tbody.querySelectorAll<HTMLTableRowElement>('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        if (id) void loadDetail(id);
      });
    });
  }
  const pageInfo = byId('pagination-info');
  const start = state.total === 0 ? 0 : state.offset + 1;
  const end = Math.min(state.total, state.offset + state.incidents.length);
  pageInfo.textContent = `Hiển thị ${start}–${end} / ${state.total} hồ sơ`;
  byId<HTMLButtonElement>('btn-prev').disabled = state.busy || state.offset === 0;
  byId<HTMLButtonElement>('btn-next').disabled = state.busy || state.offset + PAGE_SIZE >= state.total;
}

function renderHotspotMap() {
  const canvas = byId<HTMLDivElement>('hotspot-canvas');
  const points = projectHotspots(state.incidents);
  if (points.length === 0) {
    canvas.innerHTML = '<div class="empty-detail">Chưa có hồ sơ nào kèm tọa độ GPS để hiển thị trên bản đồ điểm nóng.</div>';
    return;
  }
  canvas.innerHTML = points.map(({ incident, xPercent, yPercent, radius }) => {
    const size = radius * 2;
    const selected = incident.id === state.selectedId ? 'selected' : '';
    const title = `${TYPE_LABELS[incident.type]} (${STATUS_LABELS[incident.status]}) · ${incident.reportCount} minh chứng — ${incident.address || incident.description}`;
    return `
      <button
        type="button"
        class="map-pin pin-${incident.status} ${selected}"
        data-pin-id="${escapeHtml(incident.id)}"
        title="${escapeHtml(title)}"
        style="left:${xPercent}%;top:${yPercent}%;width:${size}px;height:${size}px;"
      >${incident.reportCount}</button>
    `;
  }).join('');
  canvas.querySelectorAll<HTMLButtonElement>('button[data-pin-id]').forEach((pin) => {
    pin.addEventListener('click', () => {
      const id = pin.dataset.pinId;
      if (id) void loadDetail(id);
    });
  });
}

function renderVolunteerDetail() {
  const panel = byId<HTMLDivElement>('detail-panel');
  const detail = state.volunteerDetail;
  if (!detail) {
    panel.innerHTML = '<div class="empty-detail">Chọn một Buổi Tình Nguyện Xanh bên trái để đối chiếu ảnh Trước/Sau, kiểm tra danh sách sinh viên và phê duyệt cấp Giấy chứng nhận.</div>';
    return;
  }
  const client = getClient();
  const beforeUrl = client.imageDisplayUrl(detail.beforeImageUrl);
  const afterUrl = detail.afterImageUrl ? client.imageDisplayUrl(detail.afterImageUrl) : null;
  const activeParticipants = detail.participants.filter(p => p.status !== 'cancelled');
  const canReview = detail.status !== 'verified' && detail.status !== 'cancelled';

  panel.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>🌿 ${escapeHtml(detail.title)}</h2>
        <div class="badge-stack">
          <span class="badge vstatus-${detail.status}">${escapeHtml(VOLUNTEER_STATUS_LABELS[detail.status])}</span>
          <span class="badge type-${detail.incidentSummary.type}">${escapeHtml(TYPE_LABELS[detail.incidentSummary.type])}</span>
          <span class="badge sev-${detail.incidentSummary.severity}">Mức độ: ${escapeHtml(SEVERITY_LABELS[detail.incidentSummary.severity])}</span>
        </div>
      </div>
      <span class="count-pill">${detail.participantCount}/${detail.maxParticipants} TNV</span>
    </div>

    ${detail.description ? `<p class="detail-desc">${escapeHtml(detail.description)}</p>` : ''}

    <div class="meta-grid">
      <div><strong>Trưởng nhóm:</strong> ${escapeHtml(detail.organizerName)}</div>
      <div><strong>Điểm tập trung:</strong> ${escapeHtml(detail.meetingPoint)}</div>
      <div><strong>Thời gian dự kiến:</strong> ${escapeHtml(formatDateTime(detail.scheduledAt))}</div>
      <div><strong>Sự cố liên kết:</strong> #${escapeHtml(detail.incidentSummary.id.slice(0, 8).toUpperCase())} — ${escapeHtml(detail.incidentSummary.description)} (${escapeHtml(STATUS_LABELS[detail.incidentSummary.status])})</div>
      ${detail.reviewedBy ? `<div><strong>Người đánh giá:</strong> ${escapeHtml(detail.reviewedBy)}${detail.reviewedAt ? ` · ${escapeHtml(formatDateTime(detail.reviewedAt))}` : ''}</div>` : ''}
      ${detail.reviewNote ? `<div><strong>Nhận xét gần nhất:</strong> ${escapeHtml(detail.reviewNote)}</div>` : ''}
    </div>

    <div class="before-after-grid">
      <figure class="ba-card">
        <img class="evidence-img zoomable" src="${escapeHtml(beforeUrl)}" alt="Ảnh Trước — Sự cố gốc" />
        <figcaption>
          <span>📷 Ảnh TRƯỚC (Sự cố gốc)</span>
          <span class="sub-cell">Phóng to</span>
        </figcaption>
      </figure>
      <figure class="ba-card">
        ${afterUrl
          ? `<img class="evidence-img zoomable" src="${escapeHtml(afterUrl)}" alt="Ảnh Sau — Tình nguyện viên nộp" />`
          : '<div class="ba-empty">Chưa có ảnh Sau khi hoàn thành do nhóm tình nguyện viên nộp.</div>'}
        <figcaption>
          <span>✨ Ảnh SAU (TNV nộp)</span>
          <span class="sub-cell">${afterUrl ? 'Phóng to' : 'Chờ nộp'}</span>
        </figcaption>
      </figure>
    </div>

    <div class="action-card">
      <h3>Danh sách sinh viên tham gia (${activeParticipants.length})</h3>
      ${activeParticipants.length === 0
        ? '<p class="sub-cell">Chưa có sinh viên nào đăng ký tham gia.</p>'
        : `
          <ul class="participant-list">
            ${activeParticipants.map(p => `
              <li class="participant-item">
                <div>
                  <strong>${escapeHtml(p.displayName)}</strong>
                  <div class="sub-cell">Tham gia lúc ${escapeHtml(formatDateTime(p.joinedAt))}</div>
                </div>
                <div class="badge-stack">
                  <span class="badge ${p.status === 'certified' ? 'status-resolved' : 'status-open'}">${escapeHtml(PARTICIPANT_STATUS_LABELS[p.status])}</span>
                  ${p.certificateCode ? `<span class="cert-code">${escapeHtml(p.certificateCode)}</span>` : ''}
                </div>
              </li>
            `).join('')}
          </ul>
        `}
    </div>

    <div class="action-card">
      <h3>Đánh giá &amp; Cấp Giấy chứng nhận Tình nguyện Xanh</h3>
      ${canReview ? `
        <form id="volunteer-review-form" class="stack-form">
          <input id="vreview-actor" type="text" value="${escapeHtml(state.connection.userLabel ?? '')}" placeholder="Cán bộ duyệt (ví dụ: Ban quản lý GreenMerge)" maxlength="120" />
          <textarea id="vreview-note" rows="2" placeholder="Nhận xét chất lượng dọn dẹp hoặc yêu cầu chụp lại ảnh rõ nét..." maxlength="500"></textarea>
          <div class="review-actions">
            <button id="btn-volunteer-approve" type="button" class="btn success" ${!afterUrl ? 'disabled title="Cần có ảnh Sau trước khi phê duyệt"' : ''}>✓ Phê duyệt, Đóng hồ sơ &amp; Cấp chứng nhận</button>
            <button id="btn-volunteer-reject" type="button" class="btn danger-outline">✕ Yêu cầu bổ sung</button>
          </div>
          ${!afterUrl ? '<p class="sub-cell">Nút Phê duyệt sẽ bật khi tình nguyện viên nộp ảnh Sau khi hoàn thành.</p>' : ''}
        </form>
      ` : `
        <div class="resolved-card">
          <strong>${detail.status === 'verified' ? '✓ Buổi Tình nguyện Xanh đã được phê duyệt, sự cố đã đóng và chứng nhận đã phát hành.' : 'Buổi tình nguyện đã bị hủy.'}</strong>
        </div>
      `}
    </div>
  `;

  panel.querySelectorAll<HTMLImageElement>('.zoomable').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.src, img.alt));
  });

  const approveBtn = document.getElementById('btn-volunteer-approve') as HTMLButtonElement | null;
  const rejectBtn = document.getElementById('btn-volunteer-reject') as HTMLButtonElement | null;
  const submitReview = (decision: 'approve' | 'reject') => {
    const actor = (document.getElementById('vreview-actor') as HTMLInputElement | null)?.value.trim() ?? '';
    const note = (document.getElementById('vreview-note') as HTMLTextAreaElement | null)?.value.trim() ?? '';
    void runAction(async () => {
      const response = await getClient().reviewVolunteerEvent(detail.id, {
        decision,
        ...(actor ? { actor } : {}),
        ...(note ? { note } : {}),
        issueCertificates: true,
      });
      state.volunteerDetail = response.event;
      state.notice = decision === 'approve'
        ? `Đã phê duyệt buổi "${detail.title}", đóng hồ sơ sự cố và cấp ${response.certificatesIssued} Giấy chứng nhận Tình nguyện Xanh.`
        : `Đã gửi yêu cầu bổ sung cho buổi "${detail.title}".`;
      await Promise.all([loadQueue(), loadVolunteerEvents()]);
    });
  };
  approveBtn?.addEventListener('click', () => submitReview('approve'));
  rejectBtn?.addEventListener('click', () => submitReview('reject'));
}

function renderDetail() {
  if (state.activeView === 'volunteer') {
    renderVolunteerDetail();
    return;
  }
  const panel = byId<HTMLDivElement>('detail-panel');
  const detail = state.detail;
  if (!detail) {
    panel.innerHTML = '<div class="empty-detail">Chọn một hồ sơ sự cố ở danh sách hoặc bản đồ điểm nóng để xem chi tiết, đối chiếu minh chứng và điều phối xử lý.</div>';
    return;
  }
  const client = getClient();
  const nextStatuses = allowedNextStatuses(detail.status);
  const mapsLink = googleMapsUrl(detail.location);
  const proofUrl = detail.resolutionImageUrl ? client.imageDisplayUrl(detail.resolutionImageUrl) : null;
  const stepIdx = statusStepIndex(detail.status);
  const stepClass = (index: number) => (index < stepIdx ? 'done' : index === stepIdx ? 'active' : '');

  const actionsHtml = `
    ${detail.status === 'resolved' ? `
      <div class="resolved-card">
        <strong>Đã hoàn thành xử lý${detail.resolvedAt ? ` lúc ${escapeHtml(formatDateTime(detail.resolvedAt))}` : ''}</strong>
        ${detail.resolutionNote ? `<p>${escapeHtml(detail.resolutionNote)}</p>` : ''}
        ${proofUrl ? `<img class="evidence-img zoomable" src="${escapeHtml(proofUrl)}" alt="Ảnh nghiệm thu sau xử lý" />` : ''}
      </div>
    ` : ''}

    <div class="action-card">
      <h3>Chuyển trạng thái xử lý</h3>
      ${nextStatuses.length === 0
        ? '<p class="sub-cell">Hồ sơ đã ở trạng thái kết thúc (Đã xử lý).</p>'
        : `
          <form id="status-form" class="stack-form">
            <select id="next-status" required>
              ${nextStatuses.map(st => `<option value="${st}">${escapeHtml(STATUS_LABELS[st])}</option>`).join('')}
            </select>
            <input id="status-actor" type="text" value="${escapeHtml(state.connection.userLabel ?? '')}" placeholder="Người thực hiện (ví dụ: Tổ trưởng đường bộ)" maxlength="120" />
            <textarea id="status-note" rows="2" placeholder="Ghi chú tiến độ hoặc kết quả xử lý..." maxlength="500"></textarea>
            <button type="submit" class="btn primary">Cập nhật trạng thái</button>
          </form>
        `}
    </div>

    <div class="action-card">
      <h3>Ảnh nghiệm thu sau sửa chữa</h3>
      <form id="proof-form" class="stack-form">
        <input id="proof-file" type="file" accept="image/jpeg,image/png,image/webp" required />
        <button type="submit" class="btn secondary">Tải lên ảnh nghiệm thu</button>
      </form>
    </div>

    ${detail.status !== 'resolved' ? `
      <div class="action-card">
        <h3>Điều phối tổ phụ trách</h3>
        <form id="team-form" class="stack-form">
          <input id="new-team" type="text" value="${escapeHtml(detail.assignedTeam)}" placeholder="Tên tổ xử lý mới" required maxlength="120" />
          <input id="team-note" type="text" placeholder="Lý do chuyển tổ (tùy chọn)" maxlength="500" />
          <button type="submit" class="btn secondary">Lưu đơn vị phụ trách</button>
        </form>
      </div>
    ` : ''}
  `;

  const evidenceHtml = `
    <div class="evidence-grid">
      ${detail.reports.map((rep, idx) => {
        const url = client.imageDisplayUrl(rep.imageUrl);
        return `
          <figure class="evidence-card">
            <img class="evidence-img zoomable" src="${escapeHtml(url)}" alt="Minh chứng #${idx + 1}" />
            <figcaption>
              <div><strong>Minh chứng #${idx + 1}</strong> · ${escapeHtml(formatDateTime(rep.createdAt))}</div>
              <div>${escapeHtml(rep.analysis.description)}</div>
              ${rep.userNote ? `<div class="user-note">Ghi chú: ${escapeHtml(rep.userNote)}</div>` : ''}
            </figcaption>
          </figure>
        `;
      }).join('')}
    </div>
  `;

  const historyHtml = `
    <ul class="timeline-list">
      ${detail.history.map((ev) => `
        <li>
          <strong>${escapeHtml(ev.event)}</strong>
          ${ev.fromStatus && ev.toStatus ? ` (${escapeHtml(STATUS_LABELS[ev.fromStatus])} → ${escapeHtml(STATUS_LABELS[ev.toStatus])})` : ''}
          ${ev.actor ? ` · ${escapeHtml(ev.actor)}` : ''}
          ${ev.note ? `<div class="sub-cell">${escapeHtml(ev.note)}</div>` : ''}
          <div class="sub-cell">${escapeHtml(formatDateTime(ev.at))}</div>
        </li>
      `).join('')}
    </ul>
  `;

  panel.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>Hồ sơ #${escapeHtml(detail.id.slice(0, 8).toUpperCase())}</h2>
        <div class="badge-stack">
          <span class="badge type-${detail.type}">${escapeHtml(TYPE_LABELS[detail.type])}</span>
          <span class="badge sev-${detail.severity}">Mức độ: ${escapeHtml(SEVERITY_LABELS[detail.severity])}</span>
          <span class="badge status-${detail.status}">${escapeHtml(STATUS_LABELS[detail.status])}</span>
        </div>
      </div>
      <span class="count-pill">${detail.reportCount} minh chứng</span>
    </div>

    <div class="stepper">
      <div class="step-item ${stepClass(0)}">1. Tiếp nhận</div>
      <div class="step-item ${stepClass(1)}">2. Đang xử lý</div>
      <div class="step-item ${stepClass(2)}">3. Đã xử lý</div>
    </div>

    <p class="detail-desc">${escapeHtml(detail.description)}</p>
    <div class="meta-grid">
      <div><strong>Đơn vị phụ trách:</strong> ${escapeHtml(detail.assignedTeam)}</div>
      ${detail.address ? `<div><strong>Địa chỉ:</strong> ${escapeHtml(detail.address)}</div>` : ''}
      <div><strong>Cập nhật:</strong> ${escapeHtml(formatDateTime(detail.updatedAt))}</div>
      ${detail.location
        ? `<div><strong>GPS:</strong> ${detail.location.latitude.toFixed(6)}, ${detail.location.longitude.toFixed(6)} ${mapsLink ? `· <a href="${escapeHtml(mapsLink)}" target="_blank" rel="noopener noreferrer">Mở Google Maps ↗</a>` : ''}</div>`
        : '<div><strong>GPS:</strong> Không có tọa độ</div>'}
      ${detail.features.length ? `<div><strong>Đặc điểm:</strong> ${detail.features.map(f => `<code>${escapeHtml(f)}</code>`).join(' ')}</div>` : ''}
    </div>

    <div class="detail-tabs">
      <button type="button" class="view-tab ${state.activeDetailTab === 'actions' ? 'active' : ''}" data-dtab="actions">Xử lý</button>
      <button type="button" class="view-tab ${state.activeDetailTab === 'evidence' ? 'active' : ''}" data-dtab="evidence">Minh chứng (${detail.reports.length})</button>
      <button type="button" class="view-tab ${state.activeDetailTab === 'history' ? 'active' : ''}" data-dtab="history">Lịch sử (${detail.history.length})</button>
    </div>

    <div>
      ${state.activeDetailTab === 'actions' ? actionsHtml : state.activeDetailTab === 'evidence' ? evidenceHtml : historyHtml}
    </div>
  `;

  panel.querySelectorAll<HTMLButtonElement>('button[data-dtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeDetailTab = btn.dataset.dtab as UiState['activeDetailTab'];
      renderDetail();
    });
  });

  panel.querySelectorAll<HTMLImageElement>('.zoomable').forEach((img) => {
    img.addEventListener('click', () => openLightbox(img.src, img.alt));
  });

  const statusForm = document.getElementById('status-form') as HTMLFormElement | null;
  statusForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const status = (document.getElementById('next-status') as HTMLSelectElement).value as IncidentStatus;
    const actor = (document.getElementById('status-actor') as HTMLInputElement).value.trim();
    const note = (document.getElementById('status-note') as HTMLTextAreaElement).value.trim();
    void runAction(async () => {
      state.detail = await getClient().updateStatus(detail.id, {
        status,
        ...(actor ? { actor } : {}),
        ...(note ? { note } : {}),
      });
      state.notice = `Đã chuyển hồ sơ sang "${STATUS_LABELS[status]}".`;
      await loadQueue();
    });
  });

  const proofForm = document.getElementById('proof-form') as HTMLFormElement | null;
  proofForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const fileInput = document.getElementById('proof-file') as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;
    void runAction(async () => {
      state.detail = await getClient().uploadResolutionImage(detail.id, file, file.name);
      state.notice = 'Đã tải lên ảnh nghiệm thu.';
      await loadQueue();
    });
  });

  const teamForm = document.getElementById('team-form') as HTMLFormElement | null;
  teamForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const assignedTeam = (document.getElementById('new-team') as HTMLInputElement).value.trim();
    const note = (document.getElementById('team-note') as HTMLInputElement).value.trim();
    if (!assignedTeam) return;
    void runAction(async () => {
      state.detail = await getClient().reassignTeam(detail.id, {
        assignedTeam,
        ...(note ? { note } : {}),
      });
      state.notice = `Đã chuyển hồ sơ cho "${assignedTeam}".`;
      await loadQueue();
    });
  });
}

function openLightbox(src: string, caption: string) {
  const modal = byId<HTMLDivElement>('lightbox-modal');
  byId<HTMLImageElement>('lightbox-img').src = src;
  byId('lightbox-caption').textContent = caption;
  modal.classList.remove('hidden');
}

function setConnectModalOpen(open: boolean) {
  byId('connect-modal').classList.toggle('hidden', !open);
}

function setAuthInputMode(mode: 'email' | 'key') {
  state.authInputMode = mode;
  byId('auth-tab-email').classList.toggle('active', mode === 'email');
  byId('auth-tab-key').classList.toggle('active', mode === 'key');
  byId('auth-panel-email').classList.toggle('hidden', mode !== 'email');
  byId('auth-panel-key').classList.toggle('hidden', mode !== 'key');
}

async function runAction(work: () => Promise<void>) {
  state.busy = true;
  state.error = '';
  state.notice = '';
  renderBanner();
  try {
    await work();
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Đã có lỗi xảy ra.';
  } finally {
    state.busy = false;
    renderBanner();
    renderKpis();
    renderViews();
    renderDetail();
  }
}

async function loadQueue() {
  const client = getClient();
  const result = await client.list({
    ...(state.typeFilter ? { type: state.typeFilter } : {}),
    ...(state.statusFilter ? { status: state.statusFilter } : {}),
    ...(state.severityFilter ? { severity: state.severityFilter } : {}),
    ...(state.searchText ? { q: state.searchText } : {}),
    limit: PAGE_SIZE,
    offset: state.offset,
  });
  state.incidents = result.incidents;
  state.total = result.total ?? result.incidents.length;
}

async function loadVolunteerEvents() {
  const client = getClient();
  const result = await client.listVolunteerEvents({
    ...(state.volunteerStatusFilter ? { status: state.volunteerStatusFilter } : {}),
    limit: 50,
    offset: 0,
  });
  state.volunteerEvents = result.events;
  state.volunteerTotal = result.total ?? result.events.length;
  if (result.stats) state.volunteerStats = result.stats;
}

async function loadVolunteerDetail(id: string) {
  state.selectedVolunteerId = id;
  await runAction(async () => {
    state.volunteerDetail = await getClient().volunteerEventDetail(id);
  });
}

async function loadDetail(id: string) {
  state.selectedId = id;
  await runAction(async () => {
    state.detail = await getClient().detail(id);
  });
}

async function connectAndRefresh() {
  await runAction(async () => {
    const client = getClient();
    const health = await client.health();
    state.connected = true;
    const caps = health.capabilities
      ? `${health.capabilities.persistence}/${health.capabilities.storage} · AI:${health.capabilities.vision}`
      : health.mode;
    state.healthText = `Trực tuyến (${health.mode}) · ${caps}`;
    await Promise.all([loadQueue(), loadVolunteerEvents()]);
    if (state.selectedId) {
      state.detail = await client.detail(state.selectedId);
    }
    if (state.selectedVolunteerId) {
      state.volunteerDetail = await client.volunteerEventDetail(state.selectedVolunteerId);
    }
    setConnectModalOpen(false);
  });
}

function init() {
  const savedTheme = (() => {
    try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  })();
  applyTheme(savedTheme);

  const urlInput = byId<HTMLInputElement>('api-url');
  const opKeyInput = byId<HTMLInputElement>('operator-key');
  const tokenInput = byId<HTMLInputElement>('bearer-token');
  const emailInput = byId<HTMLInputElement>('login-email');
  const passInput = byId<HTMLInputElement>('login-password');
  urlInput.value = state.connection.baseUrl;
  opKeyInput.value = state.connection.operatorKey ?? '';
  tokenInput.value = state.connection.bearerToken ?? '';

  byId<HTMLButtonElement>('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  byId<HTMLButtonElement>('btn-open-connect').addEventListener('click', () => setConnectModalOpen(true));
  byId<HTMLButtonElement>('connect-close').addEventListener('click', () => setConnectModalOpen(false));
  byId<HTMLButtonElement>('btn-refresh').addEventListener('click', () => void connectAndRefresh());
  byId<HTMLButtonElement>('auth-tab-email').addEventListener('click', () => setAuthInputMode('email'));
  byId<HTMLButtonElement>('auth-tab-key').addEventListener('click', () => setAuthInputMode('key'));

  byId<HTMLButtonElement>('btn-logout').addEventListener('click', () => {
    state.connection = { ...state.connection, bearerToken: '', userLabel: '' };
    tokenInput.value = '';
    saveConnection(state.connection);
    renderKpis();
  });

  byId<HTMLFormElement>('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const baseUrl = urlInput.value.trim();
    const email = emailInput.value.trim();
    const password = passInput.value;
    void runAction(async () => {
      if (state.authInputMode === 'email' && email && password) {
        const tempClient = createAdminClient({ baseUrl });
        const session = await tempClient.login({ email, password });
        state.connection = {
          baseUrl,
          operatorKey: '',
          bearerToken: session.accessToken,
          userLabel: session.user.displayName || `${session.user.role}`,
        };
        tokenInput.value = session.accessToken;
        passInput.value = '';
      } else {
        state.connection = {
          baseUrl,
          operatorKey: opKeyInput.value.trim(),
          bearerToken: tokenInput.value.trim(),
          userLabel: state.connection.userLabel ?? '',
        };
      }
      saveConnection(state.connection);
      state.offset = 0;
      state.selectedId = null;
      state.detail = null;
      state.selectedVolunteerId = null;
      state.volunteerDetail = null;
      const client = getClient();
      const health = await client.health();
      state.connected = true;
      const caps = health.capabilities
        ? `${health.capabilities.persistence}/${health.capabilities.storage} · AI:${health.capabilities.vision}`
        : health.mode;
      state.healthText = `Trực tuyến (${health.mode}) · ${caps}`;
      await Promise.all([loadQueue(), loadVolunteerEvents()]);
      state.notice = 'Đã kết nối máy chủ thành công.';
      setConnectModalOpen(false);
    });
  });

  byId<HTMLButtonElement>('tab-list').addEventListener('click', () => { state.activeView = 'list'; renderViews(); renderDetail(); });
  byId<HTMLButtonElement>('tab-map').addEventListener('click', () => { state.activeView = 'map'; renderViews(); renderDetail(); });
  byId<HTMLButtonElement>('tab-volunteer').addEventListener('click', () => {
    state.activeView = 'volunteer';
    renderViews();
    renderDetail();
    void runAction(loadVolunteerEvents);
  });
  byId<HTMLSelectElement>('filter-volunteer-status').addEventListener('change', (event) => {
    state.volunteerStatusFilter = (event.target as HTMLSelectElement).value as VolunteerEventStatus | '';
    void runAction(loadVolunteerEvents);
  });

  byId<HTMLSelectElement>('filter-type').addEventListener('change', (event) => {
    state.typeFilter = (event.target as HTMLSelectElement).value as IncidentType | '';
    state.offset = 0;
    void runAction(loadQueue);
  });

  byId<HTMLSelectElement>('filter-status').addEventListener('change', (event) => {
    state.statusFilter = (event.target as HTMLSelectElement).value as IncidentStatus | '';
    state.offset = 0;
    void runAction(loadQueue);
  });

  byId<HTMLSelectElement>('filter-severity').addEventListener('change', (event) => {
    state.severityFilter = (event.target as HTMLSelectElement).value as Severity | '';
    state.offset = 0;
    void runAction(loadQueue);
  });

  byId<HTMLFormElement>('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.searchText = byId<HTMLInputElement>('search-input').value.trim();
    state.offset = 0;
    void runAction(loadQueue);
  });

  byId<HTMLButtonElement>('btn-prev').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    void runAction(loadQueue);
  });

  byId<HTMLButtonElement>('btn-next').addEventListener('click', () => {
    state.offset += PAGE_SIZE;
    void runAction(loadQueue);
  });

  byId<HTMLButtonElement>('lightbox-close').addEventListener('click', () => {
    byId('lightbox-modal').classList.add('hidden');
  });

  renderBanner();
  renderKpis();
  renderViews();
  renderDetail();
  // Auto-connect immediately to saved/default API URL so dashboard is live on load.
  void connectAndRefresh();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
