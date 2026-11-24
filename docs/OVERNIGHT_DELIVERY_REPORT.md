# CivicMerge — Báo cáo hoàn thiện 5 mốc (`feat/product-mvp-completion`)

Ngày thực hiện: **24/11/2026**
Nhánh làm việc: `feat/product-mvp-completion` (tách từ `main` tại `13540d1`; **chưa push, chưa merge vào `main`**).

---

## 1. Danh sách các mốc & commit

| Mốc | Commit | Nội dung chính |
|---|---|---|
| **Mốc 1 — Sửa lỗi tồn đọng MVP thật** | `aa28d55` | - Yêu cầu `SYSTEM_PROMPT` trong `packages/ai-vision/src/openai.ts` trả `description` bằng tiếng Việt tự nhiên, giữ nguyên quy ước `UNSUITABLE_IMAGE:` (422).<br>- Tách mã lỗi `AI_TIMEOUT` (504) và `AI_RATE_LIMITED` (503 khi HTTP 429) khỏi `AI_UNAVAILABLE` (503); thêm buffer timeout cho wrapper `boundedVision` tránh đua timeout với `AbortSignal.timeout`.<br>- Lưu `capturedImageUri` trong `FlowProvider` và hiển thị ảnh người dùng vừa gửi trực tiếp trên `ResultScreen` để đối chiếu cạnh minh chứng cũ; thêm nút **"Về trang chủ"** và **"Tạo báo cáo mới"** khi gặp `REPORT_ALREADY_CONFIRMED`.<br>- Xóa `app.json` rỗng ở root, thêm profile `production` vào `apps/mobile/eas.json`, thêm tùy chọn `--real` (không đổi mặc định mock) vào `apps/api/scripts/demo.ts`. |
| **Mốc 2 — Hiệu năng API, Matching & Analyze Idempotency** | `082039c` | - Mở rộng `GET /api/incidents` hỗ trợ lọc `type`, `status`, `severity`, phân trang `limit`/`offset` và trả thêm optional `total` (tương thích ngược khi không có query).<br>- Thêm `listNearbyOpen` lọc bounding-box theo GPS + `type` + chưa `resolved` cho cả Memory và PostgreSQL kèm migration index mới `supabase/migrations/202611240000_incident_query_indexes.sql` (không còn tải toàn bộ DB vào RAM khi `analyze`).<br>- Khi `merge` report mới vào incident: hợp nhất `features` (union + sort) và nâng `severity` nếu báo cáo mới nghiêm trọng hơn (`low < medium < high`).<br>- Bổ sung tùy chọn `minScore` và `maxAgeDays` tương thích ngược cho `createGpsFeatureMatcher`.<br>- Thêm hỗ trợ header `Idempotency-Key` cho `POST /api/reports/analyze` (tránh gọi AI/Storage trùng lặp, 409 `IDEMPOTENCY_KEY_CONFLICT` nếu khác payload) và endpoint `GET /api/reports/:id`. |
| **Mốc 3 — Vòng đời xử lý sự cố (`open -> in_progress -> resolved`)** | `7879b92` | - Thêm migration mới `supabase/migrations/202611240001_incident_lifecycle.sql` (tuyệt đối không sửa migration cũ `202611130001_incident_repository.sql`): tạo bảng `civicmerge.incident_events` có RLS + `REVOKE PUBLIC`, bổ sung cột `resolution_note` và `resolved_at` trên `civicmerge.incidents`.<br>- Thêm `PATCH /api/incidents/:id/status` kiểm tra chuyển trạng thái hợp lệ trong transaction `FOR UPDATE`, ghi lịch sử, kích hoạt guard `INCIDENT_RESOLVED` khi chuyển `resolved`, bảo vệ bằng `X-Operator-Key` (`OPERATOR_API_KEY`, fail-closed 403 ở chế độ real nếu chưa cấu hình). |
| **Mốc 4 — Hoàn thiện UX Mobile** | `9c71c5f` | - Chuyển phần cấu hình URL máy chủ vào modal **⚙️ Cài đặt máy chủ** trên `HomeScreen` (tự mở nếu chưa có `API_URL`), đưa CTA báo cáo và danh sách lên trọng tâm.<br>- Đổi danh sách `HomeScreen` sang `FlatList` kèm kéo để tải lại (`RefreshControl`) và chip lọc nhanh theo Loại sự cố & Trạng thái.<br>- Bổ sung modal xem ảnh phóng to toàn màn hình khi chạm vào bất kỳ ảnh minh chứng nào (`ui.tsx`).<br>- Thêm nút **"🗺️ Mở vị trí trên Bản đồ"** (Apple Maps / Google Maps), khung thông tin xử lý khi `resolved`, và hiển thị đầy đủ các mốc lịch sử `status_changed` trên `DetailScreen`.<br>- Lưu tạm pending draft bằng `expo-file-system` sau khi `analyze`, tự đối chiếu qua `GET /api/reports/:id` và hiện banner **"Tiếp tục xác nhận"** trên Trang chủ nếu người dùng thoát app giữa chừng; gửi `Idempotency-Key` khi gọi `analyze`. |
| **Mốc 5 — Bảo mật nội bộ, Observability, CI & Tài liệu** | *(commit này)* | - Thêm middleware `X-Request-Id`, security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) và structured JSON request logging không lộ secret/auth/DB URL.<br>- Thêm rate limiter in-memory cho `POST /api/reports/analyze` trả 429 `RATE_LIMITED` + `Retry-After`.<br>- Nâng cấp `GET /api/images/:bucket/:prefix/:name` hỗ trợ `ETag`, `Cache-Control: private, max-age=300` và `304 Not Modified` qua `If-None-Match`.<br>- Thêm `GET /health/ready` kiểm tra thực tế DB/Storage (ẩn lỗi driver khi 503).<br>- Thêm GitHub Actions CI tại `.github/workflows/ci.yml`; cập nhật `.env.example`, `docs/API_CONTRACT.md`, `docs/ARCHITECTURE.md` và tạo báo cáo này. |

