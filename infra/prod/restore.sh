#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# de-invoice: restore the database from a dump of the backup container
#
# Tier 563. The procedure the README used to give — pipe the dump into the
# running database — restores nothing: the dump has no DROP statements, every
# CREATE and COPY collides with what is there (measured: 424 errors, psql
# exit 0, the data unchanged). This script was rehearsed on scratch
# databases with the backup image's own tools:
#
#   1. stops backend + frontend (nothing writes during the restore),
#   2. RENAMES the current database to <name>_before_restore — it is kept,
#      not dropped; remove it yourself once the restore is confirmed,
#   3. creates an empty database and loads the dump into it, stopping at the
#      first error,
#   4. starts backend + frontend again — also when the dump does not load: then
#      the previous database is put back and nothing has changed.
#
# Usage (from the repository root, on the server):
#   bash infra/prod/restore.sh                 # the latest dump
#   bash infra/prod/restore.sh last/de_invoice-20261007-030000.sql.gz
#   bash infra/prod/restore.sh --list          # what is there
#
# The uploaded files (the `storage` volume) are NOT part of a dump — restore
# them from your own offsite copy (README, "The uploaded files are NOT in
# these backups").
# ──────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/../.."
# RESTORE_COMPOSE_ARGS: the compose arguments, if yours differ (an overlay,
# another project name), e.g. "-f infra/prod/docker-compose.yml -f infra/prod/monitoring.yml".
# shellcheck disable=SC2206
DC=(docker compose ${RESTORE_COMPOSE_ARGS:--f infra/prod/docker-compose.yml})

if [[ "${1:-}" == "--list" ]]; then
  exec "${DC[@]}" exec -T backup sh -c 'ls -lh /backups/last /backups/daily 2>/dev/null'
fi

FILE="${1:-}"
"${DC[@]}" exec -T backup sh -c '
  f="${1:-last/${POSTGRES_DB}-latest.sql.gz}"
  [ -f "/backups/$f" ] || { echo "no such dump: /backups/$f" >&2; exit 2; }
  echo "dump:     /backups/$f ($(du -hL "/backups/$f" | cut -f1), $(date -r "/backups/$f" "+%Y-%m-%d %H:%M"))"
  echo "database: $POSTGRES_DB on $POSTGRES_HOST"
  # checked here, before anything is stopped
  if [ -n "$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -Atc "select 1 from pg_database where datname = '"'"'${POSTGRES_DB}_before_restore'"'"'")" ]; then
    echo "${POSTGRES_DB}_before_restore already exists (from an earlier restore). Drop or rename it first." >&2; exit 3
  fi
' sh "$FILE"

if [[ "${RESTORE_YES:-}" != "1" ]]; then
  read -r -p "Replace the database with this dump? The current one is kept as <name>_before_restore. Type RESTORE to go on: " answer
  [[ "$answer" == "RESTORE" ]] || { echo "nothing done"; exit 1; }
fi

# Tier 565: whatever happens from here on, the app is started again. A failed
# load used to end the script with the app stopped.
restart() { echo "starting backend and frontend…"; "${DC[@]}" up -d backend frontend; }
trap restart EXIT

echo "stopping backend and frontend…"
"${DC[@]}" stop backend frontend

"${DC[@]}" exec -T backup sh -c '
  set -e
  f="${1:-last/${POSTGRES_DB}-latest.sql.gz}"
  export PGPASSWORD="$POSTGRES_PASSWORD"
  admin() { psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
  # anything still connected (an exporter, a forgotten psql) would block the rename
  admin -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '"'"'$POSTGRES_DB'"'"' and pid <> pg_backend_pid()" >/dev/null
  admin -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO \"${POSTGRES_DB}_before_restore\"" -c "CREATE DATABASE \"$POSTGRES_DB\""
  # Tier 565: a dump that does not load must not leave a half-filled database
  # in place of the one that was there. gunzip -t first (a truncated file is
  # the likely case), and if the load still fails: back to the previous one.
  if gunzip -t "/backups/$f" 2>/dev/null \
     && gunzip -c "/backups/$f" | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q >/dev/null; then
    echo "restored $f into $POSTGRES_DB; the previous database is ${POSTGRES_DB}_before_restore"
  else
    echo "the dump did not load — putting the previous database back" >&2
    admin -c "DROP DATABASE \"$POSTGRES_DB\"" -c "ALTER DATABASE \"${POSTGRES_DB}_before_restore\" RENAME TO \"$POSTGRES_DB\""
    echo "NOT restored: $POSTGRES_DB is as it was before" >&2
    exit 4
  fi
' sh "$FILE"

trap - EXIT
restart
echo "done. Check the app, then remove the old database when you are sure:"
echo "  ${DC[*]} exec postgres psql -U <user> -d postgres -c 'DROP DATABASE \"<name>_before_restore\"'"
