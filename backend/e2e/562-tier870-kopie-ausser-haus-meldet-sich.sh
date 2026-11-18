#!/bin/bash
# Tier 870 — the off-site copy says how its last pass went, and a copy that stopped turns the backup page red
#
# The backup page and the operator page said „Kopie außer Haus: <remote>“ as
# soon as BACKUP_OFFSITE_REMOTE was set — whether the `offsite-backup` service
# ran, copied, or refused (Tier 856: a plain remote copies nothing). The
# dumps and the file mirror had a freshness check (Tier 727); the off-site
# copy had none, and could stop for months unseen until the day a restore
# needed it.
#
# Now each pass writes last-run.json and, when it went through, last-ok into
# the `offsite_status` volume; the backend reads them (read only) for the
# status, the pages and the hourly freshness check.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
PROD="$ROOT/infra/prod"
IMG=$(awk '/^  offsite-backup:/{f=1} f && /image:/{print $2; exit}' "$PROD/docker-compose.yml")
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

note "=== 1. the script leaves its result ==="
if ! docker image inspect "$IMG" >/dev/null 2>&1 && ! docker pull -q "$IMG" >/dev/null 2>&1; then
  note "SKIP (1): the $IMG image is not available here"
else
  mkdir -p "$W/remote" "$W/files" "$W/backups/last" "$W/backups/daily" "$W/backups/weekly" "$W/backups/monthly" "$W/st-ok" "$W/st-plain" "$W/st-none"
  echo dump | gzip > "$W/backups/last/de_invoice-20261118-100000.sql.gz"
  P1=$(docker run --rm --pull=never "$IMG" obscure "spec-562-$$")
  printf '[plain]\ntype = local\n\n[sec]\ntype = crypt\nremote = plain:/remote\npassword = %s\n' "$P1" > "$W/rclone.conf"
  run_once() { # status-dir remote
    docker run --rm --pull=never --user "$(id -u):$(id -g)" -e ONCE=1 -e REMOTE="$2" -e STATUS_DIR=/status -e RCLONE_CONFIG=/config/rclone.conf \
      -v "$W/rclone.conf:/config/rclone.conf:ro" -v "$W/backups:/backups:ro" -v "$W/files:/data/backup-files:ro" -v "$W/remote:/remote" \
      -v "$W/$1:/status" -v "$PROD/offsite-backup.sh:/offsite-backup.sh:ro" --entrypoint /bin/sh "$IMG" /offsite-backup.sh >/dev/null 2>&1
  }
  field() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d[sys.argv[2]])" "$W/$1/last-run.json" "$2" 2>/dev/null; }
  run_once st-ok sec:
  assert_eq "a pass that went through: ok, and its time in last-ok" "$(field st-ok ok) $(field st-ok message) $([[ -s "$W/st-ok/last-ok" ]] && echo last-ok)" "True ok last-ok"
  run_once st-plain plain:/remote
  assert_eq "a plain remote: not ok, with the reason, no last-ok" \
    "$(field st-plain ok) $(field st-plain message | grep -c 'is no crypt remote') $([[ -e "$W/st-plain/last-ok" ]] && echo last-ok || echo none)" "False 1 none"
  run_once st-none ""
  assert_eq "no remote set: not ok, says so" "$(field st-none ok) $(field st-none message | grep -c 'BACKUP_OFFSITE_REMOTE is not set')" "False 1"
fi

