#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  de-invoice full-stack startup script
#  Run after a computer restart to bring up the app.
#
#  Usage:  ./start.sh
#           BACKEND_PORT=3011 FRONTEND_PORT=3100 ./start.sh   # other ports
#           DISABLE_CRON=1 ./start.sh                         # without the scheduled jobs
#
#  What it does:
#    1. Ensure PostgreSQL is up (the project's Docker container, else a
#       local installation).
#    2. Make sure the database + user exist.
#    3. Apply pending migrations (`prisma migrate deploy`).
#    4. Start the NestJS backend in the background (log: /tmp/backend.log).
#    5. Start the Next.js dev server in the background (log: /tmp/next-dev.log).
#    6. Print the URLs.
#
#  Tier 584 — what this script no longer does:
#    - `prisma db push --accept-data-loss` on every start. On a database with
#      real data that may drop what the schema file does not name, and it
#      goes around the migration history. Now: `prisma migrate deploy`.
#    - `kill -9` whatever listens on :3001 / :3000 and every `next dev` on
#      the machine. On the owner's computer :3001 is another project's
#      server. Now only processes started from THIS checkout are stopped;
#      a port held by anything else stops the script with the way out.
#    - print a login. It printed an address and a password that may never
#      have existed in this database.
# ──────────────────────────────────────────────────────────────────
set -e

cd "$(dirname "$0")"
ROOT="$(pwd -P)"

# Where things run — the defaults are the usual developer setup.
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-de_invoice}"
# Another database than the default: the backend and prisma are told so.
# (With the defaults they read backend/.env as before.)
if [ "$DB_PORT" != "5432" ] || [ "$DB_NAME" != "de_invoice" ]; then
  export DATABASE_URL="postgresql://de_invoice:de_invoice_pass@localhost:${DB_PORT}/${DB_NAME}?schema=public"
fi

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
CYA='\033[0;36m'
RST='\033[0m'

step() { echo -e "${CYA}▶ $*${RST}"; }
ok()   { echo -e "${GRN}✔ $*${RST}"; }
warn() { echo -e "${YEL}⚠ $*${RST}"; }
err()  { echo -e "${RED}✖ $*${RST}"; }

