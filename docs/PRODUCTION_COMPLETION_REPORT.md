# CivicMerge — Báo cáo hoàn thiện Production & UI/UX (Mốc 6 → Mốc 14)

Ngày thực hiện: **24/11/2026**
Nhánh làm việc: `feat/product-production-complete` (tách từ `feat/product-mvp-completion` tại `a4a0b32`; chứa đầy đủ cả 14 mốc; **chưa push, chưa merge vào `main`**).

---

## 1. Danh sách các mốc & commit (Mốc 6 → Mốc 14)

| Mốc | Commit | Nội dung đã triển khai |
|---|---|---|
| **Mốc 6 — Xác thực JWT, Phân quyền RBAC & Ownership** | `4772342` | - Migration mới `supabase/migrations/202611240002_auth_and_production.sql` (giữ nguyên 3 migration cũ): thêm bảng `profiles`, `analyze_idempotency`, `routing_rules` (seed 3 rule mặc định), `push_tokens` đều bật RLS + `REVOKE PUBLIC`; mở rộng `reports` (`reporter_id`, `user_note`), `incidents` (`resolution_image_url`, `address`), `incident_events` (`actor_id`).<br>- Triển khai `createHs256JwtVerifier` & `signHs256Jwt` bằng `node:crypto` (kiểm tra chữ ký `timingSafeEqual`, `exp`/`nbf`/`iss`/`aud`/`sub` UUID, map `role='authenticated'` sang `'citizen'`).<br>- Thêm `AUTH_MODE=off\|jwt` (fail-closed khi chọn `jwt` mà thiếu `AUTH_JWT_SECRET >= 16` ký tự), kiểm tra chủ sở hữu `reporterId` trên `GET /api/reports/:id` và `POST /api/reports/confirm` (403 `FORBIDDEN`), RBAC `operator`/`admin` cho cập nhật trạng thái (vẫn tương thích `X-Operator-Key`), bảo vệ `/api/images/...` qua Bearer hoặc `?token=`, thêm `GET /api/me/reports`. |
| **Mốc 7 — Persistence bền vững, Routing động, Ảnh nghiệm thu, Đổi tổ & Cleanup** | `beb6ee4` | - Lưu bền vững `Idempotency-Key` trong bảng `civicmerge.analyze_idempotency` (Memory + PostgreSQL).<br>- Mở rộng `ConfirmRequestSchema` hỗ trợ optional `userNote` và tùy chỉnh nhẹ `severity`/`description` khi tạo hồ sơ mới.<br>- Hỗ trợ tìm kiếm `?q=...` và lọc `?mine=true` trên `GET /api/incidents`.<br>- Thêm `PATCH /api/incidents/:id/team` (ghi lịch sử `team_reassigned`), `POST /api/incidents/:id/resolution-image` (upload ảnh nghiệm thu qua `ImageStorage`, rollback xóa ảnh nếu ghi DB lỗi) và `POST /api/push-tokens`.<br>- Thêm `createRuleRouter` có geofencing theo vùng tọa độ + độ ưu tiên (`packages/matching/src/routing.ts`).<br>- Thêm CORS middleware theo `CORS_ALLOWED_ORIGINS` (xử lý `OPTIONS` 204, không mở `*`).<br>- Thêm module & CLI `npm run maintenance:cleanup` (`--dry-run` mặc định an toàn, `--apply`, `--hours=48`) chỉ dọn `pending` report quá hạn và ảnh không tham chiếu. |
| **Mốc 8 — Giao diện Web Admin cho Ban quản lý (`apps/web-admin/`)** | `31615dc` | - Tạo workspace `@civicmerge/web-admin` dùng chung `@civicmerge/contracts` (0 dependency ngoài; build ESM sạch bằng `tsc`, đồng bộ `package-lock.json` offline).<br>- Đầy đủ nghiệp vụ Ban quản lý: kết nối bằng `X-Operator-Key` / JWT lưu trong `sessionStorage`, 4 thẻ KPI + tỷ lệ phản ánh trùng đã gom, hàng đợi ưu tiên theo `severity` & `reportCount`, lọc Loại/Trạng thái/Mức độ + tìm kiếm `?q=` + phân trang Trước/Sau, chi tiết hồ sơ kèm phóng to ảnh & Google Maps, form chuyển trạng thái, tải ảnh nghiệm thu và đổi tổ phụ trách.<br>- Thêm script root `dev:admin`, `build:admin`, `test:admin` và unit tests `tests/web-admin/admin.test.ts`. |
| **Mốc 9 — Hoàn thiện UX Mobile & Cấu hình Production** | `5e2aba8` | - Phân trang thật (`PAGE_SIZE = 20`, `offset`, `onEndReached` + nút Tải thêm), ô tìm kiếm `?q=` và chip lọc **"Phản ánh của tôi"** trên `HomeScreen.tsx`.<br>- Thêm ô nhập ghi chú người dùng (`userNote`) & chip chỉnh mức độ nghiêm trọng trước khi xác nhận trên `ResultScreen.tsx`.<br>- Hiển thị ảnh nghiệm thu (`resolutionImageUrl`) và ghi chú người gửi (`userNote`) trên `DetailScreen.tsx`.<br>- Lưu/gắn JWT Bearer token tách biệt (`auth-settings.ts`), tự gắn `?token=` cho URL proxy `/api/images/...` và thêm helper đăng ký push token (`tryRegisterPushToken`).<br>- Nâng `versionCode: 3`, thêm `apps/mobile/app.config.ts` tự tắt `usesCleartextTraffic` khi `APP_ENV=production` và cập nhật profile `production` trong `apps/mobile/eas.json`. |
| **Mốc 10 — Docker, Deploy Runbook, CI & Tài liệu đồng bộ** | `c2cb8ed` | - Tạo `Dockerfile` multi-stage Node 24 non-root kèm `HEALTHCHECK /health/ready`, `.dockerignore` và `docs/PRODUCTION_DEPLOY.md`.<br>- Cập nhật `.github/workflows/ci.yml` (thêm `build:admin` và `test:admin`), `.env.example`, `README.md`, `docs/API_CONTRACT.md`, `docs/ARCHITECTURE.md` và báo cáo này. |
| **Mốc 11 — Supabase Auth Login/Signup, Expo Push, Reverse Geocoding & DB Routing** | `96b3e55` | - Thêm `POST /api/auth/login` và `POST /api/auth/signup` qua `createSupabaseAuthClient` (yêu cầu `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`).<br>- Thêm `createExpoPushNotifier` (`PUSH_NOTIFICATIONS_ENABLED=true`) tự bắn thông báo best-effort tới các thiết bị của người phản ánh khi cập nhật trạng thái.<br>- Thêm `createNominatimGeocoder` (`GEOCODER_ENABLED=true`) tự điền `incidents.address` dễ đọc khi tạo sự cố có GPS.<br>- Tự động nạp `civicmerge.routing_rules` từ PostgreSQL vào `createRuleRouter` khi khởi động.<br>- Bổ sung `tests/integration/milestone11.test.ts`. |
| **Mốc 12 — Thiết kế lại Web Admin Smart City UI/UX (`apps/web-admin/`)** | `487df01` | - Chuyển đổi giao diện Light/Dark theme, modal Kết nối & Đăng nhập 2 tab (Email/Mật khẩu + Operator Key/JWT), tự động kết nối ngay khi tải trang.<br>- Hàng đợi ưu tiên kèm ảnh thumbnail 46×46px, chuyển đổi sang tab **Bản đồ điểm nóng** chiếu tọa độ GPS tương tác.<br>- Panel chi tiết có thanh **Status Stepper 3 bước** và 3 tab con (`Xử lý · Minh chứng · Lịch sử`). |
| **Mốc 13 — Nâng cấp UI/UX Mobile App (`apps/mobile/`)** | `6a3a526` | - Thu gọn Hero bar trên `HomeScreen` để thẻ sự cố đầu tiên hiển thị ngay trên màn hình đầu; gom chip lọc thành 1 hàng cuộn ngang; gắn badge số lượng phản ánh lên ảnh; bổ sung modal 2 tab **Đăng nhập (Email/Mật khẩu/Tạo tài khoản)** và **Máy chủ**.<br>- Tự động lấy GPS ngầm khi mở `ReportScreen` nếu đã được cấp quyền.<br>- Chuyển so sánh ảnh trên `ResultScreen` sang bố cục 2 cột song song (Ảnh vừa chụp vs. Hồ sơ ứng viên).<br>- Thêm `StatusStepper` 3 bước và hiển thị `address` đọc được trên `DetailScreen`. |
| **Mốc 14 — Đồng bộ tài liệu, Kiểm chứng toàn hệ thống & Làm mới Preview** | *(commit này)* | - Cập nhật `.env.example`, `docs/API_CONTRACT.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCTION_DEPLOY.md` và báo cáo này cho đầy đủ Mốc 11–14.<br>- Chạy lại toàn bộ 13 lệnh kiểm chứng trên cả 6 workspace (100% PASS) và làm mới bản xem trước trực tiếp. |

