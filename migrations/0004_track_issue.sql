-- Each incident leaves a record in Gateweave's own Track workspace (src/track.ts): an issue when it
-- opens, a comment when it ends. These columns say how far that has got, so a retry or a second
-- run never files twice.

-- The issue's key, such as WEB-52, and when it was filed.
ALTER TABLE incident ADD COLUMN track_issue TEXT;
ALTER TABLE incident ADD COLUMN track_filed_at INTEGER;
-- When the comment about the end went.
ALTER TABLE incident ADD COLUMN track_closed_noted_at INTEGER;
-- Tries begun, and when the next may begin. A try claims the incident by moving the second forward
-- before it calls Track, so a run that dies in the middle leaves a retry, not a second filing.
ALTER TABLE incident ADD COLUMN track_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incident ADD COLUMN track_retry_at INTEGER;
-- When it was given up on, after three days of trying.
ALTER TABLE incident ADD COLUMN track_gave_up_at INTEGER;

-- Incidents from before this are not filed once the settings come on.
UPDATE incident SET track_gave_up_at = 0;
