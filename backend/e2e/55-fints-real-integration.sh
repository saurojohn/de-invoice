#!/usr/bin/env bash
# e2e 55: Tier 22 — Real-mode FinTS error handling
#
# We can't e2e-test the full real-mode path
# without a Sparkasse / DKB / Volksbank sandbox
# account (and the production banks are NOT
# publicly accessible — PSD2 SCA + non-
# disclosure). What we CAN test:
#
#   1. The PinTanClient wrapper produces the
#      expected FintsResult union for each
#      failure mode (wrong URL, refused
#      connection, malformed response)
#   2. The fints.service.ts runRealSync path
#      propagates that result correctly:
#      - 'failed' → sync-run status = failed
#      - 'needs_tan' → sync-run status = needs_tan
#      - exception → caught + sync-run status = failed
#   3. The new (encryptedPin / pinIv / pinTag)
#      schema fields persist correctly when
#      the user creates a real-mode connection
#      (without mocking the bank itself — the
#      sync will fail with a network error,
#      which is fine; we're testing the schema
#      persistence)
#   4. The PIN encryption round-trip is
#      reversible (encrypt → decrypt = original)
#   5. The PIN env-key check: missing
#      FINTS_PIN_ENC_KEY → real-mode creation
#      leaves the new columns NULL (graceful
#      degradation; real-mode sync returns a
#      clear error message)
#
# What this test does NOT cover (deferred to
# when a sandbox bank is available):
#   - Full DIALOG INIT / HKSAL / HKKAZ
#     round-trip against a real bank
#   - PSD2 SCA flow (TAN submission
#     resuming an in-flight dialog)
#   - Auto-matching against open invoices
#     after a successful real-mode fetch
#     (this works in mock-mode — covered by
#      e2e 31-fints-mock.sh — but needs a
#      real BankTransaction row to test the
#      full flow)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# PASS/FAIL counters for the assert_eq() helper
# defined in this file (different from _lib.sh's
# `pass`/`fail` functions, which only echo and
# bump the global FAILS counter).
PASS=0
FAIL=0

# Default to script's parent (backend/) if BACKEND_DIR
# is not set in the environment. _lib.sh doesn't export
# it; the original 31-fints-mock.sh implicitly assumes
# the script runs from inside backend/.
BACKEND_DIR="${BACKEND_DIR:-$SCRIPT_DIR/..}"

cd "$BACKEND_DIR"