note "=== 2. the backend reads it ==="
mkdir -p "$W/s-fresh" "$W/s-old" "$W/s-fail" "$W/s-none"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ); OLD=$(date -u -v-10H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '10 hours ago' +%Y-%m-%dT%H:%M:%SZ)
printf '{"at":"%s","ok":true,"remote":"sec:","message":"ok"}\n' "$NOW" > "$W/s-fresh/last-run.json"; echo "$NOW" > "$W/s-fresh/last-ok"
printf '{"at":"%s","ok":true,"remote":"sec:","message":"ok"}\n' "$OLD" > "$W/s-old/last-run.json"; echo "$OLD" > "$W/s-old/last-ok"
printf '{"at":"%s","ok":false,"remote":"box:","message":"box: is no crypt remote (type: sftp) — nothing is copied"}\n' "$NOW" > "$W/s-fail/last-run.json"
OUT=$(cd "$SCRIPT_DIR/.." && ./node_modules/.bin/ts-node -T -e "
import { ProductionBackupsService } from './src/modules/backup/production-backups.service'
const svc = new ProductionBackupsService()
const at = (dir: string | null, remote: string | null) => {
  if (remote) process.env.BACKUP_OFFSITE_REMOTE = remote; else delete process.env.BACKUP_OFFSITE_REMOTE
  if (dir) process.env.BACKUP_OFFSITE_STATUS_DIR = dir; else delete process.env.BACKUP_OFFSITE_STATUS_DIR
  const s = svc.offsiteStatus()
  const v = (x: unknown) => (x == null ? '-' : String(x))
  return [s.configured, v(s.ok), v(s.lastRunOk), s.ageHours == null ? '-' : Math.round(s.ageHours), s.message ?? '-'].join('/')
}
console.log(at('$W/s-fresh', 'sec:'))
console.log(at('$W/s-old', 'sec:'))
console.log(at('$W/s-fail', 'box:'))
console.log(at('$W/s-none', 'sec:'))
console.log(at(null, 'sec:'))
console.log(at('$W/s-fresh', null))
" 2>&1)
assert_eq "a pass within the hour: ok" "$(sed -n 1p <<<"$OUT")" "true/true/true/0/ok"
assert_eq "the last good pass 10 h ago (allowed 6): not ok" "$(sed -n 2p <<<"$OUT")" "true/false/true/10/ok"
assert_eq "a refusing pass: not ok, with its words" "$(sed -n 3p <<<"$OUT")" "true/false/false/-/box: is no crypt remote (type: sftp) — nothing is copied"
assert_eq "set up, but never ran: not ok" "$(sed -n 4p <<<"$OUT")" "true/false/-/-/-"
assert_eq "an installation that does not report (no status dir): unknown, as before" "$(sed -n 5p <<<"$OUT")" "true/-/-/-/-"
assert_eq "no remote: not set up" "$(sed -n 6p <<<"$OUT")" "false/-/-/-/-"
assert_eq "the hourly check reports a failing or stale copy" \
  "$(grep -c 'Kopie außer Haus fehlgeschlagen' "$SCRIPT_DIR/../src/modules/backup/backup.scheduler.ts")/$(grep -c 'Letzte Kopie außer Haus vor' "$SCRIPT_DIR/../src/modules/backup/backup.scheduler.ts")" "1/1"

note "=== 3. the compose file wires it ==="
printf 'POSTGRES_PASSWORD=x\nJWT_SECRET=x\nFRONTEND_URL=https://x.test\nFINTS_PIN_ENC_KEY=x0123456789abcdef0123456789abcdef\nSETUP_TOKEN=x\n' > "$W/env"
if docker compose version >/dev/null 2>&1; then
  docker compose --env-file "$W/env" -f "$PROD/docker-compose.yml" --profile offsite config --format json > "$W/cfg" 2>/dev/null
  WIRE=$(python3 - "$W/cfg" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))['services']
def mount(n):
    m = [v for v in d[n]['volumes'] if v.get('source') == 'offsite_status']
    return (m[0]['target'] + (':ro' if m[0].get('read_only') else ':rw')) if m else 'none'
print(mount('offsite-backup'), d['offsite-backup']['environment'].get('STATUS_DIR'), mount('backend'), d['backend']['environment'].get('BACKUP_OFFSITE_STATUS_DIR'))
PY
)
  assert_eq "the service writes the volume, the backend reads it" "$WIRE" "/status:rw /status /data/offsite-status:ro /data/offsite-status"
fi
summary
