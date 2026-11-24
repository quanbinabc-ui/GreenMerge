# API contract v0.1

Source of truth: `packages/contracts/src/index.ts`. Tọa độ dùng độ thập phân; thời gian dùng ISO 8601 UTC. Nhãn loại `pothole|trash|flood`; severity `low|medium|high`; features là lowercase tags như `surface:asphalt`.

| Method | Endpoint | Request | Response |
|---|---|---|---|
| GET | `/health` | — | `{status: 'ok', mode: 'mock' \| 'real', capabilities?}` |
| GET | `/health/ready` | — | `{status: 'ready', checks: {database, storage}}` hoặc 503 `NOT_READY` |
| POST | `/api/auth/login` | JSON `{email, password}` (khi cấu hình `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`) | `AuthSessionResponse` (`accessToken`, `user`) hoặc 400/401/503 |
| POST | `/api/auth/signup` | JSON `{email, password, displayName?}` | HTTP 201 `AuthSessionResponse`, 202 nếu cần xác nhận email, hoặc 400/422/503 |
| POST | `/api/reports/analyze` | Multipart `image`, optional cặp `latitude`, `longitude`, optional header `Idempotency-Key` | HTTP 201, `AnalyzeResponse` |
| GET | `/api/reports/:id` | Report ID (UUID), Bearer token khi bật `AUTH_MODE=jwt` | `Report` (có `reporterId`, `userNote`) hoặc 401/403/404 |
| GET | `/api/me/reports` | Bearer token bắt buộc | `{reports: Report[]}` của người dùng hiện tại |
| POST | `/api/reports/confirm` | `ConfirmRequest` (hỗ trợ optional `userNote`; khi `create` hỗ trợ optional `severity`, `description`) | HTTP 200, `ConfirmResponse` |
| POST | `/api/push-tokens` | JSON `{token, platform}`, Bearer token bắt buộc | `{ok: true}` |
| GET | `/api/incidents` | Optional query: `type`, `status`, `severity`, `q`, `mine=true`, `limit` (1..100), `offset` (>=0) | `{incidents: IncidentSummary[], total?}` (`total` có khi gửi query params) |
| GET | `/api/incidents/:id` | Incident ID | `IncidentDetail` (có optional `resolutionNote`, `resolvedAt`, `resolutionImageUrl`, `address` và `history` mở rộng) hoặc 404 |
| PATCH | `/api/incidents/:id/status` | JSON `{status, note?, actor?}`, JWT `operator`/`admin` hoặc `X-Operator-Key` | `IncidentDetail` cập nhật hoặc 401/403/404/409 |
| PATCH | `/api/incidents/:id/team` | JSON `{assignedTeam, note?, actor?}`, JWT `operator`/`admin` hoặc `X-Operator-Key` | `IncidentDetail` cập nhật + sự kiện `team_reassigned` |
| POST | `/api/incidents/:id/resolution-image` | Multipart `image`, JWT `operator`/`admin` hoặc `X-Operator-Key` | `IncidentDetail` kèm `resolutionImageUrl` đã map proxy |
| GET | `/api/images/:bucket/:prefix/:name` | Key UUID; hỗ trợ `If-None-Match` và Bearer token / `?token=` khi bật `AUTH_MODE=jwt` | Bytes JPEG/PNG/WebP kèm `ETag` + `Cache-Control: private, max-age=300` (hoặc 304) |

