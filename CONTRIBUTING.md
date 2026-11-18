# Contributing to Gateweave Status

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Read [AGENTS.md](AGENTS.md) for the full
project rules.

## Setup

Use Node.js 24 and pnpm 12. The README describes the configuration in `wrangler.jsonc`.

```sh
pnpm install
pnpm dev
```

For local checks, `pnpm dev --test-scheduled` runs the cron. Keep local secrets in `.dev.vars`;
the repository has no `.dev.vars.example`. Do not commit secrets.

## Before a pull request

Run `pnpm verify`. It runs Biome, the type check and the tests, as CI does. Explain the change and
how you checked it in the pull request template. Add a new D1 migration for a schema change; never
edit a migration already merged. Use Conventional Commits without AI attribution.

A pull request is reviewed against the project rules and the passing CI check before it is merged.
Keep it focused so the behavior and any deploy steps can be checked.
