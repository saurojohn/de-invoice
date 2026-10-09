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
# Tier 630: Prisma's "Update available" box goes to stderr, which is read here
# as part of the difference — outside CI it appears about once a day and
# counted as ten lines of schema drift.
export PRISMA_HIDE_UPDATE_MESSAGE=1
DIFF=$(npx prisma migrate diff --from-url "$URL" --to-schema-datamodel prisma/schema.prisma --script 2>&1 | grep -v "search_tsv" | grep -v "^--" | grep -v "^[[:space:]]*$" || true)
assert_eq "…and the result is the schema (was: 14 tables and 11 columns short)" "$(grep -c . <<<"$DIFF" || true)" "0"
[[ -n "$DIFF" ]] && echo "$DIFF" | head -20
assert_eq "…with the full-text columns the search reads" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d "$DB" -Atc "select count(*) from information_schema.columns where column_name='search_tsv'")" "3"
assert_eq "…and the session table sign-in needs" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d "$DB" -Atc "select count(*) from information_schema.tables where table_name='UserSession'")" "1"

note "=== the catch-up migration on a database that already has everything ==="
OUT=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d "$DB" -v ON_ERROR_STOP=1 -q < prisma/migrations/20261006000005_catch_up_with_schema/migration.sql 2>&1 | grep -c "ERROR" || true)
assert_eq "runs again without an error" "$OUT" "0"
note "=== Tier 571: on a database whose old rows break a new foreign key ==="
# The first real database this migration met had rows a new constraint does
# not allow (credit transactions of customers that had been deleted): the
# plain ADD CONSTRAINT failed and took the whole migration with it, so
# `migrate deploy` stopped there. The keys are now added NOT VALID and
# validated right after; one that cannot be validated stays, for new rows.
PSQL() { docker exec -i "$PG_CONTAINER" psql -U de_invoice -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
PSQL -c 'ALTER TABLE "UserSession" DROP CONSTRAINT "UserSession_userId_fkey"' >/dev/null
PSQL -c "INSERT INTO \"UserSession\" (id, \"userId\", token, \"expiresAt\") VALUES ('orphan-571', 'a-user-who-is-gone', 'tok-571', now() + interval '1 day')" >/dev/null
OUT=$(PSQL < prisma/migrations/20261006000005_catch_up_with_schema/migration.sql 2>&1)
assert_eq "the migration runs through (was: ERROR 23503, nothing applied)" "$(grep -c 'ERROR' <<<"$OUT" || true)" "0"
assert_eq "…and says which key it could not validate" "$(grep -c 'WARNING.*UserSession_userId_fkey' <<<"$OUT" || true)" "1"
assert_eq "…the key is there, for new rows (not validated)" "$(PSQL -c "select convalidated::text from pg_constraint where conname='UserSession_userId_fkey'")" "false"
assert_eq "…a new row without its user is refused" "$(PSQL -c "INSERT INTO \"UserSession\" (id, \"userId\", token, \"expiresAt\") VALUES ('orphan-571b', 'nobody', 'tok-571b', now())" 2>&1 | grep -c 'violates foreign key')" "1"
assert_eq "…the old row was left alone" "$(PSQL -c "select count(*) from \"UserSession\" where id='orphan-571'")" "1"
assert_eq "…and every other key is validated" "$(PSQL -c "select count(*) from pg_constraint where contype='f' and not convalidated")" "1"

note "=== Tier 635: a table that is filtered by company has an index that leads with it ==="
MISSING=$(python3 - "$SCRIPT_DIR/../prisma/schema.prisma" <<'PY'
import re, sys
schema = open(sys.argv[1], encoding="utf-8").read()
out = []
for m in re.finditer(r"^model (\w+) \{(.*?)^\}", schema, re.S | re.M):
    name, body = m.group(1), m.group(2)
    if not re.search(r"^\s+companyId\s+String", body, re.M): continue
    lead = re.findall(r"@@(?:index|unique|id)\(\[\s*(\w+)", body)
    alone = re.search(r"^\s+companyId\s+String\??\s+.*@(unique|id)\b", body, re.M)
    if "companyId" not in lead and not alone: out.append(name)
print(" ".join(out) or "-")
PY
)
assert_eq "every model with a companyId has one (was: User, CustomerPortalSession, VatRate, VatRateHistory, WebhookDelivery without)" "$MISSING" "-"

summary
