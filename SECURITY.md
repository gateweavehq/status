# Security policy

## Supported versions

Gateweave Status is in early development. Security fixes go into `main`. There are no releases yet.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request. Email
**security@gateweave.com**. Once this repository is public, use its GitHub private security
advisory form.

Include what an attacker could do, the steps to reproduce it, and the affected commit. We aim to
reply within three working days, will keep you updated while we work on a fix, and will credit you
in the release notes unless you would rather stay anonymous.

## Scope

Areas where reports are especially valuable:

- The public `GET` and `HEAD` endpoints `/`, `/api/status` and `/favicon.svg`, including data or
  markup supplied by a checked service reaching their answers. The API allows reads from any
  origin.
- The `SERVICES` URLs and answers the Worker accepts, including redirects, response bodies used
  for `contains`, and errors. Only status and timing should be kept or shown.
- The Cloudflare analytics response used by the error watch, and the Track MCP response used to
  file incidents and add comments.
- Secrets `ALERT_TO`, `ANALYTICS_TOKEN` and `TRACK_KEY` reaching a page, API answer, log or issue.
  Email through the `EMAIL` binding and requests to Track must use them only for their intended
  work.

Status has no accounts, workspaces, sign-in or sessions. Gateweave ID is a checked service, not an
identity provider for this Worker. Reports about isolation or sign-in in another Gateweave product
belong to that product.
