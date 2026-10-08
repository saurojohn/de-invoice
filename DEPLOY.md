# DEPLOY.md — where to look

There is **one** production path: [`infra/prod/`](infra/prod/README.md)
(Docker Compose: Caddy with automatic TLS, backend, frontend, PostgreSQL,
a backup sidecar). Start there:

| You want to | Read |
| --- | --- |
| deploy on a server | [`infra/prod/README.md`](infra/prod/README.md), then [`infra/prod/HETZNER-DEPLOY.md`](infra/prod/HETZNER-DEPLOY.md) |
| operate it (logs, update, rotate secrets, troubleshoot) | [`infra/prod/RUNBOOK.md`](infra/prod/RUNBOOK.md) |
| back up and restore | [`infra/prod/README.md`](infra/prod/README.md) § Backups, `infra/prod/restore.sh`, [`infra/prod/DR-TEST.md`](infra/prod/DR-TEST.md) |
| check the security settings | [`infra/prod/SECURITY.md`](infra/prod/SECURITY.md) |
| know what is finished and what is not | [`HANDOFF.md`](HANDOFF.md) §1 and §9 |

**Status (08.10.2026): not deployed.** The stack has been built and run end
to end on a developer machine (Tiers 555–569, 580); it has never run on a
server. Before the first real deployment an operator still has to provide a
domain, SMTP credentials, `FINTS_PIN_ENC_KEY`, an off-site copy of the
backups and of the storage volume — see `HANDOFF.md` §9.

The older second path — a root `docker-compose.prod.yml` behind a
host-installed nginx — was removed in Tier 584; its documents are in
[`docs/history/`](docs/history/README.md) and must not be used.

## Local development

```bash
# 1. database (PostgreSQL 16 in Docker, reachable from this machine only)
docker compose up -d postgres

# 2. backend
cd backend
cp .env.example .env            # DATABASE_URL, JWT_SECRET, SMTP_* …
npm ci
npx prisma migrate deploy       # never `db push` on a database with data
bash scripts/start-backend.sh   # http://localhost:3001

# 3. frontend (second terminal)
cd frontend
npm ci
npx next dev -p 3000            # http://localhost:3000
```

Or all three steps at once: `./start.sh` (and `./stop.sh`). If port 3001 or
3000 is taken by another program the script says so and leaves it alone:
`BACKEND_PORT=3011 FRONTEND_PORT=3100 ./start.sh`.

- **First login:** on an empty database, register at `/register` — the first
  company's admin is also the installation's operator (backups, system
  health). There is no seeded user.
- **Scheduled jobs** (recurring invoices, payment reminders, the nightly
  backup) run in the backend. On a copy of real data that has been lying
  around they act on it at once; start with `DISABLE_CRON=1 ./start.sh` to
  look first.
- **Tests:** `backend/e2e/*.sh` against a running backend
  (`bash backend/scripts/local-ci-stack.sh run` brings up its own database
  and backend), Playwright in `frontend/e2e/`. CI runs both on every push.