---

## 2. Kết quả kiểm chứng tự động (chạy sau lần sửa cuối)

| Lệnh kiểm chứng | Kết quả | Chi tiết |
|---|---|---|
| `npm.cmd run typecheck` | **PASS** | Toàn bộ 6 workspace (`api`, `mobile`, `web-admin`, `ai-vision`, `contracts`, `matching`) + root tooling |
| `npm.cmd run lint` | **PASS** | 0 errors, 0 warnings (`EXPO_NO_TELEMETRY=1`) |
| `npm.cmd run test:modules` | **PASS** | Schema/fixtures và adapter độc lập |
| `npm.cmd run test --workspace=@civicmerge/ai-vision` | **7 PASS, 1 SKIP** | Ca skip là test live OpenAI có phí (cần key + 6 ảnh thật) |
| `npm.cmd run test --workspace=@civicmerge/matching` | **9/9 PASS** | Gồm unit test geofenced `createRuleRouter`, `minScore`, `maxAgeDays` |
| `npm.cmd run test:mobile` | **6/6 PASS** | Gồm helper token xác thực, ảnh proxy, pending draft và URL bản đồ |
| `npm.cmd run test:storage` | **6/6 PASS** | Private Storage adapter với HTTP giả lập |
| `npm.cmd run test:demo` | **6/6 PASS** | Demo controller & chọn IP LAN |
| `npm.cmd run build:admin` | **PASS** | Compile Web Admin sang `apps/web-admin/dist/` |
| `npm.cmd run test:admin` | **5/5 PASS** | KPI, priority sorting, status stepper, hotspot projection, XSS escaping, Admin API client (gồm `login`) |
| `npm.cmd run test:integration` | **53/53 PASS** | Gồm Mốc 11 (`milestone11.test.ts`: Auth login/signup, Push, Geocoding, DB routing), Auth/RBAC, Milestone 7, Cleanup, Lifecycle, Hardening và toàn bộ hồi quy Mốc 1–5 |
| `npm.cmd run mobile:export` | **PASS** | Bundle iOS `apps/mobile/dist` |
| `npm.cmd run mobile:export:android` | **PASS** | Bundle Android `apps/mobile/dist` |