# The processes listening on a port that were started from this checkout
# (their working directory is inside it). Nothing else is ever stopped.
own_listeners() { # port
  local pid cwd
  for pid in $(lsof -ti:"$1" -sTCP:LISTEN 2>/dev/null); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case "$cwd" in "$ROOT"|"$ROOT"/*) echo "$pid" ;; esac
  done
}
# Stop our own process on a port (TERM, then KILL what is still there after
# 5 s — the backend needs the TERM to stop its database engine with it).
# If something else holds the port: say what, and stop.
free_port() { # port what
  local pids pid i other cwd
  pids=$(own_listeners "$1")
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    for i in 1 2 3 4 5; do [ -z "$(own_listeners "$1")" ] && break; sleep 1; done
    pids=$(own_listeners "$1"); [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
  other=$(lsof -ti:"$1" -sTCP:LISTEN 2>/dev/null | head -1)
  if [ -n "$other" ]; then
    cwd=$(lsof -a -p "$other" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    err "Port $1 is in use by another program (pid $other${cwd:+, started in $cwd}). It is left alone."
    err "  Start the $2 on another port:  $3 ./start.sh"
    exit 1
  fi
}

# ── 1. PostgreSQL ──────────────────────────────────────────────
step "1. Starting PostgreSQL"
# Fast path: already up.
if (echo > /dev/tcp/localhost/$DB_PORT) >/dev/null 2>&1; then
  ok "PostgreSQL is listening on :$DB_PORT"
elif command -v pg_isready >/dev/null 2>&1 && pg_isready -h localhost -p "$DB_PORT" -q 2>/dev/null; then
  ok "PostgreSQL already running on :$DB_PORT"
# Docker is the preferred path on this machine — start an
# existing de-invoice-postgres container, or spin up a fresh
# one if Docker is available and nothing is running yet.
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  PG_CONTAINER=""
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^de-invoice-postgres$'; then
    PG_CONTAINER="de-invoice-postgres"
  elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^de-invoice-pg$'; then
    PG_CONTAINER="de-invoice-pg"
  fi
  if [ -n "$PG_CONTAINER" ]; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONTAINER}$"; then
      ok "Container $PG_CONTAINER already running on :5432"
    else
      docker start "$PG_CONTAINER" >/dev/null 2>&1 && {
        ok "Started container $PG_CONTAINER"
      } || {
        err "Container $PG_CONTAINER exists but failed to start. Try: docker logs $PG_CONTAINER"
        exit 1
      }
    fi
  else
    # No container yet — the one docker-compose.yml describes: reachable from
    # this machine only, its data on the named volume `devdb_data`.
    docker compose up -d postgres >/dev/null 2>&1 && \
      ok "Started new container de-invoice-postgres (docker compose)" || {
      err "Failed to start the database container (docker compose up -d postgres)."
      exit 1
    }
  fi
  # Wait for postgres to be ready (up to 15s).
  for i in $(seq 1 15); do
    if (echo > /dev/tcp/localhost/$DB_PORT) >/dev/null 2>&1; then
      ok "Postgres is accepting connections on :$DB_PORT"
      break
    fi
    sleep 1
  done
elif command -v brew >/dev/null 2>&1; then
  # Try common brew services names (newest first).
  for pg_formula in postgresql@16 postgresql@15 postgresql@14 postgresql; do
    if brew services list 2>/dev/null | grep -q "$pg_formula"; then
      brew services start "$pg_formula" 2>/dev/null && {
        ok "Started $pg_formula via brew services"
        break
      }
    fi
  done
  # Fallback: try pg_ctl directly on the data dir.
  for pg_data in /opt/homebrew/var/postgres* /usr/local/var/postgres; do
    if [ -d "$pg_data" ] && [ -d "$pg_data/base" ]; then
      pg_ctl -D "$pg_data" -l /tmp/postgres.log start 2>/dev/null && {
        ok "Started postgres via pg_ctl on $pg_data"
        break
      }
    fi
  done
  if ! (echo > /dev/tcp/localhost/$DB_PORT) >/dev/null 2>&1; then
    err "PostgreSQL didn't start."
    err "  Fix: brew install postgresql && brew services start postgresql"
    err "  Or install Postgres.app from postgresapp.com"
    err "  Or install Docker and run: docker run -d -p 5432:5432 \\"
    err "       -e POSTGRES_USER=de_invoice -e POSTGRES_PASSWORD=de_invoice_pass \\"
    err "       -e POSTGRES_DB=de_invoice --name de-invoice-postgres postgres:16-alpine"
    err "  Then re-run ./start.sh"
    exit 1
  fi
elif [ -d "/Applications/Postgres.app" ]; then
  # Postgres.app is a common GUI install on macOS.
  /Applications/Postgres.app/Contents/Versions/latest/bin/pg_ctl \
    -D /Applications/Postgres.app/Contents/Versions/latest/data \
    -l /tmp/postgres.log start 2>/dev/null || {
    err "Could not start Postgres.app — open it once so it initializes the data dir."
    exit 1
  }
else
  err "PostgreSQL not found. Install one of:"
  err "  • Docker (recommended):  docker run -d -p 5432:5432 \\"
  err "       -e POSTGRES_USER=de_invoice -e POSTGRES_PASSWORD=de_invoice_pass \\"
  err "       -e POSTGRES_DB=de_invoice --name de-invoice-postgres postgres:16-alpine"
  err "  • brew install postgresql@16"
  err "  • Postgres.app from https://postgresapp.com"
  err "  • Docker: docker run -d -p 5432:5432 -e POSTGRES_USER=de_invoice \\"
  err "                -e POSTGRES_PASSWORD=de_invoice_pass \\"
  err "                -e POSTGRES_DB=de_invoice postgres:16"
  exit 1
fi
ok "PostgreSQL is up on :$DB_PORT"

# ── 2. Make sure the DB + user exist ─────────────────────────────
step "2. Ensuring de_invoice database + user exist"
# Detect which psql to use. Prefer local binaries; fall
# back to `docker exec` if the only running Postgres is
# inside the de-invoice-postgres container and no psql is
# installed locally.
PSQL=""
for psql_candidate in \
  "$(brew --prefix postgresql@16 2>/dev/null)/bin/psql" \
  "$(brew --prefix postgresql@15 2>/dev/null)/bin/psql" \
  "$(brew --prefix postgresql@14 2>/dev/null)/bin/psql" \
  "$(brew --prefix postgresql 2>/dev/null)/bin/psql" \
  /Applications/Postgres.app/Contents/Versions/latest/bin/psql \
  /usr/local/bin/psql; do
  if [ -x "$psql_candidate" ]; then PSQL="$psql_candidate"; break; fi
done
[ -z "$PSQL" ] && command -v psql >/dev/null 2>&1 && PSQL="$(command -v psql)"
PSQL_VIA_DOCKER=""
if [ -z "$PSQL" ] && command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^de-invoice-postgres$'; then
    PSQL_VIA_DOCKER="de-invoice-postgres"
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^de-invoice-pg$'; then
    PSQL_VIA_DOCKER="de-invoice-pg"
  fi
fi
# The container fallback reaches the project's own container only — a
# database on another port is somebody else's to prepare.
if [ -z "$PSQL" ] && [ "$DB_PORT" != "5432" ]; then PSQL_VIA_DOCKER=""; SKIP_DB_CHECK=1; fi
if [ -z "$PSQL" ] && [ -z "$PSQL_VIA_DOCKER" ] && [ -z "${SKIP_DB_CHECK:-}" ]; then
  err "psql not found locally and no de-invoice-postgres container is running."
  err "Install one of: brew install postgresql@16, Postgres.app, or start the Docker container."
  exit 1
fi
if [ -n "${SKIP_DB_CHECK:-}" ]; then ok "No local psql for a database on :$DB_PORT — taking it as prepared"
elif [ -n "$PSQL" ]; then ok "Using psql: $PSQL"
else ok "Using psql via docker exec into $PSQL_VIA_DOCKER"; fi

# A small wrapper so the rest of the script can call
# `psql_run` regardless of which path was found.
psql_run() {
  if [ -n "$PSQL" ]; then
    PGPASSWORD=de_invoice_pass "$PSQL" -h localhost -p "$DB_PORT" -U de_invoice -d "$DB_NAME" "$@"
  else
    docker exec -e PGPASSWORD=de_invoice_pass "$PSQL_VIA_DOCKER" \
      psql -U de_invoice -d "$DB_NAME" "$@"
  fi
}
psql_admin() {
  # Connect as postgres OS user / docker default (no password).
  if [ -n "$PSQL" ]; then
    "$PSQL" -h localhost -p "$DB_PORT" -U "$1" -d postgres "${@:2}"
  else
    docker exec "$PSQL_VIA_DOCKER" psql -U "$1" -d postgres "${@:2}"
  fi
}

# Test that de_invoice role/DB already exist.
if [ -n "${SKIP_DB_CHECK:-}" ]; then
  :
elif psql_run -c "SELECT 1" >/dev/null 2>&1; then
  ok "de_invoice role + database already exist"
elif [ -n "$PSQL" ]; then
  # Local postgres — try creating the role + DB as the
  # OS user (or as the 'postgres' role).
  warn "de_invoice role/DB missing — creating them"
  SUPER=""
  if "$PSQL" -h localhost -p "$DB_PORT" -U postgres -d postgres -c "SELECT 1" >/dev/null 2>&1; then
    SUPER="postgres"
  elif "$PSQL" -h localhost -p "$DB_PORT" -d postgres -c "SELECT 1" >/dev/null 2>&1; then
    SUPER="$(whoami)"
  else
    err "Can't connect to local postgres as superuser."
    err "  • Postgres.app: open it once to set a password"
    err "  • brew: brew services start postgresql@16"
    exit 1
  fi
  psql_admin "$SUPER" -c "DO \$\$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='de_invoice') THEN
      CREATE ROLE de_invoice WITH LOGIN PASSWORD 'de_invoice_pass';
    END IF;
  END \$\$;" >/dev/null
  if ! psql_admin "$SUPER" -tAc "SELECT 1 FROM pg_database WHERE datname='de_invoice'" | grep -q 1; then
    psql_admin "$SUPER" -c "CREATE DATABASE de_invoice OWNER de_invoice;" >/dev/null
  fi
  ok "Created de_invoice role + database"
else
  # Docker container — the official postgres:16 image
  # already runs init scripts from POSTGRES_USER/POSTGRES_PASSWORD/
  # POSTGRES_DB, so the role and database exist on first
  # start. The de_invoice role is the superuser, so we can
  # grant schema permissions to itself if needed.
  warn "de_invoice role/DB missing inside container — check container env vars (POSTGRES_USER, POSTGRES_DB)"
  exit 1
fi

# ── 3. Migrations ─────────────────────────────────────────────
step "3. Applying pending migrations"
cd backend
# npx prisma generate is idempotent.
npx prisma generate >/tmp/prisma-gen.log 2>&1 || {
  err "prisma generate failed:"
  cat /tmp/prisma-gen.log
  exit 1
}
# Tier 584: `migrate deploy` — it applies what is pending and nothing else.
# (This ran `prisma db push --accept-data-loss` on every start, after dropping
# two columns to make it pass.)
if npx prisma migrate deploy >/tmp/prisma-migrate.log 2>&1; then
  if grep -q "No pending migrations" /tmp/prisma-migrate.log; then ok "No pending migrations"
  else ok "Migrations applied: $(grep -c '^  └─ \|^[0-9]\{14\}_' /tmp/prisma-migrate.log 2>/dev/null || true) (see /tmp/prisma-migrate.log)"; fi
elif grep -q "P3005" /tmp/prisma-migrate.log; then
  err "This database has tables but no migration history (it was created with 'prisma db push')."
  err "Bring it over once — it changes no data:"
  err "  cd backend && bash scripts/baseline-migrations.sh"
  err "then run ./start.sh again."
  exit 1
else
  err "prisma migrate deploy failed — nothing was started:"
  tail -20 /tmp/prisma-migrate.log
  exit 1
fi
ok "Database schema is up to date"

# ── 4. Backend (NestJS) ────────────────────────────────────────
step "4. Starting backend (NestJS) on :$BACKEND_PORT"
free_port "$BACKEND_PORT" backend "BACKEND_PORT=3011"
# scripts/start-backend.sh: ts-node, PORT from BACKEND_PORT, CORS for the frontend.
# ts-node does NOT hot-reload — run ./start.sh again after a backend change.
: > /tmp/backend.log
BACKEND_PORT="$BACKEND_PORT" PORT="$BACKEND_PORT" \
  FRONTEND_URL="${FRONTEND_URL:-http://localhost:$FRONTEND_PORT,http://localhost:3000,http://localhost:3100}" \
  nohup bash scripts/start-backend.sh >/tmp/backend.log 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > /tmp/backend.pid
# Wait up to 60s for the health route.
BACKEND_UP=""
for i in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$BACKEND_PORT/api/v1/health" 2>/dev/null)" = "200" ]; then
    ok "Backend up (:$BACKEND_PORT)"
    BACKEND_UP=1
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null && [ -z "$(own_listeners "$BACKEND_PORT")" ]; then
    err "Backend process died. Last log:"
    tail -20 /tmp/backend.log
    exit 1
  fi
  sleep 1
done
if [ -z "$BACKEND_UP" ]; then
  err "Backend didn't start in 60s. Last log:"
  tail -20 /tmp/backend.log
  exit 1
fi

# ── 5. Frontend (Next.js) ──────────────────────────────────────
step "5. Starting frontend (Next.js) on :$FRONTEND_PORT"
free_port "$FRONTEND_PORT" frontend "FRONTEND_PORT=3100"
cd ../frontend
# The browser is told where the backend is (with the default port,
# frontend/.env.local decides as before).
if [ "$BACKEND_PORT" != "3001" ]; then export NEXT_PUBLIC_API_URL="http://localhost:$BACKEND_PORT"; fi
nohup npx next dev -p "$FRONTEND_PORT" >/tmp/next-dev.log 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > /tmp/next-dev.pid
# Wait up to 60s for the dev server to answer.
for i in $(seq 1 60); do
  if curl -sS -o /dev/null -w "%{http_code}" "http://localhost:$FRONTEND_PORT" 2>/dev/null | grep -q "200\|404\|307"; then
    ok "Frontend up (:$FRONTEND_PORT)"
    break
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null && [ -z "$(own_listeners "$FRONTEND_PORT")" ]; then
    err "Frontend process died. Last log:"
    tail -20 /tmp/next-dev.log
    exit 1
  fi
  sleep 1
done

# ── 6. Status ──────────────────────────────────────────────────
echo
echo -e "${GRN}de-invoice is up${RST}"
echo -e "  Frontend:  ${CYA}http://localhost:$FRONTEND_PORT${RST}"
echo -e "  Backend:   ${CYA}http://localhost:$BACKEND_PORT/api/v1${RST}"
echo -e "  Database:  ${CYA}postgresql://localhost:$DB_PORT/$DB_NAME${RST}"
echo -e "  Logs:      ${CYA}tail -f /tmp/backend.log /tmp/next-dev.log${RST}"
echo -e "  Login:     your account — on a new database, register the first one at /register"
if [ "${DISABLE_CRON:-}" = "1" ]; then
  echo -e "  ${YEL}Scheduled jobs are off (DISABLE_CRON=1).${RST}"
else
  echo -e "  ${YEL}Scheduled jobs are running${RST} (recurring invoices, payment reminders, backups)."
  echo -e "  To start without them:  ${YEL}DISABLE_CRON=1 ./start.sh${RST}"
fi
echo
echo -e "Stop with:  ${YEL}./stop.sh${RST}"
