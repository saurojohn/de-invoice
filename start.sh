#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  de-invoice full-stack startup script
#  Run after a computer restart to bring up the app.
#
#  Usage:  ./start.sh
#
#  What it does:
#    1. Ensure PostgreSQL is up. Tries, in order:
#         - a running Docker container named de-invoice-postgres
#         - brew services start postgresql@16 / @15 / @14
#         - a running local pg_ctl instance
#         - psql from Postgres.app
#         - starts a fresh Docker container if Docker is
#           available and no container is running yet
#    2. Make sure the de_invoice DB + de_invoice user exist.
#    3. Run any pending prisma migrations.
#    4. Start the NestJS backend (port 3001) in the
#       background with logs to /tmp/backend.log.
#    5. Start the Next.js dev server (port 3000) in the
#       background with logs to /tmp/next-dev.log.
#    6. Print a short status table with URLs to open.
# ─────────────────────────────────────────────────────────────────
set -e

cd "$(dirname "$0")"

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
CYA='\033[0;36m'
RST='\033[0m'

step() { echo -e "${CYA}▶ $*${RST}"; }
ok()   { echo -e "${GRN}✔ $*${RST}"; }
warn() { echo -e "${YEL}⚠ $*${RST}"; }
err()  { echo -e "${RED}✖ $*${RST}"; }

# ── 1. PostgreSQL ──────────────────────────────────────────────
step "1. Starting PostgreSQL"
# Fast path: already up.
if command -v pg_isready >/dev/null 2>&1 && pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  ok "PostgreSQL already running on :5432"
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
    # No existing container — create one. Data is persisted
    # in the de-invoice_postgres_data named volume.
    docker run -d --name de-invoice-postgres --restart unless-stopped \
      -p 5432:5432 \
      -e POSTGRES_USER=de_invoice \
      -e POSTGRES_PASSWORD=de_invoice_pass \
      -e POSTGRES_DB=de_invoice \
      -v de-invoice_postgres_data:/var/lib/postgresql/data \
      postgres:16-alpine >/dev/null 2>&1 && \
      ok "Started new container de-invoice-postgres" || {
      err "Failed to start de-invoice-postgres container."
      exit 1
    }
  fi
  # Wait for postgres to be ready (up to 15s).
  for i in $(seq 1 15); do
    if (echo > /dev/tcp/localhost/5432) >/dev/null 2>&1; then
      ok "Postgres is accepting connections on :5432"
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
  if ! (echo > /dev/tcp/localhost/5432) >/dev/null 2>&1; then
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
ok "PostgreSQL is up on :5432"

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
if [ -z "$PSQL" ] && [ -z "$PSQL_VIA_DOCKER" ]; then
  err "psql not found locally and no de-invoice-postgres container is running."
  err "Install one of: brew install postgresql@16, Postgres.app, or start the Docker container."
  exit 1
fi
[ -n "$PSQL" ] && ok "Using psql: $PSQL" || ok "Using psql via docker exec into $PSQL_VIA_DOCKER"

# A small wrapper so the rest of the script can call
# `psql_run` regardless of which path was found.
psql_run() {
  if [ -n "$PSQL" ]; then
    PGPASSWORD=de_invoice_pass "$PSQL" -h localhost -U de_invoice -d de_invoice "$@"
  else
    docker exec -e PGPASSWORD=de_invoice_pass "$PSQL_VIA_DOCKER" \
      psql -U de_invoice -d de_invoice "$@"
  fi
}
psql_admin() {
  # Connect as postgres OS user / docker default (no password).
  if [ -n "$PSQL" ]; then
    "$PSQL" -h localhost -U "$1" -d postgres "${@:2}"
  else
    docker exec "$PSQL_VIA_DOCKER" psql -U "$1" -d postgres "${@:2}"
  fi
}

# Test that de_invoice role/DB already exist.
if psql_run -c "SELECT 1" >/dev/null 2>&1; then
  ok "de_invoice role + database already exist"
elif [ -n "$PSQL" ]; then
  # Local postgres — try creating the role + DB as the
  # OS user (or as the 'postgres' role).
  warn "de_invoice role/DB missing — creating them"
  SUPER=""
  if "$PSQL" -h localhost -U postgres -d postgres -c "SELECT 1" >/dev/null 2>&1; then
    SUPER="postgres"
  elif "$PSQL" -h localhost -d postgres -c "SELECT 1" >/dev/null 2>&1; then
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

# ── 3. Prisma migrate + apply init.sql ──────────────────────────
step "3. Applying Prisma schema + init.sql"
cd backend
# The schema declares city_text / postal_code_text as plain
# String? columns, but in the actual DB they are STORED
# GENERATED columns (created by init.sql). Prisma's db push
# chokes on the mismatch: it tries to ALTER the columns
# (because schema.prisma says they should be normal) and
# Postgres refuses with "column is a generated column".
# Workaround: drop the generated columns BEFORE db push,
# then let init.sql recreate them AFTER.
if [ -f prisma/init.sql ]; then
  step "   3a. Dropping generated columns to let db push pass"
  if [ -n "$PSQL" ]; then
    PGPASSWORD=de_invoice_pass "$PSQL" -h localhost -U de_invoice -d de_invoice -c "
      ALTER TABLE \"Customer\" DROP COLUMN IF EXISTS \"city_text\";
      ALTER TABLE \"Customer\" DROP COLUMN IF EXISTS \"postal_code_text\";
    " >/dev/null 2>&1 || warn "   (could not drop generated columns; db push will try anyway)"
  else
    docker exec -e PGPASSWORD=de_invoice_pass "$PSQL_VIA_DOCKER" \
      psql -U de_invoice -d de_invoice -c "
        ALTER TABLE \"Customer\" DROP COLUMN IF EXISTS \"city_text\";
        ALTER TABLE \"Customer\" DROP COLUMN IF EXISTS \"postal_code_text\";
      " >/dev/null 2>&1 || warn "   (could not drop generated columns; db push will try anyway)"
  fi
