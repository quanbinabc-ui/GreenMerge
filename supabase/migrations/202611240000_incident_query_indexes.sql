-- Indexes to support filtered listing and nearby open incident lookup without full table scans.
CREATE INDEX IF NOT EXISTS incidents_by_type_status_location
  ON civicmerge.incidents (type, status, latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND status <> 'resolved';

CREATE INDEX IF NOT EXISTS incidents_by_filters_created
  ON civicmerge.incidents (status, type, severity, created_at DESC, id DESC);
