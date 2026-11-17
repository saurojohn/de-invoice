#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# de-invoice: the restore drill — proves that the newest dump can be loaded,
# without touching the running database.
#
# Tier 856. A backup nobody has restored is a hope. The drill takes the newest
# dump — from this server's backups volume, or from the encrypted off-site
# copy, the one a lost server leaves you — and loads it into a throwaway
# PostgreSQL container (the compose file's image, no network, data in
# memory), stopping at the first error. It then says what it found: tables,
# companies, users, invoices, the newest invoice, the last migration. The
# container and the decrypted copy are removed at the end; the production
# database, the backups and the remote are only read.
#
# Usage (on the server, in infra/prod):
#   bash restore-drill.sh              # the newest hourly dump in the backups volume
#   bash restore-drill.sh --offsite    # the newest hourly dump off-site
#                                      #   (BACKUP_OFFSITE_REMOTE, ./rclone.conf)
#   DRILL_DUMP=/path/x.sql.gz bash restore-drill.sh   # a given file
#
# Exit code 0: the dump loaded and holds at least one company. Write the result
# in the drill log (RUNBOOK.md §4, „Restore drill“) — once a quarter, and after
# every change to the backup or the off-site copy.
#
# DRILL_PG_IMAGE, DRILL_RCLONE_IMAGE, DRILL_BACKUPS_VOLUME, DRILL_RCLONE_CONF,
# DRILL_DOCKER_ARGS (more `docker run` arguments for the rclone container) —
# to change what is used; the defaults are the compose file's.
# ──────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

image_of() { awk -v s="  $1:" '$0 == s {f=1} f && /image:/ {print $2; exit}' docker-compose.yml; }
PG_IMAGE=${DRILL_PG_IMAGE:-$(image_of postgres)}
RCLONE_IMAGE=${DRILL_RCLONE_IMAGE:-$(image_of offsite-backup)}
VOLUME=${DRILL_BACKUPS_VOLUME:-de-invoice-prod_backups}
RCLONE_CONF=${DRILL_RCLONE_CONF:-$PWD/rclone.conf}

W=$(mktemp -d)
NAME="de-invoice-restore-drill-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT
say() { echo "drill: $*"; }
fail() { echo "drill: FAILED — $*" >&2; exit 1; }

# ─── 1. the dump ────────────────────────────────────────
if [[ -n "${DRILL_DUMP:-}" ]]; then
  [[ -f "$DRILL_DUMP" ]] || fail "no such file: $DRILL_DUMP"
  cp "$DRILL_DUMP" "$W/dump.sql.gz"
  SOURCE="$DRILL_DUMP"
elif [[ "${1:-}" == "--offsite" ]]; then
  REMOTE=${BACKUP_OFFSITE_REMOTE:-$( [[ -f .env ]] && grep -E '^BACKUP_OFFSITE_REMOTE=' .env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//; s/^"//; s/"$//' || true)}
  [[ -n "$REMOTE" ]] || fail "BACKUP_OFFSITE_REMOTE is not set"
  [[ -f "$RCLONE_CONF" ]] || fail "no rclone.conf at $RCLONE_CONF"
  # shellcheck disable=SC2206
  RC=(docker run --rm --pull=never --user "$(id -u):$(id -g)" -e RCLONE_CONFIG=/config/rclone.conf
      -v "$RCLONE_CONF:/config/rclone.conf:ro" -v "$W:/w" ${DRILL_DOCKER_ARGS:-} "$RCLONE_IMAGE")
  NEWEST=$("${RC[@]}" lsf --files-only "$REMOTE/db/last" | grep -E '\.sql\.gz$' | grep -v -- '-latest\.' | sort | tail -1) \
    || fail "cannot list $REMOTE/db/last"
  [[ -n "$NEWEST" ]] || fail "no dump in $REMOTE/db/last"
  "${RC[@]}" copyto "$REMOTE/db/last/$NEWEST" /w/dump.sql.gz || fail "cannot fetch $NEWEST"
  SOURCE="$REMOTE/db/last/$NEWEST"
else
  NEWEST=$(docker run --rm --pull=never -v "$VOLUME:/backups:ro" -v "$W:/w" "$PG_IMAGE" \
    sh -c 'f=$(ls /backups/last/*.sql.gz 2>/dev/null | grep -v -- "-latest\." | sort | tail -1); [ -n "$f" ] && cp "$f" /w/dump.sql.gz && chmod 644 /w/dump.sql.gz && basename "$f"') \
    || fail "no dump in the volume $VOLUME (last/)"
  SOURCE="$VOLUME:last/$NEWEST"
fi
say "dump: $SOURCE ($(du -h "$W/dump.sql.gz" | cut -f1))"
gunzip -t "$W/dump.sql.gz" 2>/dev/null || fail "the file is no intact gzip (truncated, or still encrypted?)"

# ─── 2. load it into a throwaway database ───────────────
# the dump gives its tables to the production role: the throwaway server gets it as its user
OWNER=$(gunzip -c "$W/dump.sql.gz" | grep -m1 -oE 'OWNER TO "?[A-Za-z0-9_]+' | awk '{print $3}' | tr -d '"' || true)
OWNER=${OWNER:-de_invoice}
docker run -d --pull=never --name "$NAME" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER="$OWNER" -e POSTGRES_PASSWORD="drill-$$" -e POSTGRES_DB=drill "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U "$OWNER" -d drill -q 2>/dev/null && \
    docker exec "$NAME" psql -U "$OWNER" -d drill -Atqc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
START=$(date +%s)
gunzip -c "$W/dump.sql.gz" | docker exec -i "$NAME" psql -U "$OWNER" -d drill -v ON_ERROR_STOP=1 -q >/dev/null 2>"$W/load.err" \
  || fail "the dump did not load: $(head -3 "$W/load.err")"
say "loaded in $(( $(date +%s) - START ))s"

# ─── 3. what is in it ───────────────────────────────────
q() { docker exec "$NAME" psql -U "$OWNER" -d drill -Atqc "$1" 2>/dev/null; }
has() { [[ "$(q "select to_regclass('public.\"$1\"') is not null")" == "t" ]]; }
say "tables: $(q "select count(*) from information_schema.tables where table_schema = 'public'")"
COMPANIES=0
has Company && COMPANIES=$(q 'select count(*) from "Company"')
say "companies: $COMPANIES"
has User && say "users: $(q 'select count(*) from "User"')"
if has Invoice; then
  say "invoices: $(q 'select count(*) from "Invoice"'), the newest created $(q "select coalesce(to_char(max(\"createdAt\") at time zone 'UTC' at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI'), '—') from \"Invoice\"")"
fi
has _prisma_migrations && say "last migration: $(q 'select migration_name from _prisma_migrations where finished_at is not null order by migration_name desc limit 1')"
(( COMPANIES > 0 )) || fail "the dump holds no company"
say "ok — the dump can be restored (restore.sh puts it in place of the database)"
