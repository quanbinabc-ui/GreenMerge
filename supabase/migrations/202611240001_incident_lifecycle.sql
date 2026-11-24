-- Lifecycle extension: resolution metadata on incidents and general incident_events table.
-- Existing civicmerge.history table is preserved for backward compatibility.
ALTER TABLE civicmerge.incidents
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE TABLE IF NOT EXISTS civicmerge.incident_events (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES civicmerge.incidents(id) ON DELETE RESTRICT,
  report_id uuid REFERENCES civicmerge.reports(id) ON DELETE RESTRICT,
  event text NOT NULL CHECK (event IN ('created', 'report_merged', 'status_changed', 'team_reassigned')),
  from_status text CHECK (from_status IS NULL OR from_status IN ('open', 'in_progress', 'resolved')),
  to_status text CHECK (to_status IS NULL OR to_status IN ('open', 'in_progress', 'resolved')),
  note text,
  actor text,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS incident_events_by_incident
  ON civicmerge.incident_events (incident_id, at, id);

ALTER TABLE civicmerge.incident_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE civicmerge.incident_events FROM PUBLIC;
