#!/bin/bash
# Tier 756 — the receipt scanner needs no CDN, and the production build is
# tested every week
#
# The production image was started for the first time with everything the
# compose file gives it, behind its proxy. Everything held but the scanner:
# tesseract.js fetched its language data from a CDN at the first scan after
# every start (the read-only root filesystem keeps no copy), and when that
# failed createWorker's promise never settled. Measured: the CDN blocked, 504
# from the proxy after 60 s, for this scan and every later one, until a restart.
# Now the data is in assets/ocr, and a failed start answers 503 at once. The
# image itself is checked in docker-build.yml (scripts/ci-ocr-check.js): the CDN
# blocked 201, the data removed 503.
#
# `RECHNUNG` was proposed as the supplier's BIC: an eight-letter word, its
# letters 5 and 6 even a country code. A BIC now counts only after its label.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
ROOT="$SCRIPT_DIR/../.."
SVC="$ROOT/backend/src/modules/ocr/tesseract-ocr.service.ts"
CI="$ROOT/.github/workflows/ci.yml"
IMG="$ROOT/.github/workflows/docker-build.yml"

note "=== the language data travels with the program ==="
F="$ROOT/backend/assets/ocr/deu.traineddata"
assert_eq "the file is what assets/README.md names" "$(shasum -a 256 "$F" | cut -d' ' -f1)" "a1b72cc25753eac167edfef5af4448a8dc34973503a2265c34c84520f896eb03"
git -C "$ROOT" check-ignore -q backend/assets/ocr/deu.traineddata && fail "git ignores it: a clone has no language data" || pass "git keeps it"
assert_eq "its licence lies beside it" "$(head -1 "$ROOT/backend/assets/ocr/LICENSE-Apache-2.0.txt" | grep -c 'Apache License')" "1"
assert_eq "the worker reads it from there" "$(grep -c 'langPath: OCR_DATA_DIR' "$SVC")" "1"
assert_eq "…and fetches nothing, keeps no copy of its own" "$(grep -c "cacheMethod: 'none'" "$SVC")" "1"
assert_eq "the image gets assets/ whole" "$(grep -c 'COPY --from=dev --chown=app:app /app/assets ./assets' "$ROOT/backend/Dockerfile")" "1"

note "=== a start that fails ends the wait ==="
assert_eq "the handler rejects the start" "$(grep -c 'reject(new ServiceUnavailableException' "$SVC")" "1"
assert_eq "the image is checked with the CDN blocked" "$(grep -c 'add-host cdn.jsdelivr.net:127.0.0.1' "$IMG")" "1"
assert_eq "…and without the data" "$(grep -c 'tmpfs /app/assets/ocr' "$IMG")" "1"
assert_eq "…in both answers" "$(grep -cE 'ci-ocr-check.js (201|503)' "$IMG")" "2"

note "=== the supplier's BIC ==="
bic() { curl -s -G "$API/api/v1/ocr/extract" --data-urlencode "text=$1" --data-urlencode "companyId=$COMPANY_ID" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" | python3 -c "import json,sys; print(json.load(sys.stdin).get('supplierBic'))"; }
assert_eq "RECHNUNG is no BIC" "$(bic $'RECHNUNG\nIBAN: DE89370400440532013000')" "None"
assert_eq "DEUTSCHE is none" "$(bic $'DEUTSCHE BANK\nBIC: DEUTDEFF')" "DEUTDEFF"
assert_eq "after its label: BIC:" "$(bic $'RECHNUNG\nBIC: COBADEFFXXX')" "COBADEFFXXX"
assert_eq "…BIC without a colon" "$(bic 'Bic COBADEFFXXX')" "COBADEFFXXX"
assert_eq "…SWIFT/BIC:" "$(bic 'SWIFT/BIC: COBADEFF')" "COBADEFF"
assert_eq "…SWIFT-Code" "$(bic 'SWIFT-Code: COBADEFFXXX')" "COBADEFFXXX"

note "=== a spec does not guess its address ==="
REFUSED=$(env -u API -u CI bash "$SCRIPT_DIR/01-eroeffnung-only-once.sh" 2>&1); RC=$?
assert_eq "without API it does not start" "$RC" "2"
assert_eq "…and says why" "$(echo "$REFUSED" | grep -c 'REFUSED: API is not set')" "1"

note "=== the production build, every week ==="
assert_eq "ci.yml runs on a schedule" "$(grep -c "cron: '0 3 \* \* 0'" "$CI")" "1"
assert_eq "…and by hand" "$(grep -c 'production_build:' "$CI")" "1"
assert_eq "a push does not cancel that run" "$(grep -c 'group: ${{ github.workflow }}-${{ github.ref }}-${{ github.event_name }}' "$CI")" "1"
assert_eq "both backends run the compiled program" "$(grep -c 'BACKEND_CMD="node dist/main.js"' "$CI")" "2"
assert_eq "the frontend runs the production server" "$(grep -c 'next build' "$CI")" "1"
assert_eq "what a spec restarts is the compiled program too" "$(grep -c 'exec node dist/main.js' "$ROOT/backend/scripts/start-backend.sh")" "1"
assert_eq "docker-build.yml runs weekly as well" "$(grep -c "cron: '30 3 \* \* 0'" "$IMG")" "1"
summary
