-- Production schema extensions: auth profiles, reporter ownership, resolution photos,
-- persistent analyze idempotency, dynamic geofenced routing rules, and push tokens.
-- Previous migrations (202611130001, 202611240000, 202611240001) remain untouched.

CREATE TABLE IF NOT EXISTS civicmerge.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen', 'operator', 'admin')),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE civicmerge.reports
  ADD COLUMN IF NOT EXISTS reporter_id uuid,
  ADD COLUMN IF NOT EXISTS user_note text;

CREATE INDEX IF NOT EXISTS reports_by_reporter
  ON civicmerge.reports (reporter_id, created_at DESC, id DESC)
  WHERE reporter_id IS NOT NULL;

ALTER TABLE civicmerge.incidents
  ADD COLUMN IF NOT EXISTS resolution_image_url text,
  ADD COLUMN IF NOT EXISTS address text;

ALTER TABLE civicmerge.incident_events
  ADD COLUMN IF NOT EXISTS actor_id uuid;

CREATE TABLE IF NOT EXISTS civicmerge.analyze_idempotency (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS analyze_idempotency_by_expires
  ON civicmerge.analyze_idempotency (expires_at);

CREATE TABLE IF NOT EXISTS civicmerge.routing_rules (
  id uuid PRIMARY KEY,
  incident_type text NOT NULL CHECK (incident_type IN ('pothole', 'trash', 'flood')),
  team_name text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  min_lat double precision,
  max_lat double precision,
  min_lng double precision,
  max_lng double precision,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (min_lat IS NULL AND max_lat IS NULL AND min_lng IS NULL AND max_lng IS NULL) OR
    (min_lat IS NOT NULL AND max_lat IS NOT NULL AND min_lng IS NOT NULL AND max_lng IS NOT NULL
      AND min_lat >= -90 AND max_lat <= 90 AND min_lat <= max_lat
      AND min_lng >= -180 AND max_lng <= 180 AND min_lng <= max_lng)
  )
);

INSERT INTO civicmerge.routing_rules (id, incident_type, team_name, priority, active)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'pothole', 'Tổ đường bộ (thí điểm)', 0, true),
  ('00000000-0000-4000-8000-000000000002', 'trash', 'Tổ vệ sinh (thí điểm)', 0, true),
  ('00000000-0000-4000-8000-000000000003', 'flood', 'Tổ thoát nước (thí điểm)', 0, true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS civicmerge.push_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  expo_push_token text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS push_tokens_by_user
  ON civicmerge.push_tokens (user_id);

ALTER TABLE civicmerge.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE civicmerge.analyze_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE civicmerge.routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE civicmerge.push_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE civicmerge.profiles FROM PUBLIC;
REVOKE ALL ON TABLE civicmerge.analyze_idempotency FROM PUBLIC;
REVOKE ALL ON TABLE civicmerge.routing_rules FROM PUBLIC;
REVOKE ALL ON TABLE civicmerge.push_tokens FROM PUBLIC;