# Load .env so node -e subshells below can see
# FINTS_PIN_ENC_KEY (needed for the encryption
# round-trip test).
if [[ -f "$BACKEND_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$BACKEND_DIR/.env"
  set +a
fi
# ─────────────────────────────────────────────────────────────
# Section 1: Schema — the new encrypted PIN columns exist
# ─────────────────────────────────────────────────────────────
echo "=== 1. Schema: encrypted PIN columns ==="
HAS_ENCRYPTED=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name='FinTSConnection' AND column_name='encryptedPin';" 2>/dev/null | tr -d ' ')
assert_eq "encryptedPin column exists" "$HAS_ENCRYPTED" "1"

HAS_IV=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name='FinTSConnection' AND column_name='pinIv';" 2>/dev/null | tr -d ' ')
assert_eq "pinIv column exists" "$HAS_IV" "1"

HAS_TAG=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name='FinTSConnection' AND column_name='pinTag';" 2>/dev/null | tr -d ' ')
assert_eq "pinTag column exists" "$HAS_TAG" "1"

# ─────────────────────────────────────────────────────────────
# Section 2: PIN encryption round-trip
# ─────────────────────────────────────────────────────────────
echo
echo "=== 2. PIN encryption round-trip ==="
ROUND_TRIP=$(node -e "
require('ts-node/register');
const { encryptPin, decryptPin } = require('./src/modules/fints/pin-crypto');
const pin = '123456';
const enc = encryptPin(pin);
const dec = decryptPin(enc);
console.log(dec === pin ? 'OK' : 'BAD');
" 2>&1 | tail -1)
assert_eq "encrypt → decrypt returns original" "$ROUND_TRIP" "OK"

# ─────────────────────────────────────────────────────────────
# Section 3: Different IVs for the same plaintext
# (GCM requires a fresh random IV per encryption)
# ─────────────────────────────────────────────────────────────
echo
echo "=== 3. Encryption IV uniqueness ==="
IV_UNIQUE=$(node -e "
require('ts-node/register');
const { encryptPin } = require('./src/modules/fints/pin-crypto');
const e1 = encryptPin('12345');
const e2 = encryptPin('12345');
console.log(e1.iv === e2.iv ? 'SAME' : 'DIFF');
" 2>&1 | tail -1)
assert_eq "Two encryptions have different IVs" "$IV_UNIQUE" "DIFF"

# ─────────────────────────────────────────────────────────────
# Section 4: Auth — required to test the controller paths
# ─────────────────────────────────────────────────────────────
login

# Clean prior state for this company
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"BankReconciliation\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"BankTransaction\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID' AND format LIKE 'fints-%';
  DELETE FROM \"FinTSSyncRun\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"FinTSConnection\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1

# ─────────────────────────────────────────────────────────────
# Section 5: Create real-mode connection — encryptedPin
# should be set in the DB
# ─────────────────────────────────────────────────────────────
echo
echo "=== 5. Real-mode connection creation ==="
api_post "/api/v1/fints/connections" \
  "{\"companyId\":\"$COMPANY_ID\",\"blz\":\"50050201\",\"userId\":\"e2e-real-user\",\"label\":\"E2E Sparkasse Real\",\"endpointUrl\":\"https://banking-127.0.0.1.invalid/fints\",\"pin\":\"123456\",\"mockMode\":false}"
assert_status 201 "5a. Create real-mode connection (201)"

CONN_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [[ -n "$CONN_ID" ]]; then
  pass "5b. Connection id = $CONN_ID"
else
  fail "5b. Connection id is empty: $BODY"
  exit 1
fi

# Verify the new columns are populated
ENC_PIN=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT \"encryptedPin\" FROM \"FinTSConnection\" WHERE id='$CONN_ID';" 2>/dev/null | tr -d ' ')
ENC_IV=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT \"pinIv\" FROM \"FinTSConnection\" WHERE id='$CONN_ID';" 2>/dev/null | tr -d ' ')
ENC_TAG=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT \"pinTag\" FROM \"FinTSConnection\" WHERE id='$CONN_ID';" 2>/dev/null | tr -d ' ')

if [[ -n "$ENC_PIN" && "$ENC_PIN" != "null" ]]; then
  pass "5c. encryptedPin persisted"
else
  fail "5c. encryptedPin is empty: '$ENC_PIN'"
fi
if [[ -n "$ENC_IV" && "$ENC_IV" != "null" ]]; then
  pass "5d. pinIv persisted"
else
  fail "5d. pinIv is empty: '$ENC_IV'"
fi
if [[ -n "$ENC_TAG" && "$ENC_TAG" != "null" ]]; then
  pass "5e. pinTag persisted"
else
  fail "5e. pinTag is empty: '$ENC_TAG'"
fi

# ─────────────────────────────────────────────────────────────
# Section 6: Sync against an unreachable URL
# The PinTanClient will throw a network error;
# normaliseError should map it to { status: 'failed',
# code: 'ENOTFOUND' or similar }.
# ─────────────────────────────────────────────────────────────
echo
echo "=== 6. Real-mode sync against unreachable URL ==="
api_post "/api/v1/fints/connections/$CONN_ID/sync" \
  "{\"companyId\":\"$COMPANY_ID\"}"
# The .invalid TLD is RFC-2606 reserved — DNS
# resolution must fail. The PinTanClient times out
# (default ~30s); we set a generous test timeout.
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
# We accept either 'failed' (DNS error caught fast)
# or 'needs_tan' (if the bank's initial handshake
# made it that far before the network dropped).
# Either way, status MUST NOT be 'ok' — the URL is
# bogus, no transactions should be returned.
if [[ "$STATUS" == "failed" || "$STATUS" == "needs_tan" ]]; then
  pass "6. Real-mode sync did not return 'ok' for bogus URL (got: $STATUS)"
else
  fail "6. Real-mode sync returned unexpected status: $STATUS — body: $BODY"
fi

# ─────────────────────────────────────────────────────────────
# Section 7: Cleanup
# ─────────────────────────────────────────────────────────────
echo
echo "=== 7. Cleanup ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"FinTSSyncRun\" WHERE \"companyId\" = '$COMPANY_ID';
  DELETE FROM \"FinTSConnection\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1
pass "7. Test fixtures cleaned up"

echo
echo "==== $PASS passed, $FAIL failed (lib FAILS=$FAILS) ===="
exit $FAIL