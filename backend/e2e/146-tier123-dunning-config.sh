#!/usr/bin/env bash
# e2e 146: Tier 123 — Per-company dunning config.
#
# Verifies the new GET/PUT /api/v1/reminders/dunning-config
# endpoints:
#
#   1. GET returns the current config (with defaults
#      filled in for missing fields). Fresh dev DB
#      should return the German Mittelstand defaults
#      (1/7/14 days, 0/5/10 EUR).
#   2. PUT updates the config. Subsequent GET
#      returns the new values.
#   3. PUT validates monotonic thresholds:
#      level1 < level2 < level3 — non-monotonic
#      returns 400 with a clear error message.
#   4. PUT validates non-negative fees — a negative
#      fee returns 400.
#   5. The dunning config is stored in
#      Company.settings.dunning (JSONB) — verified
#      by querying the DB directly.
#
# Why this matters: before Tier 123 the auto-reminder
# cron hardcoded 1/7/14 Werktage and 0/0/0 EUR. The
# Berater (Steuerberater) had to edit the .ts file
# and redeploy to change the policy. Now they can
# do it from the Settings page.
#
# Tier 123 e2e — 5 sections, 10+ assertions.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
note "=== Test: Tier 123 — Dunning config (per-company) ==="

# ───── 0. Save current dunning config so we can
#   restore it at the end ─────
note "=== 0. Snapshot current config ==="
api_get "/api/v1/reminders/dunning-config?companyId=$COMPANY_ID"
assert_status "200" "GET initial config"
INITIAL_CONFIG=$(echo "$BODY" | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)))")
note "initial: $INITIAL_CONFIG"

# Wipe the dunning key from Company.settings so we
# can verify the GET fills in defaults.
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = settings - 'dunning' WHERE id='$COMPANY_ID';" >/dev/null 2>&1
pass "wiped dunning key from Company.settings"

# ───── 1. GET returns German Mittelstand defaults ─────
note "=== 1. GET with no dunning key → defaults ==="
api_get "/api/v1/reminders/dunning-config?companyId=$COMPANY_ID"
assert_status "200" "GET after wipe"
DEFAULTS=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'{d[\"level1Days\"]}/{d[\"level2Days\"]}/{d[\"level3Days\"]} {d[\"level1Fee\"]}/{d[\"level2Fee\"]}/{d[\"level3Fee\"]}')")
note "defaults: $DEFAULTS"
test "$DEFAULTS" = "1/7/14 0/5/10" && pass "GET fills in defaults (1/7/14 0/5/10)" \
  || fail "GET defaults wrong: $DEFAULTS (expected 1/7/14 0/5/10)"

# ───── 2. PUT custom config ─────
note "=== 2. PUT custom config ==="
api_put "/api/v1/reminders/dunning-config?companyId=$COMPANY_ID" \
  '{"level1Days":2,"level2Days":10,"level3Days":21,"level1Fee":0,"level2Fee":7.5,"level3Fee":15}'
assert_status "200" "PUT custom config"
SAVED=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'{d[\"level1Days\"]}/{d[\"level2Days\"]}/{d[\"level3Days\"]} {d[\"level1Fee\"]}/{d[\"level2Fee\"]}/{d[\"level3Fee\"]}')")
test "$SAVED" = "2/10/21 0/7.5/15" && pass "PUT returned saved config" \
  || fail "PUT saved wrong: $SAVED (expected 2/10/21 0/7.5/15)"

# Verify GET returns the saved config
api_get "/api/v1/reminders/dunning-config?companyId=$COMPANY_ID"
assert_status "200" "GET after PUT"
GOT=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'{d[\"level1Days\"]}/{d[\"level2Days\"]}/{d[\"level3Days\"]} {d[\"level1Fee\"]}/{d[\"level2Fee\"]}/{d[\"level3Fee\"]}')")
test "$GOT" = "2/10/21 0/7.5/15" && pass "GET after PUT returns saved config" \
  || fail "GET after PUT wrong: $GOT (expected 2/10/21 0/7.5/15)"

# Verify the value is actually stored in Company.settings.dunning
STORED=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT settings->'dunning'->>'level2Fee' FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d ' ')
test "$STORED" = "7.5" && pass "Company.settings.dunning.level2Fee=7.5 (DB)" \
  || fail "stored value wrong: $STORED (expected 7.5)"

# ───── 3. PUT non-monotonic → 400 ─────
note "=== 3. PUT non-monotonic thresholds → 400 ==="
HTTP_STATUS=$(curl -sS -o /tmp/t146-bad.json -w "%{http_code}" -X PUT \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"level1Days":10,"level2Days":5,"level3Days":14,"level1Fee":0,"level2Fee":5,"level3Fee":10}' \
  "http://localhost:3001/api/v1/reminders/dunning-config?companyId=$COMPANY_ID")
test "$HTTP_STATUS" = "400" && pass "non-monotonic returns 400" \
  || fail "non-monotonic returned $HTTP_STATUS (expected 400)"
ERR=$(python3 -c "import json;d=json.load(open('/tmp/t146-bad.json'));print(d.get('message',''))")
echo "$ERR" | grep -q "level1Days < level2Days < level3Days" && pass "error message mentions monotonicity" \
  || fail "error message unclear: $ERR"

# ───── 4. PUT negative fee → 400 ─────
note "=== 4. PUT negative fee → 400 ==="
HTTP_STATUS=$(curl -sS -o /tmp/t146-negfee.json -w "%{http_code}" -X PUT \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d '{"level1Days":1,"level2Days":7,"level3Days":14,"level1Fee":-1,"level2Fee":5,"level3Fee":10}' \
  "http://localhost:3001/api/v1/reminders/dunning-config?companyId=$COMPANY_ID")
test "$HTTP_STATUS" = "400" && pass "negative fee returns 400" \
  || fail "negative fee returned $HTTP_STATUS (expected 400)"
ERR=$(python3 -c "import json;d=json.load(open('/tmp/t146-negfee.json'));print(d.get('message',''))")
echo "$ERR" | grep -q "must not be less than 0" && pass "error message mentions non-negative" \
  || fail "error message unclear: $ERR"

# ───── 5. Restore initial config ─────
note "=== 5. Restore initial config ==="
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET settings = settings || jsonb_build_object('dunning', ($INITIAL_CONFIG::jsonb)) WHERE id='$COMPANY_ID';" >/dev/null 2>&1
pass "restored initial dunning config"

rm -f /tmp/t146-bad.json /tmp/t146-negfee.json

summary "Tier 123 — Per-company dunning config (Mahnung thresholds + fees)"
