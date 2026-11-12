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
- The page loads nothing from elsewhere: no scripts, fonts or images. The CSP says so.
- TypeScript is strict, with `noUncheckedIndexedAccess`. Biome formats: tabs, 100 columns.
- Dependencies are pinned to exact versions.
- Commits follow Conventional Commits and carry no AI attribution.
