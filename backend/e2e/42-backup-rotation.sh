#!/bin/bash
# Tier 360 — backup.sh rotation must not let failed runs delete real backups
#
# scripts/backup.sh leaves a dated stage dir even when pg_dump fails
# (attachments only, no db.sql.gz). Its rotation used to hand out the
# 7 daily / 4 weekly / monthly slots by the date of ANY stage dir, so a
# stretch of failed nights pushed the backups that contain the database
# out of their slots and deleted them. On a developer machine five failed
# nights (2026-09-06..10) left the last full backup two failed runs from
# deletion.
#
# No backend or database needed: pg_dump is a stub on PATH (failing, then
# succeeding), the docker branch is bypassed with a container name that
# does not exist, and everything lives in a mktemp dir. Fixture dates are
# in 2020 so the "current year" monthly-anchor rule never applies to them
# and the expected result does not depend on today's date.
#
#   A. 7 complete backups + 10 failed nights, then one more failed run:
#      every complete backup survives; only the 7 newest dump-less dirs
#      are kept.
#   B. then a successful run: normal rotation resumes (7 daily complete,
#      the oldest dropped) and the dump-less dirs, now superseded, go.
#
# BACKUP_SCRIPT=/path/to/other/backup.sh runs the same assertions against
# another copy of the script — that is how the pre-Tier-360 script was
# confirmed to fail A1.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-$REPO_ROOT/scripts/backup.sh}"
[[ -f "$BACKUP_SCRIPT" ]] || { echo "FATAL: backup script not found at $BACKUP_SCRIPT"; exit 1; }

echo "=== Test: Tier 360 backup rotation vs failed runs ==="

WORK=$(mktemp -d /tmp/t360-rotation.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
ROOT="$WORK/backups"
ATT="$WORK/invoice-system"
BIN="$WORK/bin"
mkdir -p "$ROOT" "$ATT" "$BIN"
echo "receipt" > "$ATT/receipt.pdf"

# $1 = fail | ok. The script's host branch calls pg_dump --file=<path>.
stub_pg_dump() {
  if [[ "$1" == fail ]]; then
    printf '#!/bin/sh\necho "stub pg_dump: connection refused" >&2\nexit 1\n' > "$BIN/pg_dump"
  else
    printf '#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) printf PGDMP > "${a#--file=}";; esac; done\nexit 0\n' > "$BIN/pg_dump"
  fi
  chmod +x "$BIN/pg_dump"
}

run_backup() {
  PATH="$BIN:$PATH" BACKUP_ROOT="$ROOT" ATTACHMENT_PATH="$ATT" \
    PG_CONTAINER="t360-no-such-container" BACKUP_S3_BUCKET="" \
    KEEP_DAILY=7 KEEP_WEEKLY=4 \
    bash "$BACKUP_SCRIPT" > "$WORK/run.log" 2>&1 < /dev/null
}

# $1 = stage id, $2 = complete | failed
mk_backup() {
  mkdir -p "$ROOT/backup-$1"
  echo att > "$ROOT/backup-$1/attachments.tar.gz"
  [[ "$2" == complete ]] && printf PGDMP > "$ROOT/backup-$1/db.sql.gz"
  return 0
}
exists() { [[ -d "$ROOT/backup-$1" ]]; }
failed_dirs() {
  for d in "$ROOT"/backup-*; do
    if [[ -d "$d" && ! -f "$d/db.sql.gz" ]]; then basename "$d"; fi
  done
}

COMPLETE_FIXTURE="2020-08-24 2020-08-25 2020-08-26 2020-08-27 2020-08-28 2020-08-29 2020-08-30"
FAILED_FIXTURE="2020-08-31 2020-09-01 2020-09-02 2020-09-03 2020-09-04 2020-09-05 2020-09-06 2020-09-07 2020-09-08 2020-09-09"
for d in $COMPLETE_FIXTURE; do mk_backup "$d-040000" complete; done
for d in $FAILED_FIXTURE; do mk_backup "$d-040000" failed; done

# ===== A. one more failed run on top of 10 failed nights =====
note "A. failed run with 7 complete backups and 10 failed nights on disk"
stub_pg_dump fail
run_backup
A_EXIT=$?
[[ $A_EXIT -eq 1 ]] && pass "A0. failed dump exits 1" \
  || fail "A0. expected exit 1, got $A_EXIT: $(tail -3 "$WORK/run.log")"

MISSING=""
for d in $COMPLETE_FIXTURE; do exists "$d-040000" || MISSING+=" $d"; done
[[ -z "$MISSING" ]] && pass "A1. all 7 complete backups survive the failed run" \
  || fail "A1. rotation deleted complete backups:$MISSING"

A_RUN=$(ls -1 "$ROOT" | grep -vE '^backup-2020-' | sort | tail -1)
if [[ -n "$A_RUN" && ! -f "$ROOT/$A_RUN/db.sql.gz" && -f "$ROOT/$A_RUN/db.dump.log" ]]; then
  pass "A2. the failed run's own dir is kept, with its db.dump.log ($A_RUN)"
else
  fail "A2. failed run dir missing or unexpected: '$A_RUN'"
fi

KEPT_FAILED=$(failed_dirs | wc -l | tr -d ' ')
[[ "$KEPT_FAILED" == "7" ]] && pass "A3. dump-less dirs capped at KEEP_DAILY=7" \
  || fail "A3. expected 7 dump-less dirs, got $KEPT_FAILED: $(failed_dirs | tr '\n' ' ')"

STILL=""
for d in 2020-08-31 2020-09-01 2020-09-02 2020-09-03; do exists "$d-040000" && STILL+=" $d"; done
[[ -z "$STILL" ]] && pass "A4. dump-less dirs beyond the cap were removed" \
  || fail "A4. still present:$STILL"

# ===== B. a successful run after the failures =====
note "B. successful run after the failures"
sleep 1   # stage dirs are named to the second
stub_pg_dump ok
run_backup
B_EXIT=$?
[[ $B_EXIT -eq 0 ]] && pass "B0. successful run exits 0" \
  || fail "B0. expected exit 0, got $B_EXIT: $(tail -3 "$WORK/run.log")"

B_RUN=$(ls -1 "$ROOT" | grep -vE '^backup-2020-' | sort | tail -1)
if [[ -n "$B_RUN" && "$B_RUN" != "$A_RUN" && -f "$ROOT/$B_RUN/db.sql.gz" ]]; then
  pass "B1. new complete backup written ($B_RUN)"
else
  fail "B1. expected a new complete backup, newest is '$B_RUN'"
fi

MISSING=""
for d in 2020-08-25 2020-08-26 2020-08-27 2020-08-28 2020-08-29 2020-08-30; do
  exists "$d-040000" || MISSING+=" $d"
done
if [[ -z "$MISSING" ]] && ! exists 2020-08-24-040000; then
  pass "B2. normal rotation resumes: 7 daily complete kept, oldest (2020-08-24) dropped"
else
  fail "B2. missing:${MISSING:- none}; 2020-08-24 still present: $(exists 2020-08-24-040000 && echo yes || echo no)"
fi

LEFT_FAILED=$(failed_dirs | wc -l | tr -d ' ')
[[ "$LEFT_FAILED" == "0" ]] && pass "B3. superseded dump-less dirs removed" \
  || fail "B3. expected 0 dump-less dirs, got $LEFT_FAILED: $(failed_dirs | tr '\n' ' ')"

summary
