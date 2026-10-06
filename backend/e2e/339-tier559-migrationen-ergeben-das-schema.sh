#!/bin/bash
# Tier 559 — the migrations build the schema the app runs on
#
# CI and the first-deploy script create the database with `prisma db push`;
# the documented update path is `prisma migrate deploy`. Nothing compared the
# two. Measured: a database built from the migrations alone lacked fourteen
# tables (UserSession, Webhook, the SEPA tables, CronHealth,
# NotificationConfig …) and eleven columns — sign-in could not work on it.
# Migration 20261006000005_catch_up_with_schema closes the gap; this spec
# keeps it closed: every schema change needs its migration from now on.
# (The search_tsv columns come from a raw-SQL migration and are unknown to
# the schema — the one difference that is expected.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
if [[ -z "${DATABASE_URL:-}" ]]; then
  note "SKIP: DATABASE_URL is not set in this shell"; summary; exit 0
fi
DB="migcheck_$$"
URL=$(python3 -c "import re,sys;print(re.sub(r'/[^/?]+(\?|$)', r'/'+sys.argv[2]+r'\1', sys.argv[1], count=1))" "$DATABASE_URL" "$DB")
psqlc() { docker exec "$PG_CONTAINER" psql -U de_invoice -d postgres -qAtc "$1" 2>&1; }
cleanup() { psqlc "drop database if exists $DB" >/dev/null; }
trap cleanup EXIT
psqlc "create database $DB" >/dev/null
cd "$SCRIPT_DIR/.."

OUT=$(DATABASE_URL="$URL" npx prisma migrate deploy 2>&1)
grep -q "All migrations have been successfully applied" <<<"$OUT" && pass "every migration applies to an empty database" || fail "migrate deploy: $(tail -5 <<<"$OUT")"
DIFF=$(npx prisma migrate diff --from-url "$URL" --to-schema-datamodel prisma/schema.prisma --script 2>&1 | grep -v "search_tsv" | grep -v "^--" | grep -v "^[[:space:]]*$" || true)
assert_eq "…and the result is the schema (was: 14 tables and 11 columns short)" "$(grep -c . <<<"$DIFF" || true)" "0"
[[ -n "$DIFF" ]] && echo "$DIFF" | head -20
assert_eq "…with the full-text columns the search reads" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d "$DB" -Atc "select count(*) from information_schema.columns where column_name='search_tsv'")" "3"
assert_eq "…and the session table sign-in needs" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d "$DB" -Atc "select count(*) from information_schema.tables where table_name='UserSession'")" "1"

note "=== the catch-up migration on a database that already has everything ==="
OUT=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d "$DB" -v ON_ERROR_STOP=1 -q < prisma/migrations/20261006000005_catch_up_with_schema/migration.sql 2>&1 | grep -c "ERROR" || true)
assert_eq "runs again without an error" "$OUT" "0"
summary
