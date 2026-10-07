#!/usr/bin/env bash
# Tier 559 — give a database that was created with `prisma db push` a
# migration history, once, so that `prisma migrate deploy` works on it.
#
# infra/prod/HETZNER-DEPLOY.sh used to create the schema with `db push`. Such a
# database has no _prisma_migrations table, and `migrate deploy` refuses it
# (P3005, "the database schema is not empty").
#
# What this does, with DATABASE_URL pointing at that database:
#   1. applies the two migrations that are safe on an existing schema and that
#      `db push` cannot produce or may have left behind: the full-text search
#      columns (raw SQL) and the catch-up migration (IF NOT EXISTS throughout);
#   2. checks that the database now has exactly the current schema, and stops
#      if it does not;
#   3. records every migration in prisma/migrations as applied.
# It changes no data. Run it from backend/ (in production:
#   docker compose -f infra/prod/docker-compose.yml exec backend bash scripts/baseline-migrations.sh).
# Afterwards `npx prisma migrate deploy` is the update step, as the README says.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL is required}"

if npx prisma migrate status >/dev/null 2>&1; then
  echo "migration history is already in place and up to date — nothing to do"; exit 0
fi
if echo 'select 1 from "_prisma_migrations" limit 1' | npx prisma db execute --stdin --url "$DATABASE_URL" >/dev/null 2>&1; then
  echo "this database already has a migration history; use: npx prisma migrate deploy"; exit 0
fi
for m in 20260701000001_search_tsv 20261006000005_catch_up_with_schema; do
  echo "applying $m (safe on an existing schema)"
  npx prisma db execute --file "prisma/migrations/$m/migration.sql" --url "$DATABASE_URL"
done
# Tier 565: only a database that HAS the current schema may be told that every
# migration ran. This step used to follow unconditionally: on a database
# pushed from an older schema, a migration that was never executed was
# recorded as applied — `migrate deploy` then said "up to date" and the
# missing column stayed missing for good.
DIFF=$(npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script 2>/dev/null \
  | grep -v "search_tsv" | grep -v "^--" | grep -v "^[[:space:]]*$" || true)
if [ -n "$DIFF" ]; then
  echo "This database does not have the current schema, so its history cannot be written down as complete." >&2
  echo "Nothing was recorded. Bring it up to date first (npx prisma db push), then run this again. Missing:" >&2
  echo "$DIFF" | head -20 >&2
  exit 1
fi
for d in prisma/migrations/*/; do
  npx prisma migrate resolve --applied "$(basename "$d")" >/dev/null
done
echo "recorded $(ls -d prisma/migrations/*/ | wc -l | tr -d ' ') migrations as applied"
npx prisma migrate status | tail -2
