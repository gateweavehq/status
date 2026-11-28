-- Manual incidents and maintenance windows are incidents too, but they are written through the
-- signed endpoint rather than inferred from checks. SQLite cannot widen a CHECK constraint in
-- place, so the table is rebuilt with the same rows and columns.
CREATE TABLE incident_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	service TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	error TEXT,
	alerted_at INTEGER,
	resolved_alerted_at INTEGER,
	kind TEXT NOT NULL DEFAULT 'down' CHECK (kind IN ('down', 'slow', 'manual', 'maintenance')),
	track_issue TEXT,
	track_filed_at INTEGER,
	track_closed_noted_at INTEGER,
	track_attempts INTEGER NOT NULL DEFAULT 0,
	track_retry_at INTEGER,
	track_gave_up_at INTEGER
);

INSERT INTO incident_new (
	id, service, started_at, ended_at, error, alerted_at, resolved_alerted_at, kind,
	track_issue, track_filed_at, track_closed_noted_at, track_attempts, track_retry_at,
	track_gave_up_at
)
SELECT
	id, service, started_at, ended_at, error, alerted_at, resolved_alerted_at, kind,
	track_issue, track_filed_at, track_closed_noted_at, track_attempts, track_retry_at,
	track_gave_up_at
FROM incident;

DROP TABLE incident;
ALTER TABLE incident_new RENAME TO incident;
CREATE INDEX incident_by_service ON incident (service, ended_at);
CREATE INDEX incident_by_start ON incident (started_at);