---

## 2. Kết quả kiểm chứng tự động (chạy sau lần sửa cuối)

| Lệnh | Kết quả | Ghi chú |
|---|---|---|
| `npm.cmd run typecheck` | **PASS** | Toàn bộ 5 workspace + root tooling (`tsconfig.tools.json`) |
| `npm.cmd run lint` | **PASS** | 0 errors, 0 warnings (`EXPO_NO_TELEMETRY=1`) |
| `npm.cmd run test:modules` | **PASS** | Fixtures & adapter mock/routing |
| `npm.cmd run test --workspace=@civicmerge/ai-vision` | **7 PASS, 1 SKIP** | Ca skip là test live OpenAI có phí (chưa cung cấp key/6 ảnh mẫu) |
| `npm.cmd run test --workspace=@civicmerge/matching` | **8/8 PASS** | Gồm test mới cho `minScore` và `maxAgeDays` |
| `npm.cmd run test:mobile` | **5/5 PASS** | Gồm test mới cho pending draft & URL bản đồ |
| `npm.cmd run test:storage` | **6/6 PASS** | Storage adapter với HTTP giả lập |
| `npm.cmd run test:demo` | **6/6 PASS** | Demo controller & LAN IP selection |
| `npm.cmd run test:integration` | **45/45 PASS** | Toàn bộ pipeline, matching, vision handoff, resolved, milestone 2, lifecycle và hardening |
| `npm.cmd run mobile:export` | **PASS** | Xuất bundle iOS vào `apps/mobile/dist` (gitignored) |
| `npm.cmd run mobile:export:android` | **PASS** | Đã kiểm chứng ở Mốc 4, xuất bundle Android vào `apps/mobile/dist` |

- Không cài thêm dependency npm mới; `package-lock.json` giữ nguyên.
- Không sửa file migration cũ `supabase/migrations/202611130001_incident_repository.sql`.

---

## 3. Giới hạn còn lại & Chưa kiểm chứng trong phiên tự động

- **Dịch vụ live & DB thật:** Chưa chạy `npm.cmd run db:migrate` lên Supabase thật, chưa chạy `test:database` (cần `TEST_DATABASE_URL` riêng), chưa chạy `test:storage:live` và chưa gọi OpenAI live (cần `OPENAI_API_KEY`, `OPENAI_MODEL` và 6 ảnh thật).
- **Thiết bị thật:** Chưa kiểm thử camera, GPS, modal cài đặt, zoom ảnh, mở Apple/Google Maps, draft recovery và luồng 2 điện thoại trên iPhone/Android thật; chưa build APK/IPA mới qua EAS.
- **Ngoài phạm vi đêm nay (chặng sau):** Xác thực người dùng cuối (Supabase Auth / JWT cho citizen & operator), giao diện Web Admin cho Ban quản lý (`apps/web-admin`), triển khai HTTPS production (FPT Cloud / cloud hosting), cron dọn pending/orphan image và Push Notifications.

---

## 4. Checklist nhanh cho bạn kiểm tra sáng nay

1. Xem lại các commit trên nhánh hiện tại:
   ```powershell
   git log --oneline -n 6
   ```
2. Nếu dùng PostgreSQL/Supabase thật, chạy migration mới trước khi bật API:
   ```powershell
   npm.cmd run db:migrate
   npm.cmd run backend:check
   ```
3. (Tùy chọn) Thêm `OPERATOR_API_KEY` vào `apps/api/.env` nếu muốn thử `PATCH /api/incidents/:id/status` ở chế độ real.
4. Chạy `npm.cmd run dev:api` và `npm.cmd run dev:mobile`, kiểm tra trên iPhone/Android thật:
   - Mở **⚙️ Máy chủ** để lưu URL LAN; thử lọc Loại/Trạng thái và kéo xuống để tải lại.
   - Chụp ảnh thật → kiểm tra mô tả tiếng Việt trên `ResultScreen`, đối chiếu ảnh vừa chụp cạnh ảnh cũ, chạm ảnh để phóng to.
   - Đóng app giữa chừng ở `ResultScreen` rồi mở lại → kiểm tra banner **Tiếp tục xác nhận**.
   - Mở `DetailScreen` → bấm **Mở vị trí trên Bản đồ**, sau đó thử gọi `PATCH /api/incidents/:id/status` chuyển `in_progress` → `resolved` và tải lại để xem timeline & thông tin xử lý.
5. Khi đã hài lòng, review và đẩy nhánh hoặc mở PR vào `main` theo quy trình nhóm.
