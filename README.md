# Gateweave Status

The status page of Gateweave Cloud, at [status.gateweave.com](https://status.gateweave.com). One
Cloudflare Worker checks each service every minute, keeps the results in D1, opens and closes
incidents, emails an alert when a service goes down or turns slow and when it recovers, and serves the
page.

- **A check** fetches a service's URL and expects a status (200 by default) within 10 seconds, and,
  where set, a piece of text in the body. A redirect counts as an answer, not something to follow.
  A failed check is tried once more after two seconds, so one dropped request is not an outage.
- **An incident** starts with the first failed check of two in a row and ends with the first check
  that passes.
- **A slow spell** is an incident of its own kind: a service that still answers, but took more
  than 3 seconds for five checks in a row. Three answers in time end it, and so does an outage,
  which then does the telling. On 2026-11-12 Agents took 3 to 6 seconds a page for ten minutes
  while every check passed; this is for that.
- **Alerts** go by email through Email Service's binding to `ALERT_TO`. One that couldn't go is
  tried again each minute for three days, and an outage that ended before its alert went is told
  once.
- **The error watch** catches what a health check can't: a page or API that broke while the
  service still answers. Every 15 minutes it asks Cloudflare's GraphQL analytics how often each
  watched host answered 5xx and each watched Worker and its Durable Objects failed (an exception,
  a limit; not a client that went away), over the 15 minutes that ended two minutes before. It emails when a service has at least `minErrors` errors
  and `minShare` of its requests failed, then stays quiet about that service for six hours. It
  needs `ERROR_WATCH` and the secret `ANALYTICS_TOKEN`: a token with Account Analytics Read on the
  account and Analytics Read on the zone. If the analytics can't be read, that is emailed too.
- **Track issues** are the record of an incident. When one opens, the Worker files an issue in
  Gateweave's own Track workspace, and when it ends it adds one comment with the end time and the
  length. It never changes the issue's status: a person closes it with the cause. An outage is
  filed at once, a slow spell once it has lasted 15 minutes (priority `high` and `medium`). The
  incident keeps the issue's key, so it is filed once; the description carries
  `status-incident:<id>`, and a retry that may follow a lost answer looks for the issue by its title
  before making another. Filing comes after the alert and never holds it back or fails the run: a
  filing or comment that fails is tried again with a growing wait (a minute, up to half an hour),
  for three days, then given up and logged once. It needs the settings below. Incidents from before
  they were turned on are not filed.
- **The page** shows each service's state, the last 90 days, and the incidents of the last 30. It
  loads nothing else and reloads every minute. `/api/status` has the same data as JSON.
- **What it keeps:** each check for a week, each day's counts and the incidents for good. No
  answer's body is kept or shown, only its status and how long it took.

It runs on Cloudflare, like what it checks, so it can't report an outage of Cloudflare itself. It
reports the failures of one product: a bad deploy, a broken database, an expired certificate.

## Running it

Requirements: Node.js 24 and pnpm 12.

| Command           | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `pnpm install`    | Install dependencies                           |
| `pnpm verify`     | Lint, type-check and test, as CI does          |
| `pnpm dev`        | Run it locally; `--test-scheduled` runs checks |
| `pnpm run deploy` | Deploy (`wrangler.jsonc` holds the services)   |

To deploy your own: create the database (`npx wrangler d1 create gateweave-status`), put its id in
`wrangler.jsonc` with your own `SERVICES`, route and sender, then:

```sh
npx wrangler d1 migrations apply gateweave-status --remote
npx wrangler deploy
npx wrangler secret put ALERT_TO
```

Filing incidents in Track is off until these are set, and nothing else changes without them:

| Setting           | Kind   | What                                                                       |
| ----------------- | ------ | -------------------------------------------------------------------------- |
| `TRACK_URL`       | var    | Track's address, such as `https://track.gateweave.com`                     |
| `TRACK_WORKSPACE` | var    | The workspace's slug                                                       |
| `TRACK_TEAM`      | var    | The key of the team the issues go to, such as `WEB`                        |
| `TRACK_LABELS`    | var    | Label names, comma-separated, such as `Operations`; they must exist        |
| `TRACK_KEY`       | secret | An agent member's key (`gwt_` and 43 characters), made in Track's settings |

Make the agent member in the workspace's settings, under Agents, and put its key in:

```sh
npx wrangler secret put TRACK_KEY
```

The agent is a member of the workspace like any other, so it needs no more than that. Set the
variables in `wrangler.jsonc`. If only some of the four required settings are there, or one is
wrong, nothing is filed and each run logs `misconfigured`. A label that doesn't exist makes Track
refuse the issue, which is retried until it is given up. The Worker talks to Track's `/mcp` with
plain JSON-RPC (`tools/call` for `create_issue`, `search_issues` and `add_comment`) and never logs
the key or what Track answered.

When deploying a version with this, apply the migration before the Worker (the commands above do),
as the cron reads its columns.

The sender's domain must be set up for Email Sending. A service on a Custom Domain in the same
zone can be checked; one on a route can't be fetched from a Worker on that zone.

## License

[AGPL-3.0](LICENSE).
