#!/bin/bash
# Tier 727 — automatic backups: the database every hour, the files every hour,
# a check every hour that both are fresh
#
# The owner, 21.10.2026: „数据要实现能自动备份数据，按要求多久备份一次“.
# Before: the backup container dumped the database once a day (03:00); the
# files of the storage volume — the kept invoice copies, receipts,
# attachments (GoBD) — were backed up by nothing unless a cron job was set up
# on the host by hand; the app's backup page looked at the development
# directory and saw nothing; a backup that stopped went unnoticed.
#
# Here, against directories of this test run (BACKUP_DB_DIR, BACKUP_FILES_DIR,
# STORAGE_PATH — never the real ones): the status of the dumps, the file
# mirror (new and changed files copied, nothing deleted, earlier versions
# kept), the freshness check; and the compose file's schedule and retention.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="t438-$(date +%s%N | cut -c1-13)"
ROOT="$SCRIPT_DIR/../.."
DB="${BACKUP_DB_DIR:-}"; FILES="${BACKUP_FILES_DIR:-}"; STORE="${STORAGE_PATH:-}"
for d in "$DB" "$FILES" "$STORE"; do
  case "$d" in
    ""|"$HOME/data/"*|/data/*) fail "this spec needs throwaway BACKUP_DB_DIR / BACKUP_FILES_DIR / STORAGE_PATH (got „$d“)"; summary; exit 1 ;;
  esac
done
pass "fixture: throwaway directories ($DB, $FILES, $STORE)"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
stamp() { date -u -v-"$1"H +%Y%m%d-%H%M%S 2>/dev/null || date -u -d "-$1 hours" +%Y%m%d-%H%M%S; }
ago() { python3 -c "import os,sys,time;t=time.time()-float(sys.argv[1])*3600;[os.utime(f,(t,t)) for f in sys.argv[2:]]" "$@"; }

note "=== 1. the compose file: hourly, kept 48 h / 30 days / 12 weeks / 10 years ==="
C="$ROOT/infra/prod/docker-compose.yml"
assert_eq "the database every hour (was once a day, 03:00)" "$(grep -c 'SCHEDULE: ${BACKUP_SCHEDULE:-@hourly}' "$C")" "1"
assert_eq "kept: every dump 48 h, daily 30, weekly 12, monthly 120" \
  "$(grep -cE 'BACKUP_KEEP_MINS: \$\{BACKUP_KEEP_MINS:-2880\}|BACKUP_KEEP_DAYS: \$\{BACKUP_KEEP_DAYS:-30\}|BACKUP_KEEP_WEEKS: \$\{BACKUP_KEEP_WEEKS:-12\}|BACKUP_KEEP_MONTHS: \$\{BACKUP_KEEP_MONTHS:-120\}' "$C")" "4"
assert_eq "the backend sees the dumps (read only) and keeps the file mirror" \
  "$(grep -c -- '- backups:/backups:ro' "$C")/$(grep -c -- '- backup_files:/data/backup-files$' "$C")/$(grep -c 'BACKUP_DB_DIR: /backups' "$C")/$(grep -c 'BACKUP_FILES_DIR: /data/backup-files' "$C")" "2/1/1/1"
assert_eq "the off-site copy: a profile of its own, off by default" "$(grep -c 'profiles: \["offsite"\]' "$C")" "1"
assert_eq "the image owns the mirror's mount point (a new volume takes its owner)" \
  "$(grep -c 'mkdir -p /data/invoice-system /data/backup-files && chown app:app /data/invoice-system /data/backup-files' "$ROOT/backend/Dockerfile")" "1"

note "=== 2. the database dumps ==="
rm -rf "$DB"; mkdir -p "$DB/last" "$DB/daily" "$DB/weekly" "$DB/monthly"
D0="$DB/last/de_invoice-$(stamp 0).sql.gz"; D1="$DB/last/de_invoice-$(stamp 1).sql.gz"; D2="$DB/last/de_invoice-$(stamp 2).sql.gz"
for f in "$D0" "$D1" "$D2"; do echo "dump" | gzip > "$f"; done
ago 1 "$D1"; ago 2 "$D2"
echo daily | gzip > "$DB/daily/de_invoice-$(date -u +%Y%m%d).sql.gz"
echo weekly | gzip > "$DB/weekly/de_invoice-$(date -u +%G%V).sql.gz"
echo monthly | gzip > "$DB/monthly/de_invoice-$(date -u +%Y%m).sql.gz"
ln -sf "$(basename "$D0")" "$DB/last/de_invoice-latest.sql.gz"
AS GET "/api/v1/admin/backups/status"
assert_eq "the status: 3 hourly, 1 daily, 1 weekly, 1 monthly (the -latest link not counted)" \
  "$STATUS/$(P "d['db']['counts']['hourly'], d['db']['counts']['daily'], d['db']['counts']['weekly'], d['db']['counts']['monthly']")" "200/(3, 1, 1, 1)"
assert_eq "…the newest minutes old: fresh" "$(P "d['db']['ok'] and d['db']['ageHours'] < 0.5 and d['db']['latestSizeBytes'] > 0")" "True"
AS POST "/api/v1/admin/backups/status/check" '{}'
assert_eq "the check: fine" "$STATUS/$(P "d['ok']")" "200/True"

ago 5 "$DB"/last/*.sql.gz "$DB"/daily/* "$DB"/weekly/* "$DB"/monthly/*
AS GET "/api/v1/admin/backups/status"
assert_eq "the newest dump 5 hours old: not fresh (at most 3)" "$(P "d['db']['ok'], round(d['db']['ageHours'])")" "(False, 5)"
AS POST "/api/v1/admin/backups/status/check" '{}'
assert_eq "…the check says so: 409 and why" "$STATUS/$(P "'Letzte Datenbanksicherung vor' in d['message']")" "409/True"
echo "dump now" | gzip > "$DB/last/de_invoice-$(stamp 0)b.sql.gz"
AS GET "/api/v1/admin/backups/status"
assert_eq "a new dump: fresh again" "$(P "d['db']['ok']")" "True"

note "=== 3. the files ==="
S="$STORE/$TAG"; mkdir -p "$S/belege"
printf 'rechnung v1' > "$S/RE-1.pdf"; printf 'beleg' > "$S/belege/b.jpg"
AS POST "/api/v1/admin/backups/files/run" '{}'
assert_eq "the mirror: run" "$STATUS" "200"
assert_eq "…the files copied, as they are" \
  "$(cat "$FILES/mirror/$TAG/RE-1.pdf")/$(cat "$FILES/mirror/$TAG/belege/b.jpg")" "rechnung v1/beleg"
AS POST "/api/v1/admin/backups/files/run" '{}'
assert_eq "a second run copies nothing that did not change" "$(P "d['copied']")" "0"
python3 -c "import time;time.sleep(1.2)"
printf 'rechnung v2, longer' > "$S/RE-1.pdf"
rm "$S/belege/b.jpg"
AS POST "/api/v1/admin/backups/files/run" '{}'
assert_eq "a changed file: copied, its earlier version kept" \
  "$(P "d['copied'] >= 1 and d['versioned'] >= 1")/$(cat "$FILES/mirror/$TAG/RE-1.pdf")/$(cat "$FILES"/versions/$TAG/RE-1.pdf.* 2>/dev/null)" "True/rechnung v2, longer/rechnung v1"
assert_eq "a file deleted in storage: still in the mirror" "$(cat "$FILES/mirror/$TAG/belege/b.jpg" 2>/dev/null)" "beleg"
AS GET "/api/v1/admin/backups/status"
assert_eq "the status: the files fresh, the run counted" "$(P "d['files']['ok'] and d['files']['files'] >= 1 and d['files']['versions'] >= 1")" "True"
rm -rf "$S"

summary
