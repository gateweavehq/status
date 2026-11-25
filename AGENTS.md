# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## The project

Gateweave Status checks Gateweave Cloud's services every minute and serves
[status.gateweave.com](https://status.gateweave.com). [README.md](README.md) says what it does.

| Path             | What lives there                                           |
| ---------------- | ---------------------------------------------------------- |
| `src/index.ts`   | The Worker: the page, `/api/status`, and the cron          |
| `src/check.ts`   | One check of one service                                   |
| `src/monitor.ts` | A minute's work: checks, history, incidents                |
| `src/alerts.ts`  | Alert emails                                               |
| `src/track.ts`   | The Track issue for each incident, and its end comment     |
| `src/status.ts`  | What the page shows, read from D1                          |
| `src/page.ts`    | The HTML                                                   |
| `migrations/`    | D1 migrations, append-only                                 |
| `test/`          | Tests in workerd, with a stand-in for the checked services |

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

`wrangler.jsonc` here is the public template: placeholders only, no account, zone, database or
route of ours. Gateweave Cloud's page (status.gateweave.com) is deployed from a private copy of
this repository, `gateweave-status-deployment`. The copy is this repository's `main`, merged in by
hand, and it keeps its own `wrangler.jsonc`: our account, route, D1 database id, sender, services,
error watch, Track settings, and `PAGE_NAME`, `PAGE_DESCRIPTION`, `PAGE_URL` and `HOME_URL`. Nothing
syncs it automatically. A change here that adds or renames a setting needs the same change in that
copy's `wrangler.jsonc` before its next deploy. The deploy steps for status.gateweave.com live in
the copy's own README. Never put those values in this repository.
