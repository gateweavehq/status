-- A service can be slow as well as down: it answers, but every check for five minutes took longer
-- than SLOW_MS (src/check.ts). A slow spell is an incident of its own kind, told and listed like an
-- outage. Outages from before are 'down'.
ALTER TABLE incident ADD COLUMN kind TEXT NOT NULL DEFAULT 'down' CHECK (kind IN ('down', 'slow'));
