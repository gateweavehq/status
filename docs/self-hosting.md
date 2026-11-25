# Self-hosting

Gateweave Status runs as one Cloudflare Worker with a D1 database. The top level of
`wrangler.jsonc` is a template: every value that belongs to you is a placeholder or a commented
example, and it is what `pnpm run deploy` deploys. Gateweave Cloud's own page is the named
environment `cloud` in the same file, and `pnpm run deploy:cloud` deploys that one (see
[Gateweave Cloud's own deployment](#gateweave-clouds-own-deployment)). The file names no Cloudflare
account and no zone. Your account is the one you are logged in to, or `CLOUDFLARE_ACCOUNT_ID` in the
environment.

## What you need

- A Cloudflare account, and a domain on it for the page.
- Node.js 24 and pnpm 12.
- Optional: Cloudflare Email Sending on a domain you own, for email alerts.
- Optional: a Track workspace and an agent member's key, for incident issues.

## First deploy

1. Install and log in:

   ```sh
   pnpm install
   npx wrangler login
   ```

2. Create the database and put the id it prints in `d1_databases[0].database_id`:

   ```sh
   npx wrangler d1 create status
   ```

3. Edit `wrangler.jsonc`: replace the route, the sender in `send_email` and `ALERT_FROM`, and
   `SERVICES`. Set the optional settings below you want.
4. Set the secrets you need (see Secrets), then deploy:

   ```sh
   pnpm run deploy
   ```

   `pnpm run deploy` applies the D1 migrations to the remote database, then deploys the Worker, so
   the cron never meets an older schema. Run it again for every update.

5. Open your page. The first check runs within a minute.

`pnpm verify` runs the repository's checks (Biome, the type check and the tests) before a deploy.

## Settings

Plain settings go in `vars` in `wrangler.jsonc`. Only `SERVICES` is required.

| Setting            | What                                                                                                  | Without it                            |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `SERVICES`         | The services to check, below                                                                          | The Worker does not run               |
| `PAGE_NAME`        | The page's name: its title, heading and what alerts and issues sign with                              | "Status"                              |
| `PAGE_DESCRIPTION` | The page's description, for search results and link previews                                          | A neutral sentence                    |
| `PAGE_URL`         | The page's own address. Alerts and issues link to it and the checks' user agent names it              | No link, user agent `StatusMonitor/1` |
| `HOME_URL`         | Where the heading and the footer link, such as your site                                              | No link                               |
| `ALERT_FROM`       | The sender of alert email, such as `Status <status@example.com>`; its address must be in `send_email` | No email                              |
| `ERROR_WATCH`      | The error watch, below                                                                                | Off                                   |
| `TRACK_URL`        | Track's address, such as `https://track.example.com`                                                  | Nothing is filed                      |
| `TRACK_WORKSPACE`  | The Track workspace's slug                                                                            | Nothing is filed                      |
| `TRACK_TEAM`       | The Track team's key for issues, unless a service names a `team`                                      | Nothing is filed                      |
| `TRACK_LABELS`     | Label names for each issue, comma-separated; they must exist                                          | No labels                             |

## Secrets

Set each with `npx wrangler secret put NAME`. For local runs keep them in `.dev.vars`, which Git
ignores. There is no example file.

| Secret                                    | Purpose                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ALERT_TO`                                | One address or a comma-separated list for incident and error-watch email. Without it, incidents show only on the page.         |
| `ANALYTICS_TOKEN`                         | Reads Cloudflare analytics for `ERROR_WATCH`: Account Analytics Read on its account, Analytics Read on its zone.               |
| `ERROR_WATCH_ACCOUNT`, `ERROR_WATCH_ZONE` | Optional. The account's and the zone's ids for `ERROR_WATCH`, when it leaves `account` and `zone` out.                         |
| `TRACK_KEY`                               | An agent member's key (made in the workspace's settings, under Agents), for filing issues. Needs all four `TRACK_*` variables. |

## Watching your services

`SERVICES` is a list of HTTPS health URLs, in the order the page shows them. Each entry needs a
stable `id` (lower-case letters, digits and dashes, up to 32), a `name` and a `url`. It may set
`expect` (the status that means up, 200 by default), `contains` (text the body must include), or
`team` (a Track team's key). Keep an `id` stable after the first deploy: D1 stores history under
it. A service on a Custom Domain in the same zone as the Worker can be checked; one on a route
can't be fetched from a Worker on that zone.

Watching other services is configuration only, not a code change.

## The error watch

A health check can't see a page or API that broke while the service still answers. With
`ERROR_WATCH` and `ANALYTICS_TOKEN` set, every 15 minutes the Worker asks Cloudflare's analytics
how often your hosts answered 5xx and your Workers failed, and emails when the count and share
reach the thresholds:

```jsonc
"ERROR_WATCH": {
	"account": "<your account id>",
	"zone": "<your zone id>",
	"hosts": ["example.com", "api.example.com"],
	"scripts": ["my-site-worker"],
	"minErrors": 10,
	"minShare": 0.05
}
```

`account` and `zone` may be left out of the setting and set as the secrets `ERROR_WATCH_ACCOUNT`
and `ERROR_WATCH_ZONE` instead, so that a file you publish names neither. Gateweave Cloud does this.
Leave `ERROR_WATCH` out to turn the watch off.

## Incidents in Track

Set `TRACK_URL`, `TRACK_WORKSPACE`, `TRACK_TEAM` and the secret `TRACK_KEY` and each incident is
filed as an issue, with one comment when it ends. Without all four, nothing is filed. The README
describes how.

## Keeping a copy up to date

The checks send the user agent `StatusMonitor/1`, with ` (+PAGE_URL)` when `PAGE_URL` is set (older
versions sent `GateweaveStatus/1`). If a firewall rule or allowlist of a checked service matches the
user agent, update it when you take this change.

Pull this repository's changes and run `pnpm run deploy` again; migrations are append-only, so
an update never rewrites yours. A copy that keeps its real values in `wrangler.jsonc` will see
conflicts on that file: keep your values and take the new settings from the template. To keep your
values apart from the template, put them in a named environment of the same file, as Gateweave
Cloud does below, and add scripts like `deploy:cloud` for it.

## Gateweave Cloud's own deployment

status.gateweave.com is the environment `cloud` of `wrangler.jsonc`, in the same file and the same
repository as the template, the way Gateweave's other products keep theirs. Wrangler does not carry
bindings and variables into an environment, so `cloud` repeats the ones the Worker needs: its name
(`gateweave-status`), the Custom Domain `status.gateweave.com`, the D1 database `gateweave-status`
with its id, the cron trigger, the `EMAIL` binding, and every variable, with the page's name,
description, address and home link. A database's id names a resource and grants nothing. The file
names no Cloudflare account and no zone: the account is `CLOUDFLARE_ACCOUNT_ID` in the environment,
and Cloudflare finds the zone from the Custom Domain. The error watch's account and zone ids are
the secrets `ERROR_WATCH_ACCOUNT` and `ERROR_WATCH_ZONE`.

The next deploy of status.gateweave.com, and every one after it, is:

```sh
export CLOUDFLARE_ACCOUNT_ID=<Gateweave's account id>   # PowerShell: $env:CLOUDFLARE_ACCOUNT_ID = "..."
pnpm run deploy:cloud
```

with Wrangler logged in to that account (or `CLOUDFLARE_API_TOKEN` set). `pnpm run deploy:cloud` runs
`pnpm run db:migrate:cloud` (`wrangler d1 migrations apply DB --remote --env cloud`) and then
`wrangler deploy --env cloud`, so the cron never meets an older schema. It updates the live Worker
`gateweave-status` in place. Never run plain `pnpm run deploy` for it: that deploys the template.

Before the first deploy of this version, set the two secrets, or the error watch stops: its
`ERROR_WATCH` no longer carries the ids.

```sh
npx wrangler secret put ERROR_WATCH_ACCOUNT --env cloud
npx wrangler secret put ERROR_WATCH_ZONE --env cloud
```
