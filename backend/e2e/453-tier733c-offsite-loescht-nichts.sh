#!/bin/bash
# Tier 733c — the off-site copy deletes nothing because of what a server does not have
#
# The `offsite-backup` service ran `rclone sync /backups <remote>/db` every
# hour. On a new server after a loss — its own empty database dumped within
# the hour — the first pass made the remote equal to it. Measured with the
# image the compose file names (rclone 1.68.2) against a local remote: the
# old server's 8 dumps there, one pass of a new server, 4 left — all four
# its empty ones. The archive a restore needs, gone.
#
# Now infra/prod/offsite-backup.sh: the dumps copied, a file that is there
# never overwritten; off-site they go by age only (hourly 3 days, daily 35
# days, weekly 13 weeks, monthly 121 months); the files only ever added. Run
# here with that image, against a local remote, one pass at a time (ONCE=1).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
PROD="$ROOT/infra/prod"
IMG=$(awk '/^  offsite-backup:/{f=1} f && /image:/{print $2; exit}' "$PROD/docker-compose.yml")
assert_eq "the compose file's image" "$IMG" "rclone/rclone:1.68.2"
if ! docker image inspect "$IMG" >/dev/null 2>&1 && ! docker pull -q "$IMG" >/dev/null 2>&1; then
  note "SKIP: the $IMG image is not available here"; summary; exit 0
fi
assert_eq "compose runs the script (no sync in it)" \
  "$(grep -c 'entrypoint: \["/bin/sh", "/offsite-backup.sh"\]' "$PROD/docker-compose.yml")/$(grep -c -- '- ./offsite-backup.sh:/offsite-backup.sh:ro' "$PROD/docker-compose.yml")/$(grep -v '^\s*#' "$PROD/docker-compose.yml" "$PROD/offsite-backup.sh" | grep -c 'rclone sync')" "1/1/0"

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/remote" "$W/files"
printf '[t]\ntype = local\n' > "$W/rclone.conf"
server() { # dir name… — a server's /backups: each dump says whose it is
  local dir="$W/$1"; shift
  mkdir -p "$dir/last" "$dir/daily" "$dir/weekly" "$dir/monthly"
  for f in "$@"; do echo "$(basename "$dir") $f" | gzip > "$dir/$f.sql.gz"; done
  ln -sf "$(basename "$(ls "$dir/last" | tail -1)")" "$dir/last/de_invoice-latest.sql.gz"
}
run_once() { # dir [env…] → OUT, RC
  local dir="$W/$1"; shift
  OUT=$(docker run --rm --user "$(id -u):$(id -g)" -e ONCE=1 -e REMOTE=t:/remote -e RCLONE_CONFIG=/config/rclone.conf "$@" \
    -v "$W/rclone.conf:/config/rclone.conf:ro" -v "$dir:/backups:ro" -v "$W/files:/data/backup-files:ro" -v "$W/remote:/remote" \
    -v "$PROD/offsite-backup.sh:/offsite-backup.sh:ro" --entrypoint /bin/sh "$IMG" /offsite-backup.sh 2>&1); RC=$?
}
remote() { (cd "$W/remote/db" && find . -name '*.sql.gz' | sed 's|^\./||' | sort | tr '\n' ' '); }
whose() { gunzip -c "$W/remote/db/$1.sql.gz" | cut -d' ' -f1; }
age() { python3 -c "import os,sys,time;t=time.time()-float(sys.argv[1])*86400;os.utime(sys.argv[2],(t,t))" "$1" "$W/remote/db/$2.sql.gz"; }

note "=== 1. the old server: its dumps off-site ==="
server old last/de_invoice-20261028-090000 last/de_invoice-20261028-100000 daily/de_invoice-20261027 daily/de_invoice-20261028 \
  weekly/de_invoice-202643 weekly/de_invoice-202644 monthly/de_invoice-202609 monthly/de_invoice-202610
echo "kept copy of an invoice" > "$W/files/INV-1.pdf"
run_once old
assert_eq "one pass: ok" "$RC/$(grep -c 'offsite: ok' <<<"$OUT")" "0/1"
assert_eq "8 dumps off-site (the -latest link not copied)" "$(remote | wc -w | tr -d ' ')" "8"
assert_eq "…and the files" "$(cat "$W/remote/files/INV-1.pdf")" "kept copy of an invoice"

note "=== 2. a new server's first pass: its empty database dumped, the old dumps not here ==="
server new last/de_invoice-20261029-120000 daily/de_invoice-20261029 weekly/de_invoice-202644 monthly/de_invoice-202610
rm "$W/files/INV-1.pdf"
run_once new
assert_eq "ok" "$RC" "0"
assert_eq "all 8 old dumps still off-site, the new server's 2 new names added (was: 4 left, all the new server's)" "$(remote | wc -w | tr -d ' ')" "10"
assert_eq "this month's and this week's file: the old server's, not overwritten by the empty one" \
  "$(whose monthly/de_invoice-202610) $(whose weekly/de_invoice-202644)" "old old"
assert_eq "the old server's newest hourly dump is there to restore from" "$(whose last/de_invoice-20261028-100000)" "old"
assert_eq "the kept copy deleted here stays off-site" "$(cat "$W/remote/files/INV-1.pdf")" "kept copy of an invoice"

note "=== 3. off-site, they go by age only ==="
age 4 last/de_invoice-20261028-090000; age 2 last/de_invoice-20261028-100000
age 36 daily/de_invoice-20261027; age 30 daily/de_invoice-20261028
age 92 weekly/de_invoice-202643
age 730 monthly/de_invoice-202609; age 3700 monthly/de_invoice-202610
run_once new
assert_eq "hourly older than 3 days, daily older than 35, weekly older than 13 weeks, monthly older than 121 months: removed" \
  "$(remote)" "daily/de_invoice-20261028.sql.gz daily/de_invoice-20261029.sql.gz last/de_invoice-20261028-100000.sql.gz last/de_invoice-20261029-120000.sql.gz monthly/de_invoice-202609.sql.gz weekly/de_invoice-202644.sql.gz "
run_once new -e OFFSITE_KEEP_DAILY=1d
assert_eq "the ages can be set (OFFSITE_KEEP_DAILY=1d)" "$(remote | tr ' ' '\n' | grep -c '^daily/')" "1"

note "=== 4. no remote: nothing done ==="
run_once new -e REMOTE=
assert_eq "refused, said why" "$RC/$(grep -c 'BACKUP_OFFSITE_REMOTE is not set' <<<"$OUT")" "1/1"

summary
