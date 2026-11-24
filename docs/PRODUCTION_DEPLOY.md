# CivicMerge — Hướng dẫn triển khai Production

Tài liệu này mô tả cách đưa **CivicMerge Backend (`@civicmerge/api`)** và **Web Admin (`@civicmerge/web-admin`)** lên môi trường production có HTTPS, xác thực JWT, PostgreSQL + Supabase Storage private và tác vụ dọn dữ liệu định kỳ.

---

## 1. Biến môi trường bắt buộc cho Production

Đặt cấu hình qua secret manager hoặc file `.env` trên máy chủ (tuyệt đối không commit vào Git):

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=https://api.civicmerge.example.com

# Tắt hoàn toàn mock và khóa chế độ real (không fallback mock nếu thiếu cấu hình)
MOCK_MODE=false
PERSISTENCE_MODE=postgres
STORAGE_PROVIDER=supabase
AI_PROVIDER=openai
MATCHING_PROVIDER=real

# Database (dùng role runtime tối thiểu, không dùng superuser)
DATABASE_URL=postgresql://civicmerge_app:<password>@<db-host>:5432/postgres
DATABASE_SSL=verify
# DATABASE_SSL_CA_FILE=/etc/ssl/certs/supabase-ca.crt

# Supabase Storage private bucket & Supabase Auth
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_<backend-secret>
SUPABASE_PUBLISHABLE_KEY=sb_publishable_<public-key>
SUPABASE_STORAGE_BUCKET=civicmerge-evidence
SUPABASE_STORAGE_PREFIX=evidence
STORAGE_TIMEOUT_MS=10000

# OpenAI Vision (chỉ ở backend)
OPENAI_API_KEY=<openai-api-key>
OPENAI_MODEL=<vision-model>
AI_TIMEOUT_MS=18000
MATCHING_TIMEOUT_MS=3000

# Bảo mật & phân quyền
AUTH_MODE=jwt
AUTH_JWT_SECRET=<supabase-jwt-secret-toi-thieu-32-ky-tu>
# AUTH_JWT_ISSUER=https://<project-ref>.supabase.co/auth/v1
# AUTH_JWT_AUDIENCE=authenticated
OPERATOR_API_KEY=<optional-break-glass-operator-key>
CORS_ALLOWED_ORIGINS=https://admin.civicmerge.example.com

# Chống lạm dụng, Tích hợp thực địa & Logging
ANALYZE_RATE_LIMIT_MAX=20
ANALYZE_RATE_LIMIT_WINDOW_MS=60000
PUSH_NOTIFICATIONS_ENABLED=true
GEOCODER_ENABLED=true
REQUEST_LOGS=true
```

---

## 2. Chạy Migration & Kiểm tra sẵn sàng trước khi mở traffic

Chạy migration bằng tài khoản owner (đặt tạm `MIGRATION_DATABASE_URL` trong phiên chạy migration, không lưu vào runtime app):

```sh
npm run db:migrate
npm run backend:check
```

Kiểm tra `backend:check` trả `"mode": "real"` và cả 4 provider đều thật trước khi khởi động dịch vụ.

### Tạo Database Role tối thiểu cho Runtime

```sql
-- Chạy bằng tài khoản owner trên Supabase/PostgreSQL:
CREATE ROLE civicmerge_app LOGIN PASSWORD '<strong-password>';
GRANT USAGE ON SCHEMA civicmerge TO civicmerge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA civicmerge TO civicmerge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA civicmerge
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO civicmerge_app;
```

---

## 3. Triển khai bằng Docker (VM FPT Cloud / Ubuntu + Nginx HTTPS)

### Bước 1 — Build & chạy container API

```sh
docker build -t civicmerge-api:latest .
docker run -d --name civicmerge-api --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file /etc/civicmerge/api.env \
  civicmerge-api:latest
```

Kiểm tra health & readiness nội bộ:

```sh
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/health/ready
```

### Bước 2 — Reverse Proxy HTTPS bằng Nginx + Let's Encrypt

```nginx
server {
  listen 443 ssl http2;
  server_name api.civicmerge.example.com;

  client_max_body_size 10m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 35s;
  }
}
```

### Bước 3 — Triển khai Web Admin (`apps/web-admin`)

Build bộ tệp tĩnh:

```sh
npm run build:admin
```

Serve thư mục `apps/web-admin/public/` làm web root và mount `apps/web-admin/dist/` tại `/dist/` trên Nginx (hoặc CDN tĩnh như Cloudflare Pages / Netlify), nhớ thêm origin của Web Admin vào `CORS_ALLOWED_ORIGINS` của API.

---

## 4. Triển khai trên PaaS (Render / Railway / Fly.io)

- Trỏ repository vào `Dockerfile` ở root.
- Cấu hình Health Check Path là `/health/ready`.
- Nhập đầy đủ biến môi trường ở Mục 1 (không upload `.env`).
- Đặt `PUBLIC_BASE_URL` bằng đúng HTTPS URL mà PaaS cấp.

---

## 5. Vận hành định kỳ, Sao lưu & Build Mobile Production

- **Dọn pending report quá hạn & ảnh orphan** (cron mỗi ngày lúc 03:00):
  ```sh
  # Kiểm tra trước (không xóa dữ liệu):
  npm run maintenance:cleanup -- --hours=48
  # Thực thi xóa an toàn các pending report > 48h và ảnh tương ứng:
  npm run maintenance:cleanup -- --apply --hours=48
  ```
- **Sao lưu:** Bật Point-in-Time Recovery / daily backup trên Supabase PostgreSQL và diễn tập khôi phục định kỳ.
- **Mobile Production Build:**
  - Đặt `EXPO_PUBLIC_API_URL=https://api.civicmerge.example.com` (HTTPS).
  - Build bằng profile `production` trong `apps/mobile/eas.json` (`APP_ENV=production` tự động tắt `usesCleartextTraffic` trên Android qua `apps/mobile/app.config.ts`).
