# Kiến trúc backend và nền tích hợp

```text
Mobile (Expo Router, 4 screens in src/app)
  -> services/api.ts (HTTP + response schema validation)
  -> Express createApp(dependencies)
       -> VisionAnalyzer -> DuplicateMatcher
       -> ImageStorage -> IncidentRepository.createPending
       -> confirm -> IncidentRouter -> IncidentRepository.confirm
  -> incidents list/detail -> Mobile
```

`packages/contracts` chứa schema Zod, types và interfaces. `bootstrap/mock.ts` lắp AI mock, matching mock, routing rule, repository bộ nhớ và storage local. Mobile không biết implementation nội bộ.

`analyze` không tạo incident. `confirm` là boundary cần atomicity: kiểm tra lựa chọn cũ/đích merge, gắn report, cập nhật incident/history và lưu kết quả idempotent. Bản bộ nhớ không có await giữa validation và writes; Supabase adapter phải dùng transaction cùng ràng buộc phù hợp, không suy ra tính an toàn DB từ bản mock.

Retry cùng lựa chọn trả snapshot kết quả ban đầu, dù incident đã nhận thêm reports sau đó. Muốn số minh chứng mới nhất, đọc API detail.

Scenario/reset là API development riêng, chỉ có khi `mockMode=true`, có `mockControl` và tất cả provider là memory/local/mock/mock. Server dùng `bootstrap/configured.ts`, chọn persistence/storage/vision/matching độc lập; cấu hình không hợp lệ hoặc thiếu factory thật làm startup thất bại. PostgreSQL hoặc Supabase Storage không có `/api/mock/*`, kể cả AI/matching vẫn mock. Không gửi scenario như field nghiệp vụ của analyze.

Mỗi backend local có bộ nhớ và thư mục ảnh riêng. Dùng chung một backend khi demo hai điện thoại. Ảnh cũ không bị xóa khi reset dữ liệu nghiệp vụ; restart backend làm mất reports/incidents. Đường dẫn ảnh tạo bằng UUID, không dùng tên upload do client cung cấp.

`repositories/postgres.ts` implement cùng interface qua `pg`, không đổi contract. Schema backend riêng `civicmerge` có incidents/reports/history/confirmations và ledger migration. Confirm dùng một transaction `READ COMMITTED`, khóa report rồi incident đích, lưu snapshot response cùng history trước commit. Hai report cùng merge một incident tuần tự tăng count qua khóa hàng; retry không tính lại snapshot. Lỗi validation/SQL rollback toàn bộ. Đọc detail dùng `REPEATABLE READ READ ONLY` để count/reports/history nhất quán. `reset()` của adapter luôn từ chối, độc lập cấu hình HTTP.

`STORAGE_PROVIDER=supabase` inject adapter REST bucket private. `image_url`/`cover_image_url` lưu marker `https://civicmerge-storage.invalid/<bucket>/<prefix>/<uuid>.<ext>`, chứa bucket/key bền vững thay vì signed URL hoặc host local. HTTP boundary map marker sang `${PUBLIC_BASE_URL}/api/images/...`; proxy tải bytes có authentication backend và trả ảnh đã validate. Repository không đổi transaction/snapshot, không cần sửa migration cũ. `/uploads` vẫn phục vụ file local legacy; URL legacy giữ nguyên, cần giữ host/thư mục cũ hoặc chuyển dữ liệu có kiểm soát.

Analyze validate output AI/matching trước upload; tạo pending report sau upload. Chỉ xóa object mới khi chắc chắn chưa có report tham chiếu. Lỗi INSERT transport/cancellation chưa rõ kết quả giữ object; lỗi sau khi đã lưu report không xóa ảnh. SQLSTATE lỗi INSERT xác định được chuyển thành `PendingReportWriteRejected`; cleanup thất bại không che lỗi gốc. Không có job tự động quét/xóa ảnh/dữ liệu thật.

Registry `AdapterFactories` lắp `createOpenAIVision` của Người 2 và `createGpsFeatureMatcher` của Người 4 qua shared interfaces. Server và `backend:check` đọc `apps/api/.env` (process env ưu tiên), đăng ký factory cố định từ workspace; không nhận module path từ env. `AI_PROVIDER=openai` bắt buộc có `OPENAI_API_KEY`/`OPENAI_MODEL`; không tự chọn model hoặc fallback khi thiếu key. Timeout mặc định 18.000 ms được truyền cho adapter để abort upstream và wrapper giới hạn thời gian chờ của backend. `DomainError` giữ status/code. Health giữ status/mode và capabilities; `mode=real` chỉ khi PostgreSQL + Storage + cả hai module đều được chọn thật, không phải bằng chứng đã nghiệm thu dịch vụ thật.

