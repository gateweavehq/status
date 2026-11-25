# Changelog

Notable changes to Gateweave Status, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no tagged releases yet.

## [Unreleased]

### Changed

- The checks' user agent is now `StatusMonitor/1`, with ` (+PAGE_URL)` when `PAGE_URL` is set; it
  was `GateweaveStatus/1`. A WAF rule or allowlist that matches the old agent needs the new one.

### Added

- **A named environment for Gateweave Cloud.** `wrangler.jsonc` keeps the self-hoster's template at
  the top level and Gateweave Cloud's own deployment as the environment `cloud`
  (`pnpm run deploy:cloud`). No account or zone id is in the file: the account is
  `CLOUDFLARE_ACCOUNT_ID`, and the error watch may take its `account` and `zone` from the secrets
  `ERROR_WATCH_ACCOUNT` and `ERROR_WATCH_ZONE`.

- **Status page and API.** One Worker checks configured services every minute, keeps daily counts
  and incidents in D1, shows 90 days of history, and serves `/api/status`.
- **Incident alerts.** An outage starts after two failed checks. A slow spell starts after five
  late answers. Email alerts report incidents and recoveries, with retries for failed sends.
- **Error watch.** Cloudflare analytics checks watched hosts, Workers and Durable Objects every
  15 minutes for error spikes.
- **Track issues.** Incidents are filed in the configured workspace and the service's team, with
  an end comment when they recover.
