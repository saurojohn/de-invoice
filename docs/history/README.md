# docs/history — superseded documents

Kept for the record. **Do not deploy or operate from anything in this
directory** — commands, file names and claims here are out of date.

| File | What it was | Superseded by |
| --- | --- | --- |
| `RUNBOOK-2026-06.md` | The first operations runbook (June 2026), written for the root `docker-compose.prod.yml` + host nginx. | [`infra/prod/RUNBOOK.md`](../../infra/prod/RUNBOOK.md) |
| `DEPLOY-WALKTHROUGH.md` | A deploy walkthrough from September 2026 (Tiers 264–308). | [`infra/prod/HETZNER-DEPLOY.md`](../../infra/prod/HETZNER-DEPLOY.md) |
| `TIER127-DEPLOY-CHECKLIST.md` | A deploy checklist of 01.08.2026 ("first user: seeded via SQL"). | [`infra/prod/HETZNER-DEPLOY.md`](../../infra/prod/HETZNER-DEPLOY.md) |
| `MIGRATION-nginx-to-caddy.md`, `nginx.conf` | How an installation behind a host nginx would have moved to Caddy. No such installation exists; the guide also describes a Caddy `rate_limit` directive stock Caddy does not have. | [`infra/prod/Caddyfile`](../../infra/prod/Caddyfile) |
| `cloudflare-nginx/` | Restoring the visitor's address behind Cloudflare for a host nginx (config, a systemd refresh timer, a test that runs nginx). | the commented `trusted_proxies` block at the end of [`infra/prod/Caddyfile`](../../infra/prod/Caddyfile) |
| `DEPLOY-READY-SUMMARY.md` | "Ready to deploy" summary of 07.09.2026. Written before Tiers 344–583 found and fixed, among others, a proxy configuration Caddy would not load, a backup sidecar that never ran, and migrations that did not produce the schema. | `HANDOFF.md` §1 and §9 |

The root `docker-compose.prod.yml` (host nginx, `TRUST_PROXY: 0`, no
`FRONTEND_URL`) and its overlay `infra/prod/docker-compose.dryrun.yml` were
removed in Tier 584; there is one production path:
[`infra/prod/`](../../infra/prod/README.md).
