-- What the error watch found in each 15-minute window that crossed the line, and when its alert
-- went. A key sent in the last six hours doesn't alert again. Kept for 90 days.
CREATE TABLE error_alert (
	-- `http:<host>`, `worker:<script>`, or `watch` when the analytics couldn't be read.
	key TEXT NOT NULL,
	-- The end of the window, in milliseconds since 1970.
	window_end INTEGER NOT NULL,
	errors INTEGER NOT NULL,
	total INTEGER NOT NULL,
	-- The alert's line: counts and statuses, never a request's content.
	text TEXT NOT NULL,
	-- When the alert went, or NULL when it didn't: quiet time, or the email failed.
	sent_at INTEGER,
	PRIMARY KEY (key, window_end)
);

CREATE INDEX error_alert_by_sent ON error_alert (sent_at);
