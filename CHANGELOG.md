# Changelog

Notable changes to Gateweave Status, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no tagged releases yet.

## [Unreleased]

### Added

- **Status page and API.** One Worker checks configured services every minute, keeps daily counts
  and incidents in D1, shows 90 days of history, and serves `/api/status`.
- **Incident alerts.** An outage starts after two failed checks. A slow spell starts after five
  late answers. Email alerts report incidents and recoveries, with retries for failed sends.
- **Error watch.** Cloudflare analytics checks watched hosts, Workers and Durable Objects every
  15 minutes for error spikes.
- **Track issues.** Incidents are filed in the configured workspace and the service's team, with
  an end comment when they recover.