---

## 3. Phân tách rõ: Đã chứng minh tự động vs. Bước cần bạn thao tác thực tế

### Đã chứng minh hoàn toàn bằng mã nguồn & kiểm thử tự động
- Toàn bộ contract Zod, 4 file migration (giữ nguyên toàn bộ migration cũ), logic transaction/lock/idempotency, JWT HS256 & RBAC/ownership, CORS, rate limiting, `ETag`/304, `/health/ready`, geofenced routing, cleanup dry-run/apply, Web Admin build/client và Mobile bundle export cho cả iOS lẫn Android.

### Cần thao tác thực tế của người vận hành (ngoài phạm vi chạy offline)
1. **Database thật:** Chạy `npm.cmd run db:migrate` lên Supabase PostgreSQL và tạo DB runtime role tối thiểu theo [docs/PRODUCTION_DEPLOY.md](PRODUCTION_DEPLOY.md).
2. **Dịch vụ live:** Cấu hình `OPENAI_API_KEY`, `OPENAI_MODEL`, `SUPABASE_*`, `AUTH_MODE=jwt`, `AUTH_JWT_SECRET` (lấy JWT Secret từ Supabase Auth), `CORS_ALLOWED_ORIGINS` rồi kiểm tra bằng `npm.cmd run backend:check` và chạy live Vision với 6 ảnh thật.
3. **Thiết bị thật & Web Admin thực địa:** Chạy `npm.cmd run dev:api` + `npm.cmd run dev:admin` + `npm.cmd run dev:mobile`, thử nghiệm end-to-end trên **2 điện thoại thật (iPhone + Android)** và thao tác xử lý sự cố (đổi trạng thái, tải ảnh nghiệm thu, đổi tổ) từ trình duyệt Web Admin.
4. **Phát hành & Hạ tầng:** Build bản thật qua EAS (`production` profile) sau khi có domain HTTPS; build & chạy `Dockerfile` trên server (FPT Cloud / Render / Railway) và đặt cron cho `npm run maintenance:cleanup -- --apply --hours=48`.
5. **Review & Merge:** Xem lại lịch sử commit trên nhánh `feat/product-production-complete` (`git log --oneline -n 11`) rồi push / tạo PR vào `main` theo quy trình của nhóm.
