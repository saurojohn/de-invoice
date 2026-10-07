#!/bin/bash
# Tier 566 — a receipt that cannot be read is a 400, not the end of the server
#
# With the real OCR engine (production's default since Tier 557) a job that
# tesseract rejects made tesseract.js `throw` inside the worker thread's
# message handler: an uncaught exception, and the backend process exited.
# Measured: one upload of a file that is not an image — sent by any user who
# may scan a receipt — and the API was gone for every company until something
# restarted it. Damaged PDFs answered 500.
# Now: the worker has an errorHandler, a file is checked for being a PDF or
# an image before it gets there, and what cannot be read answers 400.
#
# The specs run with the mock engine, so this one restarts the backend with
# OCR_ENGINE=tesseract (as e2e/191 does for the auth mode) and puts it back.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login

restart_backend() { # extra env assignments
  local extra="$1" i DEEP
  kill_backend
  sleep 1
  cd "$SCRIPT_DIR/.."
  # shellcheck disable=SC2086
  nohup env VIES_MOCK=1 THROTTLE_DISABLED=1 $extra bash scripts/start-backend.sh >> /tmp/backend.log 2>&1 &
  for i in $(seq 1 60); do
    sleep 1
    DEEP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 1 "$API/api/v1/health/deep" 2>/dev/null)
    [ "$DEEP" = "200" ] && return 0
  done
  return 1
}
RESTORED=0
restore() {
  [[ "$RESTORED" == "1" ]] && return
  RESTORED=1
  restart_backend "" && note "backend restored to the mock engine" || echo "FATAL: could not restart the backend after the OCR test" >&2
}
trap restore EXIT

D=$(mktemp -d)
printf 'this is not an image at all, just text\n%.0s' 1 2 3 4 5 > "$D/text.png"
python3 - "$D" <<'PY'
import os, sys, base64
d = sys.argv[1]
open(d + '/garbage.pdf', 'wb').write(b'%PDF-1.4\n' + os.urandom(3000))
open(d + '/header-only.pdf', 'wb').write(b'%PDF-1.7\n')
open(d + '/fake.png', 'wb').write(b'\x89PNG\r\n\x1a\n' + os.urandom(600))
open(d + '/real.png', 'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='))
PY
scan() { curl -s -o "$D/out" -w '%{http_code}' -m 120 -X POST "$API/api/v1/ocr/scan?companyId=$COMPANY_ID" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" -F "file=@$1;type=$2"; }
alive() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$API/api/v1/health"; }

if ! restart_backend "OCR_ENGINE=tesseract"; then fail "backend did not come up with OCR_ENGINE=tesseract"; summary; exit 1; fi
pass "backend restarted with the real OCR engine"

note "=== files that are no receipt ==="
assert_eq "text sent as image/png: 400 (was: the process exited)" "$(scan "$D/text.png" image/png)" "400"
assert_eq "…it says what is expected" "$(grep -c 'weder ein PDF noch ein Bild' "$D/out")" "1"
assert_eq "…and the server is still there" "$(alive)" "200"
assert_eq "a PDF header followed by noise: 400 (was 500)" "$(scan "$D/garbage.pdf" application/pdf)" "400"
assert_eq "a PDF that is only its header: 400 (was 500)" "$(scan "$D/header-only.pdf" application/pdf)" "400"
assert_eq "…still there" "$(alive)" "200"

note "=== a file tesseract itself rejects ==="
# PNG magic, noise behind it: this one reaches the worker. Whether the worker
# can start here (it fetches its language data on first use) or not — the
# answer is a 400 and the process lives.
assert_eq "a damaged PNG: 400" "$(scan "$D/fake.png" image/png)" "400"
assert_eq "…the server is still there (was: exit 1)" "$(alive)" "200"
ST=$(scan "$D/real.png" image/png)
[[ "$ST" == "201" || "$ST" == "400" ]] && pass "a real image afterwards is answered, not hung or 5xx = $ST" || fail "a real image afterwards: $ST $(head -c 120 "$D/out")"
assert_eq "…and the server is still there" "$(alive)" "200"
grep -q "errorHandler" "$SCRIPT_DIR/../src/modules/ocr/tesseract-ocr.service.ts" && pass "the worker is created with an errorHandler" || fail "createWorker has no errorHandler"

note "=== and the suite gets its backend back ==="
restore
assert_eq "the mock engine answers again" "$(scan "$D/real.png" image/png)" "201"
rm -rf "$D"
summary; exit $?
