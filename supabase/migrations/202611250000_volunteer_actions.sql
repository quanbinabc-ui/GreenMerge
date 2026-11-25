-- Tier-2 Community Volunteer Actions ("Buổi Tình Nguyện Xanh") and Green Volunteer Certificates.
-- Previous migrations (202611130001, 202611240000, 202611240001, 202611240002) remain untouched.

ALTER TABLE civicmerge.incident_events
  DROP CONSTRAINT IF EXISTS incident_events_event_check;

ALTER TABLE civicmerge.incident_events
  ADD CONSTRAINT incident_events_event_check CHECK (
    event IN (
      'created',
      'report_merged',
      'status_changed',
      'team_reassigned',
      'volunteer_event_created',
      'volunteer_after_submitted',
      'volunteer_verified'
    )
  );

CREATE TABLE IF NOT EXISTS civicmerge.volunteer_events (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES civicmerge.incidents(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  scheduled_at timestamptz NOT NULL,
  meeting_point text NOT NULL,
  max_participants integer NOT NULL CHECK (max_participants >= 2 AND max_participants <= 50),
  participant_count integer NOT NULL DEFAULT 0 CHECK (participant_count >= 0 AND participant_count <= max_participants),
  status text NOT NULL DEFAULT 'recruiting' CHECK (status IN ('recruiting', 'in_progress', 'pending_review', 'verified', 'cancelled')),
  organizer_id uuid,
  organizer_name text NOT NULL,
  before_image_url text NOT NULL,
  after_image_url text,
  review_note text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_event_per_incident
  ON civicmerge.volunteer_events (incident_id)
  WHERE status IN ('recruiting', 'in_progress', 'pending_review');

CREATE INDEX IF NOT EXISTS volunteer_events_by_status_created
  ON civicmerge.volunteer_events (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS volunteer_events_by_incident
  ON civicmerge.volunteer_events (incident_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS civicmerge.volunteer_participants (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES civicmerge.volunteer_events(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'checked_in', 'certified', 'cancelled')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS volunteer_participants_by_event
  ON civicmerge.volunteer_participants (event_id, joined_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS volunteer_participants_by_user
  ON civicmerge.volunteer_participants (user_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS civicmerge.volunteer_certificates (
  id uuid PRIMARY KEY,
  certificate_code text NOT NULL UNIQUE,
  event_id uuid NOT NULL REFERENCES civicmerge.volunteer_events(id) ON DELETE RESTRICT,
  event_title text NOT NULL,
  incident_id uuid NOT NULL REFERENCES civicmerge.incidents(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  recipient_name text NOT NULL,
  completed_at timestamptz NOT NULL,
  issued_by text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS volunteer_certificates_by_user
  ON civicmerge.volunteer_certificates (user_id, issued_at DESC, id DESC);

ALTER TABLE civicmerge.volunteer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE civicmerge.volunteer_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE civicmerge.volunteer_certificates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE civicmerge.volunteer_events FROM PUBLIC;
REVOKE ALL ON TABLE civicmerge.volunteer_participants FROM PUBLIC;
REVOKE ALL ON TABLE civicmerge.volunteer_certificates FROM PUBLIC;
