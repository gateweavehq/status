# Self-hosting

Gateweave Status runs as one Cloudflare Worker with a D1 database. `wrangler.jsonc` is a template:
every value that belongs to you is a placeholder or a commented example. Gateweave Cloud's own
page is deployed from a private copy that fills them in with its own values.

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

| Secret            | Purpose                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ALERT_TO`        | One address or a comma-separated list for incident and error-watch email. Without it, incidents show only on the page.         |
| `ANALYTICS_TOKEN` | Reads Cloudflare analytics for `ERROR_WATCH`: Account Analytics Read on its account, Analytics Read on its zone.               |
| `TRACK_KEY`       | An agent member's key (made in the workspace's settings, under Agents), for filing issues. Needs all four `TRACK_*` variables. |

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

Leave it out to turn the watch off.

## Incidents in Track

Set `TRACK_URL`, `TRACK_WORKSPACE`, `TRACK_TEAM` and the secret `TRACK_KEY` and each incident is
filed as an issue, with one comment when it ends. Without all four, nothing is filed. The README
describes how.

## Keeping a copy up to date

Pull this repository's changes and run `pnpm run deploy` again; migrations are append-only, so
an update never rewrites yours. A copy that keeps its real values in `wrangler.jsonc` will see
conflicts on that file: keep your values and take the new settings from the template.
