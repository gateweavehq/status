# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## The project

Gateweave Status checks Gateweave Cloud's services every minute and serves
[status.gateweave.com](https://status.gateweave.com). [README.md](README.md) says what it does.

| Path             | What lives there                                            |
| ---------------- | ----------------------------------------------------------- |
| `src/index.ts`   | The Worker: the page, `/api/status`, and the cron           |
| `src/config.ts`  | Reads `SERVICES`, and the `ConfigError` of a bad setting    |
| `src/brand.ts`   | Page name, description, links and user agent, from settings |
| `src/check.ts`   | One check of one service                                    |
| `src/monitor.ts` | A minute's work: checks, history, incidents                 |
| `src/alerts.ts`  | Alert emails                                                |
| `src/errors.ts`  | The error watch: Cloudflare analytics, every 15 minutes     |
| `src/track.ts`   | The Track issue for each incident, and its end comment      |
| `src/status.ts`  | What the page shows, read from D1                           |
| `src/page.ts`    | The HTML                                                    |
| `scripts/`       | `pnpm run deploy:cloud`'s preflight (names of secrets only) |
| `migrations/`    | D1 migrations, append-only                                  |
| `test/`          | Tests in workerd, with a stand-in for the checked services  |

## Commands

Requirements: Node.js 24 (see `.node-version`) and pnpm 12. `pnpm verify` runs what CI runs: Biome,
the type check and the tests. Run it before calling a change done.

## Rules

- **Nothing a service answers is kept or shown** beyond its status and timing. Errors describe the
  answer ("Answered 503, not 200."), never its body.
- **Migrations are append-only.** Never edit one that was merged.
- **An alert goes once.** Mark it in D1 when it has gone; one that couldn't go is retried, for
  three days.
- **Filing in Track never holds an alert back.** It runs after the alerts, catches its own
  failures, and keeps its progress on the incident's row (`track_*`), so an incident is filed once.
  The key is never logged or kept.
- The page loads nothing from elsewhere: no scripts, fonts or images. The CSP says so.
- TypeScript is strict, with `noUncheckedIndexedAccess`. Biome formats: tabs, 100 columns.
- Dependencies are pinned to exact versions.
- Commits follow Conventional Commits and carry no AI attribution.

## Gateweave Cloud's deployment

The top level of `wrangler.jsonc` is the public template that a self-hoster deploys: placeholders
only. Gateweave Cloud's page (status.gateweave.com) is the named environment `cloud` of the same
file, as in Track and Forms. It holds the Worker's name (`gateweave-status`), the Custom Domain, the
D1 database's id (the id of a resource, which grants nothing), the cron trigger, the `EMAIL`
binding and every variable: the services, the error watch's hosts and Workers, the Track settings,
and `PAGE_NAME`, `PAGE_DESCRIPTION`, `PAGE_URL` and `HOME_URL`. Wrangler does not inherit `vars` or
bindings (D1, `send_email`) into an environment, so a change that adds or renames a setting or a
binding at the top level needs the same change in `env.cloud`. It does inherit `routes`,
`triggers`, `observability` and `workers_dev`, and without its own `name` an environment becomes
`<name>-cloud` (`status-cloud`, a second Worker), so `env.cloud` keeps its own `name` and `routes`: do
not drop them as redundant (a test checks both). Nothing in the file names the Cloudflare account or a zone:
the account is `CLOUDFLARE_ACCOUNT_ID` in the environment, and the error watch's two ids are the
secrets `ERROR_WATCH_ACCOUNT` and `ERROR_WATCH_ZONE`. Never add an `account_id`, a zone id or a
secret to this file.

The next deploy of status.gateweave.com, and every one after it: with `CLOUDFLARE_ACCOUNT_ID` set to
Gateweave's account and Wrangler logged in to it, `pnpm run deploy:cloud` (it applies the D1
migrations with `--env cloud`, then `wrangler deploy --env cloud`). `pnpm run deploy` is the
self-hoster's and must not be used for it. `deploy:cloud` first runs `scripts/check-cloud-secrets.mjs`,
which refuses to deploy unless the live Worker has the secrets `ERROR_WATCH_ACCOUNT` and
`ERROR_WATCH_ZONE` (it reads names only). Set them before the first deploy of the version that
introduced them (docs/self-hosting.md): without them every scheduled run fails.
