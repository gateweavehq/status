-- Each check of each service, kept for a week: what an incident is worked out from, and what a
-- question about a bad minute is answered with.
CREATE TABLE check_result (
	service TEXT NOT NULL,
	-- The minute the cron ran for, in milliseconds since 1970.
	at INTEGER NOT NULL,
	ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
	-- The status the service answered, or NULL when it didn't.
	status INTEGER,
	ms INTEGER NOT NULL,
	-- Describes the answer, never its body.
	error TEXT,
	PRIMARY KEY (service, at)
);

CREATE INDEX check_result_by_time ON check_result (at);

-- Each service's checks per UTC day, kept for good: the page's 90 days are drawn from it.
CREATE TABLE daily (
	service TEXT NOT NULL,
	-- YYYY-MM-DD, in UTC.
	day TEXT NOT NULL,
	checks INTEGER NOT NULL,
	failures INTEGER NOT NULL,
	total_ms INTEGER NOT NULL,
	PRIMARY KEY (service, day)
);

-- Where each service stands, so a check knows what the ones before it said.
CREATE TABLE service_state (
	service TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('up', 'down')),
	-- Since when it has been up or down.
	since INTEGER NOT NULL,
	-- Failed checks in a row, and when the first of them was; 0 and NULL while it works.
	failures INTEGER NOT NULL,
	failing_since INTEGER,
	checked_at INTEGER NOT NULL,
	last_ms INTEGER,
	last_error TEXT
);

-- An outage: from the first failed check of the run that took a service down to the check that
-- found it working again.
CREATE TABLE incident (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	service TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	-- What the check that took it down saw.
	error TEXT,
	-- When the alerts went: that it is down, and that it is back.
	alerted_at INTEGER,
	resolved_alerted_at INTEGER
);

CREATE INDEX incident_by_service ON incident (service, ended_at);
CREATE INDEX incident_by_start ON incident (started_at);
