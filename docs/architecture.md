# Architecture

Gateweave Status is one Cloudflare Worker with one D1 database. This page describes what the code
does today.

## Checks and the minute's work

The Cron Trigger in `wrangler.jsonc` runs every minute (`* * * * *`). The scheduled handler in
`src/index.ts` starts the service checks and the error watch side by side. A failed error watch
does not stop checks, or the other way around.

`SERVICES` in `wrangler.jsonc` lists the services in the order the page shows them. Gateweave
Cloud's, in `env.cloud`, are Website, ID, Track, Agents, Guard, Mail, Growth and Track demo. Each entry has an HTTPS URL and may name an expected status, text that
must occur in its answer, and a Track team. `src/config.ts` checks the entries before use.

`src/check.ts` fetches each URL with a 10-second limit. It expects 200 unless the service says
otherwise. Redirects are checked as answers, not followed. If `contains` is set, it reads up to
64 KiB and checks for that text. A failed check is tried once more after two seconds. The result
keeps the status, duration and a short error, never the answer's body. The checks run together.

`src/monitor.ts` skips a minute already in D1, saves the results and updates each service's state.
It then sends due alerts and files incidents in Track. Each hour it removes check results older
than seven days.

## Incidents and alerts

Two failed minutes in a row take a service down. The outage starts at the first failed minute;
the first passing check closes it. Five passing but slow checks in a row, each taking at least
three seconds, open a separate slow incident from the first slow minute. Three quick checks close
it. An outage ends a slow incident, and the outage's alert takes over.

`src/alerts.ts` emails the start and recovery through the `EMAIL` binding when `ALERT_TO` is set.
It records when each email went so one is sent once. Failed sends are retried on later minutes for
up to three days. The page still shows incidents without email settings.

With Track settings, `src/track.ts` files an outage at once and a slow incident after 15 minutes.
Gateweave Cloud's configuration (`env.cloud`) files into the `gateweave` workspace. A service's
`team` sets its team: ID, TRK, AGT, GRD, MAIL or MMO; Website uses the default `WEB`. Track demo
uses TRK. The template's top level sets no Track workspace, so nothing is filed. The issue carries
an incident marker and stays open when the incident ends. Status adds one end comment; a person
closes the issue with the cause. Filing runs after email and catches its own failures. It retries
with a growing wait for up to three days and stores its progress on the incident row.

Every 15 minutes, `src/errors.ts` also asks Cloudflare analytics about 5xx answers on configured
hosts and failures of configured Workers and their Durable Objects. It checks a 15-minute window
that ended two minutes earlier. The current threshold is ten events and 5% of requests.
A Durable Object's response stream disconnects are not counted. Its caller is always one of our
Workers, and Cloudflare counts that Worker closing the stream as a disconnect of the object. The
Agents SDK's MCP servers, such as Growth's, make one for every request they answer. A Worker that
fails while reading counts among its own invocations. A Worker's execution errors and response
stream disconnects use separate keys. If neither crosses the
threshold on its own but their total does, a mixed finding uses its own key. Each key that alerted
stays quiet for six hours. Existing alerts keep their history, and a split category may alert once
during the transition even if a recent combined alert went out.

## What D1 stores

The append-only migrations in `migrations/` define:

- `check_result`: each service's result for a minute, kept for seven days.
- `daily`: each service's UTC daily check count, failure count and total duration, kept for good.
- `service_state`: the last state, failure streak, times and last short error.
- `incident`: outage and slow start and end times, alert times, and Track issue and retry progress.
- `error_alert`: error-watch findings and send times, kept for 90 days.

No checked service's response body is stored.

## Page and API

`src/status.ts` reads D1 for current states, the last 90 UTC days of counts, and up to 20 recent
incidents from the last 30 days plus open ones. A service with no check in five minutes is
`unknown`. `src/page.ts` renders the HTML on the server. It loads no outside script, font or
image and reloads every minute.

`src/index.ts` serves `GET` and `HEAD` for `/`, `/api/status` (the same data as JSON),
`/api/fresh` and `/favicon.svg`. `/api/fresh` is for a monitor outside Cloudflare, which reads only
the status code: 200 while the newest check of any service is at most `STALE_MS` old, 503 after
that or before any check, with one line of text saying which, and `Cache-Control: no-store`. The page and JSON use `Cache-Control: no-cache`, so they are checked again rather
than served as stale status. The favicon is public and cached for one day. The page has a content
security policy that allows its inline styles and its own image only.