Matching đã nhận source `de31d6d`, có unit/HTTP tests chạy thuật toán thật; OpenAI đã nhận source `9a6d7f6`, kiểm thử adapter bằng phản hồi mạng giả lập. Chưa gọi OpenAI thật vì thiếu cấu hình/ảnh mẫu. Xem [chuẩn bị tích hợp](BACKEND_MERGE_READINESS.md). Repositories chặn merge mới vào resolved sau khi kiểm tra confirmation cũ, giữ retry snapshot ngay cả khi incident resolved sau đó. Không thêm status workflow hoặc sửa migration cũ. Mobile dùng health capabilities để phân biệt AI/matching trong mixed mode và chỉ bật controls nếu toàn bộ provider là mock/memory/local cùng cấu hình cho phép.

Đã bổ sung đầy đủ nền tảng cho vận hành Production / Pilot:
- **Xác thực & phân quyền (`AUTH_MODE=off|jwt`):** `createHs256JwtVerifier` bằng `node:crypto` (kiểm tra chữ ký `timingSafeEqual`, `exp`/`nbf`/`sub`), cộng thêm `createSupabaseAuthClient` cho `POST /api/auth/login` & `POST /api/auth/signup` khi cấu hình `SUPABASE_PUBLISHABLE_KEY`; lưu `reporter_id`, chặn xác nhận chéo chủ sở hữu (403 `FORBIDDEN`), phân quyền `citizen`/`operator`/`admin` cho cập nhật trạng thái/đổi tổ/tải ảnh nghiệm thu, bảo vệ ảnh proxy qua Bearer/`?token=`.
- **Persistence, Routing động & Tích hợp thực địa:** Migration `202611240000_incident_query_indexes.sql`, `202611240001_incident_lifecycle.sql` và `202611240002_auth_and_production.sql` (giữ nguyên migration gốc); lọc không gian bounding-box `listNearbyOpen`, tìm kiếm `?q=`, `?mine=true`, lưu `analyze_idempotency` trong PostgreSQL, tự động nạp bảng `civicmerge.routing_rules` vào `createRuleRouter` khi khởi động backend PostgreSQL, best-effort reverse geocoding (`createNominatimGeocoder`, `GEOCODER_ENABLED=true`) điền `incidents.address`, best-effort Expo Push (`createExpoPushNotifier`, `PUSH_NOTIFICATIONS_ENABLED=true`) khi đổi trạng thái, và CLI `maintenance:cleanup` dọn pending quá hạn an toàn (`--dry-run` mặc định).
- **Web Admin (`apps/web-admin/`) & Mobile (`apps/mobile/`):** Dashboard điều phối Smart City dùng chung `@civicmerge/contracts` (Light/Dark theme toggle, modal đăng nhập Email/Mật khẩu hoặc Operator Key/JWT, ảnh thumbnail 46×46 trong hàng đợi, tab Bản đồ điểm nóng GPS, Status Stepper 3 bước và 3 tab chi tiết `Xử lý · Minh chứng · Lịch sử`); Mobile có Hero bar gọn, thanh chip lọc 1 hàng cuộn ngang, phân trang thật (infinite scroll), tìm kiếm, lọc *"Phản ánh của tôi"*, tự động lấy GPS ngầm trên `ReportScreen`, đối chiếu 2 ảnh song song & ghi chú/chỉnh mức độ trên `ResultScreen`, Status Stepper 3 bước + địa chỉ đường + ảnh nghiệm thu trên `DetailScreen`, modal Đăng nhập Email/Mật khẩu & cấu hình máy chủ 2 tab và `app.config.ts` tự tắt `usesCleartextTraffic` khi `APP_ENV=production`.
- **Hardening, CI & Container:** `X-Request-Id`, structured JSON logging an toàn, rate limiter cho `analyze`, security headers, `ETag`/`304`, `/health/ready`, `Dockerfile` multi-stage Node 24 non-root và GitHub Actions CI (`.github/workflows/ci.yml`).

Xem [bàn giao Storage](BACKEND_STORAGE.md), [database/TLS/migration](../supabase/README.md), [hướng dẫn triển khai Production](PRODUCTION_DEPLOY.md), [báo cáo Mốc 1–5](OVERNIGHT_DELIVERY_REPORT.md) và [báo cáo hoàn thiện Mốc 6–10](PRODUCTION_COMPLETION_REPORT.md).
