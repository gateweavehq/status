# Self-hosting

Gateweave Status runs as one Cloudflare Worker with a D1 database. Its configuration in
`wrangler.jsonc` is for Gateweave's own deployment. Change it before deploying a copy.

## Resources and settings

- A Worker with the every-minute Cron Trigger, D1 binding `DB`, and a domain for its page.
- Cloudflare Email Sending binding `EMAIL` if you want email alerts. Set its allowed sender and
  `ALERT_FROM` for an address you can send from.
- Cloudflare analytics access if you keep `ERROR_WATCH`: `ANALYTICS_TOKEN` needs Account Analytics
  Read on its account and Analytics Read on its zone.
- A Track workspace and agent member's key only if you want incident issues.

`wrangler.jsonc` also contains Gateweave's account ID, route, database ID, sender, service list,
error-watch account, zone and targets, and Track workspace and team. Replace those that apply to
your deployment. `PAGE_URL` is optional; set it to your page's address for links in alerts and
Track issues. Without it, those links use `https://status.gateweave.com`.

The code reads these secrets:

| Secret            | Purpose                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALERT_TO`        | One address or a comma-separated list for incident and error-watch email. Without it, incidents appear only on the page.                              |
| `ANALYTICS_TOKEN` | Reads Cloudflare analytics when `ERROR_WATCH` is set. Without it, the error watch does not run.                                                       |
| `TRACK_KEY`       | Agent member's key for filing issues. Track also needs `TRACK_URL`, `TRACK_WORKSPACE` and `TRACK_TEAM` as variables. Without all four, filing is off. |

Set production secrets with `npx wrangler secret put ALERT_TO`,
`npx wrangler secret put ANALYTICS_TOKEN` and `npx wrangler secret put TRACK_KEY` as needed. Keep
local secrets in `.dev.vars`; it is ignored by Git. There is no example secrets file.

## Deploying

Use Node.js 24 and pnpm 12. The README gives the normal commands. For a new copy, edit
`wrangler.jsonc` first: choose your Worker name, account, domain, D1 database name and ID,
sender, and settings. Create the D1 database and put the returned ID in the D1 binding:

```sh
npx wrangler d1 create gateweave-status
```

If you choose another database name, use it in the following command too. Apply the migrations
before deploying because the cron reads their columns:

```sh
npx wrangler d1 migrations apply gateweave-status --remote
npx wrangler deploy
```

Set the secrets your features need with the commands above. `pnpm verify` runs the repository's
checks before a deploy.

## Watching your services

Replace `SERVICES` in `wrangler.jsonc` with your HTTPS health URLs. Each entry needs a stable
`id`, a `name` and a `url`. It may set `expect` (200 by default), `contains` (text the response
must include), or `team` (a Track team key). Keep an ID stable after the first deploy because D1
stores history under it. The page follows the list's order.

The service list is configuration, so watching other services does not require a code change.
The current error watch is separate: edit its account, zone, hosts and Worker names, or remove
`ERROR_WATCH` to turn it off. Likewise, change the Track settings to your own workspace or leave
them unset. The default page URL and the check's user-agent still name Gateweave; change the code
if your copy needs those names changed.
