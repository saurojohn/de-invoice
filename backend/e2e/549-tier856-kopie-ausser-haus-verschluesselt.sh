#!/bin/bash
# Tier 856 — the off-site copy is encrypted; the restore drill loads it back
#
# Security audit (18.11.2026), item 1: `offsite-backup.sh` copied the dumps
# (every invoice, customer, IBAN, user) and the kept invoice files to whatever
# rclone remote BACKUP_OFFSITE_REMOTE named. HETZNER-DEPLOY.md §9 offered a
# crypt remote as „optional“ and the plain Storage Box as the alternative —
# there the books lay as they are on the server, readable by anyone with the
# box's password. `scripts/backup-prod.sh` (the host cron variant) uploaded
# them unencrypted when no gpg passphrase was set.
#
# Now the off-site service copies to an rclone crypt remote only, and the
# cron script refuses to upload unencrypted. Item 16: `infra/prod/restore-drill.sh`
# loads the newest dump — the off-site one included — into a throwaway
# database and says what is in it.
#
# Run here with the compose file's images against a local remote.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
PROD="$ROOT/infra/prod"
image_of() { awk -v s="  $1:" '$0 == s {f=1} f && /image:/ {print $2; exit}' "$PROD/docker-compose.yml"; }
RIMG=$(image_of offsite-backup); PIMG=$(image_of postgres)
assert_eq "the compose file's images" "$RIMG $PIMG" "rclone/rclone:1.68.2 postgres:16-alpine"
for img in "$RIMG" "$PIMG"; do
  if ! docker image inspect "$img" >/dev/null 2>&1 && ! docker pull -q "$img" >/dev/null 2>&1; then
    note "SKIP: the $img image is not available here"; summary; exit 0
  fi
done

W=$(mktemp -d); PG="spec549-pg-$$"
trap 'docker rm -f "$PG" >/dev/null 2>&1; rm -rf "$W"' EXIT
mkdir -p "$W/remote" "$W/files" "$W/server/last" "$W/server/daily" "$W/server/weekly" "$W/server/monthly"
P1=$(docker run --rm --pull=never "$RIMG" obscure "spec-549-a-$$"); P2=$(docker run --rm --pull=never "$RIMG" obscure "spec-549-b-$$")
printf '[plain]\ntype = local\n\n[sec]\ntype = crypt\nremote = plain:/remote\npassword = %s\npassword2 = %s\n' "$P1" "$P2" > "$W/rclone.conf"
run_once() { # [env…] → OUT, RC
  OUT=$(docker run --rm --pull=never --user "$(id -u):$(id -g)" -e ONCE=1 -e REMOTE=sec: -e RCLONE_CONFIG=/config/rclone.conf "$@" \
    -v "$W/rclone.conf:/config/rclone.conf:ro" -v "$W/server:/backups:ro" -v "$W/files:/data/backup-files:ro" -v "$W/remote:/remote" \
    -v "$PROD/offsite-backup.sh:/offsite-backup.sh:ro" --entrypoint /bin/sh "$RIMG" /offsite-backup.sh 2>&1); RC=$?
}
rcat() { docker run --rm --pull=never --user "$(id -u):$(id -g)" -e RCLONE_CONFIG=/c -v "$W/rclone.conf:/c:ro" -v "$W/remote:/remote:ro" "$RIMG" cat "sec:$1" 2>/dev/null; }

note "=== 1. a dump the way the backup container writes it (pg_dump -Z6 of the production role) ==="
docker run -d --pull=never --name "$PG" -e POSTGRES_USER=de_invoice -e POSTGRES_PASSWORD=x -e POSTGRES_DB=de_invoice "$PIMG" >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" psql -U de_invoice -d de_invoice -Atqc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
docker exec -i "$PG" psql -U de_invoice -d de_invoice -v ON_ERROR_STOP=1 -q <<'SQL'
create table "Company" (id text primary key, name text, iban text);
create table "User" (id text primary key, email text);
create table "Invoice" (id text primary key, "companyId" text references "Company"(id), "createdAt" timestamp(3));
create table _prisma_migrations (id text primary key, migration_name text, finished_at timestamptz);
insert into "Company" values ('c1', 'Spec 549 GmbH', 'DE02120300000000202051');
insert into "User" values ('u1', 'owner@spec549.example');
insert into "Invoice" values ('i1', 'c1', '2026-11-16 09:00'), ('i2', 'c1', '2026-11-17 10:30');
insert into _prisma_migrations values ('m1', '20261118000001_dunning_income', now());
SQL
docker exec "$PG" pg_dump -U de_invoice -d de_invoice -Z6 > "$W/server/last/de_invoice-20261117-110000.sql.gz"
assert_eq "the dump has the customer's IBAN in it" "$(gunzip -c "$W/server/last/de_invoice-20261117-110000.sql.gz" | grep -c DE02120300000000202051)" "1"
echo "Rechnung RE-549 an Spec 549 GmbH" > "$W/files/RE-549.pdf"