Mọi response trả kèm `X-Request-Id` (echo nếu hợp lệ hoặc tự sinh UUID) cùng các security headers cơ bản (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`). Health giữ nguyên contract cũ; `/health/ready` kiểm tra thực tế kết nối DB/Storage (nếu bật) và ẩn chi tiết credential/driver khi lỗi.

## Analyze

Ảnh tối đa 8 MB; JPEG, PNG hoặc WebP, MIME khớp chữ ký tệp. Tọa độ multipart truyền dạng chuỗi số; có cả hai hoặc bỏ cả hai. Thiếu GPS trả cảnh báo và candidates rỗng.

```json
{
  "reportId": "550e8400-e29b-41d4-a716-446655440000",
  "analysis": {"type":"pothole","severity":"high","description":"Mô tả sự cố","features":["surface:asphalt"]},
  "candidates": [],
  "warnings": []
}
```

Candidate có `incidentId`, `score` (0..1, điểm xếp hạng), `distanceMeters` và `reasons`. Mobile dùng API detail để xem ảnh trước khi chọn merge. Khi thiếu GPS, warnings có `{code: 'GPS_UNAVAILABLE', message: string}`.

## Confirm

```json
{"reportId":"550e8400-e29b-41d4-a716-446655440000","action":"create"}
```

Hoặc `action: "merge"` và thêm `targetIncidentId` hợp lệ. Không gửi target cho create. Cùng report/chọn lựa trả snapshot cũ; chọn lựa khác sau khi đã confirm trả 409. Merge khác loại trả 409, merge không tồn tại trả 404 và report vẫn pending.

Merge mới vào incident `resolved` trả `INCIDENT_RESOLVED` (409), report giữ pending, count/history/confirmation không tăng và không reopen. Backend kiểm tra status dưới cùng incident lock trong transaction. Retry của confirm đã thành công vẫn trả snapshot cũ trước khi kiểm tra status mới; đổi lựa chọn vẫn `REPORT_ALREADY_CONFIRMED`. Merge vào `in_progress` giữ nguyên status; khi merge thành công, incident tự hợp nhất `features` (union + sort) và nâng `severity` nếu báo cáo mới nghiêm trọng hơn.

## Cập nhật trạng thái (`PATCH /api/incidents/:id/status`)

- Chuyển trạng thái hợp lệ: `open -> in_progress | resolved`, `in_progress -> open | resolved`. Trạng thái `resolved` là trạng thái kết thúc (chuyển tiếp hoặc chuyển cùng trạng thái hiện tại trả 409 `INVALID_STATUS_TRANSITION`).
- Khi chuyển sang `resolved`, backend lưu `resolvedAt` và `resolutionNote` (nếu có `note`), đồng thời ghi bản ghi `status_changed` vào lịch sử sự cố. Khi bật `PUSH_NOTIFICATIONS_ENABLED=true`, backend tự động gửi Expo Push best-effort tới các `push_tokens` đã đăng ký của các người phản ánh thuộc sự cố (lỗi push không làm hỏng giao dịch trạng thái đã commit).
- Khi tạo sự cố mới qua `confirm` có tọa độ GPS và bật `GEOCODER_ENABLED=true`, backend tự động gọi reverse geocoding (Nominatim) best-effort để điền sẵn trường `address` dễ đọc trên `IncidentSummary` và `IncidentDetail`.
- Khi backend có cấu hình `OPERATOR_API_KEY`, client bắt buộc gửi `X-Operator-Key` khớp (thiếu → 401 `UNAUTHORIZED`, sai → 403 `FORBIDDEN`). Trong chế độ real (`mockMode=false`) mà chưa cấu hình `OPERATOR_API_KEY`, endpoint trả 403 `OPERATOR_KEY_REQUIRED` (fail-closed).

## Analyze Idempotency & Rate Limit

- `POST /api/reports/analyze` hỗ trợ optional header `Idempotency-Key` (`1..128` ký tự ASCII an toàn). Gửi lại cùng key và cùng nội dung ảnh/GPS trả lại đúng `AnalyzeResponse` ban đầu mà không gọi lại AI/Storage; dùng cùng key cho payload khác trả 409 `IDEMPOTENCY_KEY_CONFLICT`.
- Endpoint `analyze` có rate limiter theo IP (cấu hình qua `ANALYZE_RATE_LIMIT_MAX` / `ANALYZE_RATE_LIMIT_WINDOW_MS`); vượt ngưỡng trả HTTP 429 `RATE_LIMITED` kèm header `Retry-After`.
- `GET /api/reports/:id` cho phép Mobile kiểm tra lại trạng thái `pending`/`confirmed` của một báo cáo dở dang sau khi mở lại ứng dụng.

## Lỗi

Luôn là `{error: {code: string, message: string}}`. Các lỗi chính: `VALIDATION_ERROR` (400, ảnh quá lớn 413), `UNAUTHORIZED` (401), `FORBIDDEN` / `OPERATOR_KEY_REQUIRED` (403), `INVALID_IMAGE` (415, ảnh không phù hợp 422), `RATE_LIMITED` (429), `AI_UNAVAILABLE` / `AI_RATE_LIMITED` (503), `AI_TIMEOUT` (504), `REPORT_NOT_FOUND` / `INCIDENT_NOT_FOUND` (404), `REPORT_ALREADY_CONFIRMED` / `INCIDENT_TYPE_MISMATCH` / `INCIDENT_RESOLVED` / `INVALID_STATUS_TRANSITION` / `IDEMPOTENCY_KEY_CONFLICT` / `MOCK_RESET` (409), `NOT_READY` (503), `INTERNAL_ERROR` (500).

Adapter OpenAI giữ `INVALID_IMAGE` 422 cho ảnh không phù hợp, `AI_INVALID_RESPONSE` 502 cho output/schema/tags sai, `AI_UNAVAILABLE` 503 cho lỗi dịch vụ/mạng (gồm timeout do adapter bắt được). Wrapper backend trả `AI_TIMEOUT` 504 nếu hết thời gian trước provider; không chuyển timeout thành lỗi confirm chắc chắn thất bại. Matching thô lỗi trả `MATCHING_UNAVAILABLE` 503, output sai trả `PROVIDER_INVALID_RESPONSE` 502. Không trả key/model hoặc response thô upstream trong lỗi.

Backend giữ status/code của `DomainError` an toàn do adapter cung cấp (ví dụ `IMAGE_UNSUITABLE` 422). Exception thô của provider/driver bị che nội dung: `AI_UNAVAILABLE`, `MATCHING_UNAVAILABLE`, `DATABASE_UNAVAILABLE` (503). AI/matching timeout: `AI_TIMEOUT`/`MATCHING_TIMEOUT` (504); output sai schema: `PROVIDER_INVALID_RESPONSE` (502).

Storage: `STORAGE_UNAVAILABLE`/`STORAGE_CONFIG_ERROR` (503), `STORAGE_TIMEOUT` (504), `STORAGE_INVALID_RESPONSE` (502), `IMAGE_NOT_FOUND` (404). INSERT report chắc chắn bị từ chối: `DATABASE_WRITE_REJECTED` (503); có thể retry analyze thủ công. Lỗi database không rõ kết quả ghi: không tự động gửi analyze lại vì analyze chưa idempotent. Confirm bị timeout/lỗi chưa rõ kết quả thì retry **cùng lựa chọn**; không đổi create/merge chỉ vì chưa nhận response.

Ảnh Storage được trả bằng URL proxy backend ổn định trong `imageUrl`/`coverImageUrl`, không signed URL hết hạn hoặc marker nội bộ `.invalid`. Đổi PUBLIC_BASE_URL sẽ dựng lại URL ảnh Storage ở lần list/detail tiếp theo; URL local legacy giữ nguyên. Proxy không expose upload/delete/reset; hiện dành cho môi trường demo tin cậy chưa có auth.

## Điều khiển mock

Chỉ có ở backend memory/local/mock/mock, dành cho môi trường tin cậy. PostgreSQL hoặc Supabase Storage không đăng ký các controls này, kể cả AI/matching còn mock:

- `GET /api/mock/state`: đọc scenario.
- `POST /api/mock/scenario`: JSON `{scenario: 'pothole'|'trash'|'flood'|'ai-error'}`.
- `POST /api/mock/reset`: xóa dữ liệu nghiệp vụ đang chạy, scenario về `pothole`.

Response của controls là `{scenario: ...}`. Không đưa controls này vào backend thật hoặc expose công khai mà chưa thiết kế quyền truy cập.

Chặng database không đổi request/response hoặc enum: `/health` vẫn `mode: "mock"` vì AI/matching chưa thật. PostgreSQL adapter luôn từ chối `reset()` với `RESET_DISABLED` (403) ngay cả khi được gọi trực tiếp; qua HTTP các đường dẫn `/api/mock/*` không tồn tại (404).