fi
# npx prisma generate is idempotent.
npx prisma generate >/tmp/prisma-gen.log 2>&1 || {
  err "prisma generate failed:"
  cat /tmp/prisma-gen.log
  exit 1
}
# Use db push for first-time setup; the project has
# init.sql with STORED GENERATED columns that conflict
# with prisma migrate, so we use a hybrid: db push for
# the base schema, then apply init.sql for the
# extensions / generated columns.
npx prisma db push --accept-data-loss --skip-generate >/tmp/prisma-push.log 2>&1 || {
  err "prisma db push failed:"
  cat /tmp/prisma-push.log
  exit 1
}
# Apply init.sql for pg_trgm GIN indexes + the
# STORED GENERATED columns on Customer (cityText,
# postalCodeText).
if [ -f prisma/init.sql ]; then
  if [ -n "$PSQL" ]; then
    PGPASSWORD=de_invoice_pass "$PSQL" -h localhost -U de_invoice -d de_invoice \
      -f prisma/init.sql >/tmp/init-sql.log 2>&1 \
      || warn "init.sql had errors (check /tmp/init-sql.log)"
  else
    docker cp prisma/init.sql "$PSQL_VIA_DOCKER":/tmp/init.sql >/dev/null 2>&1
    docker exec -e PGPASSWORD=de_invoice_pass "$PSQL_VIA_DOCKER" \
      psql -U de_invoice -d de_invoice -f /tmp/init.sql \
      >/tmp/init-sql.log 2>&1 \
      || warn "init.sql had errors (check /tmp/init-sql.log)"
  fi
  ok "Applied prisma/init.sql"
fi
ok "Database schema is up to date"

# ── 4. Backend (NestJS) ────────────────────────────────────────
step "4. Starting backend (NestJS) on :3001"
# Kill any stale ts-node backend instance first. Use pgrep
# scoped to ts-node so we never accidentally kill something
# else that happened to be listening on :3001 (e.g. a dev
# process the user launched manually).
pgrep -f 'ts-node.*src/main\.ts' 2>/dev/null | xargs -r kill -9 2>/dev/null
# Also free :3001 in case the previous backend was launched
# differently (e.g. node dist/) and pgrep missed it.
lsof -ti:3001 2>/dev/null | xargs -r kill -9 2>/dev/null
# Start backend in background. ts-node does NOT
# hot-reload — kill+restart on every backend change.
nohup npx ts-node src/main.ts >/tmp/backend.log 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > /tmp/backend.pid
# Wait up to 30s for "Nest application successfully started".
for i in $(seq 1 30); do
  if grep -q "Nest application successfully started" /tmp/backend.log 2>/dev/null; then
    ok "Backend up (PID $BACKEND_PID, :3001)"
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    err "Backend process died. Last log:"
    tail -20 /tmp/backend.log
    exit 1
  fi
  sleep 1
done
if ! grep -q "Nest application successfully started" /tmp/backend.log 2>/dev/null; then
  err "Backend didn't start in 30s. Last log:"
  tail -20 /tmp/backend.log
  exit 1
fi

# ── 5. Frontend (Next.js) ──────────────────────────────────────
step "5. Starting frontend (Next.js) on :3000"
# Same scoped-kill pattern as the backend: prefer pgrep
# over lsof so a non-next.js dev process on :3000 stays
# untouched. pgrep -f matches the full command line, so
# "next dev" (next.js dev server) is what we look for.
pgrep -f 'next dev' 2>/dev/null | xargs -r kill -9 2>/dev/null
lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null
cd ../frontend
nohup npx next dev >/tmp/next-dev.log 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > /tmp/next-dev.pid
# Wait up to 30s for the dev server to compile.
for i in $(seq 1 30); do
  if curl -sS -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null | grep -q "200\|404\|307"; then
    ok "Frontend up (PID $FRONTEND_PID, :3000)"
    break
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    err "Frontend process died. Last log:"
    tail -20 /tmp/next-dev.log
    exit 1
  fi
  sleep 1
done

# ── 6. Status table ────────────────────────────────────────────
echo
echo -e "${GRN}╔════════════════════════════════════════════════════════╗${RST}"
echo -e "${GRN}║  de-invoice is up                                       ║${RST}"
echo -e "${GRN}╠════════════════════════════════════════════════════════╣${RST}"
echo -e "${GRN}║${RST}  Frontend:  ${CYA}http://localhost:3000${RST}                   ${GRN}║${RST}"
echo -e "${GRN}║${RST}  Backend:   ${CYA}http://localhost:3001/api/v1${RST}            ${GRN}║${RST}"
echo -e "${GRN}║${RST}  Database:  ${CYA}postgresql://localhost:5432/de_invoice${RST} ${GRN}║${RST}"
echo -e "${GRN}║${RST}  Login:      ${CYA}info@shleder.de${RST} / ${CYA}Test1234!${RST}            ${GRN}║${RST}"
echo -e "${GRN}║${RST}  Logs:      ${CYA}tail -f /tmp/backend.log /tmp/next-dev.log${RST} ${GRN}║${RST}"
echo -e "${GRN}╚════════════════════════════════════════════════════════╝${RST}"
echo
echo -e "Stop with:  ${YEL}./stop.sh${RST}  (or run:  kill \$(cat /tmp/backend.pid /tmp/next-dev.pid)  )"