note "=== 2. a plain remote: refused, nothing copied (was: copied as it is) ==="
run_once -e REMOTE=plain:/remote
assert_eq "refused, said why" "$RC/$(grep -c 'is no crypt remote (type: local)' <<<"$OUT")" "1/1"
assert_eq "nothing on the remote" "$(find "$W/remote" -type f | wc -l | tr -d ' ')" "0"
run_once -e REMOTE=storagebox:de-invoice
assert_eq "a remote not in rclone.conf: refused" "$RC/$(grep -c 'type: not in rclone.conf' <<<"$OUT")" "1/1"

note "=== 3. the crypt remote: copied, nothing readable there ==="
run_once
assert_eq "one pass: ok" "$RC/$(grep -c 'offsite: ok' <<<"$OUT")" "0/1"
assert_eq "two files on the storage" "$(find "$W/remote" -type f | wc -l | tr -d ' ')" "2"
assert_eq "no name there says what it is (no .sql.gz, no RE-549, no de_invoice, no last/)" \
  "$(find "$W/remote" | grep -c -E 'sql|RE-549|de_invoice|/last|/files|/db')" "0"
assert_eq "no file there is a gzip (the dump's own format)" \
  "$(find "$W/remote" -type f -exec sh -c 'head -c2 "$1" | od -An -tx1 | tr -d " \n"; echo' sh {} \; | grep -c '^1f8b')" "0"
assert_eq "the IBAN and the invoice text are nowhere there in the clear" \
  "$(grep -rl -a -E 'DE02120300000000202051|RE-549|Spec 549' "$W/remote" | wc -l | tr -d ' ')" "0"
assert_eq "through the crypt remote, with its passwords: the dump as it was" \
  "$(rcat db/last/de_invoice-20261117-110000.sql.gz | gunzip -c | grep -c DE02120300000000202051)" "1"
assert_eq "…and the file" "$(rcat files/RE-549.pdf)" "Rechnung RE-549 an Spec 549 GmbH"

note "=== 4. the restore drill from the off-site copy ==="
DRILL=$(cd "$W" && BACKUP_OFFSITE_REMOTE=sec: DRILL_RCLONE_CONF="$W/rclone.conf" DRILL_DOCKER_ARGS="-v $W/remote:/remote:ro" \
  bash "$PROD/restore-drill.sh" --offsite 2>&1); DRC=$?
assert_eq "the drill: ok" "$DRC/$(grep -c 'drill: ok' <<<"$DRILL")" "0/1"
assert_eq "it fetched the newest hourly dump off-site" "$(grep -c 'dump: sec:/db/last/de_invoice-20261117-110000.sql.gz' <<<"$DRILL")" "1"
# createdAt is stored in UTC (Prisma); the drill shows it German time
assert_eq "what is in it" "$(grep -E 'drill: (tables|companies|users|invoices|last migration)' <<<"$DRILL" | sed 's/^drill: //' | tr '\n' '|')" \
  "tables: 4|companies: 1|users: 1|invoices: 2, the newest created 2026-11-17 11:30|last migration: 20261118000001_dunning_income|"
assert_eq "its throwaway database is gone" "$(docker ps -a --format '{{.Names}}' | grep -c '^de-invoice-restore-drill-')" "0"
assert_eq "the off-site copy unchanged" "$(find "$W/remote" -type f | wc -l | tr -d ' ')" "2"

note "=== 5. the drill says when a dump cannot be restored ==="
head -c 300 "$W/server/last/de_invoice-20261117-110000.sql.gz" > "$W/cut.sql.gz"
DRILL=$(DRILL_DUMP="$W/cut.sql.gz" bash "$PROD/restore-drill.sh" 2>&1); DRC=$?
assert_eq "a truncated dump: FAILED, said why" "$DRC/$(grep -c 'FAILED — the file is no intact gzip' <<<"$DRILL")" "1/1"
docker exec "$PG" psql -U de_invoice -d de_invoice -qc 'delete from "Invoice"; delete from "Company"'
docker exec "$PG" pg_dump -U de_invoice -d de_invoice -Z6 > "$W/empty.sql.gz"
DRILL=$(DRILL_DUMP="$W/empty.sql.gz" bash "$PROD/restore-drill.sh" 2>&1); DRC=$?
assert_eq "a dump of an empty installation: FAILED, said why" "$DRC/$(grep -c 'FAILED — the dump holds no company' <<<"$DRILL")" "1/1"

note "=== 6. the host cron script and the guide ==="
assert_eq "backup-prod.sh refuses an unencrypted upload" \
  "$(grep -c 'is no crypt remote and BACKUP_ENCRYPTION_PASSPHRASE is empty' "$ROOT/scripts/backup-prod.sh")" "1"
assert_eq "HETZNER-DEPLOY.md no longer offers the plain Storage Box" \
  "$(grep -c 'without encryption' "$PROD/HETZNER-DEPLOY.md")/$(grep -c 'a plain one is refused' "$PROD/HETZNER-DEPLOY.md")" "0/1"
assert_eq "the guide names the drill" "$(grep -c 'restore-drill.sh' "$PROD/HETZNER-DEPLOY.md" "$PROD/RUNBOOK.md" | awk -F: '{s+=($2>0)} END {print s}')" "2"

summary
