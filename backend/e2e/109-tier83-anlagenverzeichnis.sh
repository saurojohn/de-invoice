#!/usr/bin/env bash
# e2e 109: Tier 83 — Anlagenverzeichnis (Asset Register) + AfA.
#
# Validates the new /api/v1/assets + dispose
# endpoints + the integration into the Bilanz
# (§ 266 HGB Anlagevermögen 0100-0400) and the
# G+V (§ 275 HGB Abschreibungen 7a).
#
# Tests:
#   1. Empty list returns 200.
#   2. Create Maschine (2024-01-01, AK 12000,
#      60 months, restwert 0) → 200, list shows
#      it.
#   3. AfA computation:
#      - monthlyAfA = 12000/60 = 200
#      - buchwert at 2026-12-31 = 12000 -
#        36*200 = 4800
#      - annualAfA for 2026 = 12*200 = 2400
#   4. Bilanz 0400 (Fahrzeug → 0400 in v1) shows
#      4800 if we create a Fahrzeug instead.
#   5. G+V 7a (Abschreibungen) shows 2400 for
#      2026.
#   6. Create 2 assets (Maschine + Fahrzeug) →
#      Bilanz 0300 (Maschine) + 0400 (Fahrzeug)
#      both populated; subtotal = sum.
#   7. Dispose → asset no longer in pool.
#   8. Validation: type, AK, ND enforced.
#   9. Cross-tenant → 401.
#  10. Missing companyId → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="assets-tier83-$TS"
echo "=== Test: Anlagenverzeichnis + AfA (test tag: $TEST_TAG) ==="

# Pre-cleanup. Use psql -c with semicolons
# (heredoc with `<<SQL` silently doesn't pipe
# to psql when called via `docker exec` without
# `-i` — see the de-invoice-patterns memory
# entry "docker exec psql heredoc silently
# fails on macOS").
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE \"bezeichnung\" LIKE 'AVZ-%' OR \"notiz\" LIKE 'AVZ-%';" >/dev/null 2>&1

cleanup() {
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE \"bezeichnung\" LIKE 'AVZ-${TS}-%' OR \"notiz\" LIKE 'AVZ-${TS}-%';" >/dev/null 2>&1
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "DELETE FROM \"Asset\" WHERE \"bezeichnung\" LIKE 'AVZ-%' OR \"notiz\" LIKE 'AVZ-%';" >/dev/null 2>&1
  echo "  cleanup: removed AVZ-${TS}-* (and any leaked AVZ-*) assets"
}
trap cleanup EXIT

# ── 1. Empty list ──
echo
note "=== 1. /assets list (may not be empty — pre-cleanup only catches this run) ==="
LIST=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/assets?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$LIST" | tail -1)
assert_eq "list 200" "$STATUS" "200"

# ── 2. Create a Maschine ──
echo
note "=== 2. Create Maschine (2024-01-01, AK 12000, 60 months) ==="
CREATE=$(curl -sS -X POST "$API/api/v1/assets?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\":\"Maschine\",
    \"bezeichnung\":\"AVZ-${TS}-MASCHINE-1\",
    \"anschaffungsDatum\":\"2024-01-01T00:00:00Z\",
    \"anschaffungsKosten\":12000,
    \"nutzungsdauerMonate\":60,
    \"restwert\":0,
    \"notiz\":\"AVZ-${TS}\"
  }")
ASSET_ID=$(echo "$CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
TYPE=$(echo "$CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['type'])")
KONTO=$(echo "$CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin)['bilanzKonto'])")
assert_eq "type=Maschine" "$TYPE" "Maschine"
assert_eq "auto-mapped to bilanzKonto 0300" "$KONTO" "0300"

# ── 3. G+V 7a = 2400 (12 * 200) ──
echo
note "=== 3. G+V 7a (Abschreibungen) for 2026 = 2400 (12 * 200) ==="
GUV=$(curl -sS "$API/api/v1/accounting/guv?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
AFA_7A=$(echo "$GUV" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['cost']['lines']:
  if l['position'] == '7a':
    print(l['amount'] or 0)
    break
")
AFA_7A_DELTA=$(python3 -c "print(round(float('$AFA_7A') - 2400))")
# In a fresh DB, the baseline 7a is 0. With our 1 asset contributing 2400,
# the absolute value should be exactly 2400 (assuming the test runs in a
# clean DB state — the pre-cleanup only catches our test fixtures, not
# pre-existing assets from prior tier runs).
assert_eq "7a for 2026 = 2400" "$AFA_7A" "2400"

# ── 4. Bilanz 0300 = 4800 (Buchwert at 2026-12-31) ──
echo
note "=== 4. Bilanz 0300 (Maschine) for 2026 = 4800 (AK 12000 - 36 months AfA) ==="
BILANZ=$(curl -sS "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BV_0300=$(echo "$BILANZ" | python3 -c "
import json,sys
d = json.load(sys.stdin)
av = d['aktiva'][0]
for l in av['lines']:
  if l['position'] == '0300':
    print(l['amount'] or 0)
    break
")
assert_eq "Bilanz 0300 = 4800" "$BV_0300" "4800"

# ── 5. Add a Fahrzeug — 0400 ──
echo
note "=== 5. Create Fahrzeug (2024-01-01, AK 6000, 60 months) — Bilanz 0400 = 2400 ==="
curl -sS -X POST "$API/api/v1/assets?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\":\"Fahrzeug\",
    \"bezeichnung\":\"AVZ-${TS}-FAHRZEUG-1\",
    \"anschaffungsDatum\":\"2024-01-01T00:00:00Z\",
    \"anschaffungsKosten\":6000,
    \"nutzungsdauerMonate\":60,
    \"restwert\":0,
    \"notiz\":\"AVZ-${TS}\"
  }" >/dev/null

BILANZ2=$(curl -sS "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BV_0400=$(echo "$BILANZ2" | python3 -c "
import json,sys
d = json.load(sys.stdin)
av = d['aktiva'][0]
for l in av['lines']:
  if l['position'] == '0400':
    print(l['amount'] or 0)
    break
")
# 6000 - 36*100 = 6000 - 3600 = 2400
assert_eq "Bilanz 0400 (Fahrzeug) = 2400" "$BV_0400" "2400"

# 7a should now be 2400 + 1200 = 3600
GUV2=$(curl -sS "$API/api/v1/accounting/guv?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
AFA_7A_2=$(echo "$GUV2" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['cost']['lines']:
  if l['position'] == '7a':
    print(l['amount'] or 0)
    break
")
assert_eq "7a with 2 assets = 3600" "$AFA_7A_2" "3600"

# ── 6. Anlagevermögen subtotal = 4800 + 2400 = 7200 ──
echo
note "=== 6. Anlagevermögen subtotal = 7200 (4800 + 2400) ==="
SUBTOTAL=$(echo "$BILANZ2" | python3 -c "
import json,sys
d = json.load(sys.stdin)
av = d['aktiva'][0]
print(av['subtotal'])
")
assert_eq "Anlagevermögen subtotal = 7200" "$SUBTOTAL" "7200"

# ── 7. Dispose the Maschine ──
echo
note "=== 7. Dispose Maschine on 2027-01-01 — drops from 2027+ bilanz ==="
# Dispose AFTER the 2026 year-end snapshot so the
# Maschine is still in the 2026 pool (4800) but
# excluded from 2027 onwards.
curl -sS -X POST "$API/api/v1/assets/${ASSET_ID}/dispose?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"verkauftAm\":\"2027-01-01T00:00:00Z\",
    \"verkaufsPreis\":4000
  }" >/dev/null

# After disposal on Dec 31, the asset is still in
# the pool for the snapshot (Buchwert = 4800
# for 2026 Bilanz). For 2027+, the asset is out.
BILANZ_2026=$(curl -sS "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BV_0300_2026=$(echo "$BILANZ_2026" | python3 -c "
import json,sys
d = json.load(sys.stdin)
av = d['aktiva'][0]
for l in av['lines']:
  if l['position'] == '0300':
    print(l['amount'] or 0)
    break
")
# Maschine disposed on 2027-01-01 (AFTER 2026
# snapshot) → still counted in 2026 Bilanz
# (snapshot is 2026-12-31 23:59:59.999, dispose
# is 2027-01-01 → dispose > snapshot → asset
# is in 2026 pool). So 0300 should still be 4800
# for 2026.
assert_eq "0300 still 4800 for 2026 (disposal after snapshot)" "$BV_0300_2026" "4800"

# For 2027, the Maschine is out → 0300 = 0
BILANZ_2027=$(curl -sS "$API/api/v1/accounting/bilanz?companyId=$COMPANY_ID&year=2027" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
BV_0300_2027=$(echo "$BILANZ_2027" | python3 -c "
import json,sys
d = json.load(sys.stdin)
av = d['aktiva'][0]
for l in av['lines']:
  if l['position'] == '0300':
    print(l['amount'] or 0)
    break
")
assert_eq "0300 for 2027 = 0 (Maschine disposed)" "$BV_0300_2027" "0"

# 7a for 2027 = 1200 (Fahrzeug) + 200 (Maschine Jan 2027
# auto-AfA booked before disposal) = 1400. Disposal on
# 2027-01-01 still allows Jan AfA to be booked.
GUV_2027=$(curl -sS "$API/api/v1/accounting/guv?companyId=$COMPANY_ID&year=2027" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
AFA_7A_2027=$(echo "$GUV_2027" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['cost']['lines']:
  if l['position'] == '7a':
    print(l['amount'] or 0)
    break
")
assert_eq "7a for 2027 = 1400 (1200 Fahrzeug + 200 Maschine Jan)" "$AFA_7A_2027" "1400"

# ── 8. Validation ──
echo
note "=== 8. validation: invalid type → 400 ==="
ST_BAD_TYPE=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\":\"Nonsense\",
    \"bezeichnung\":\"AVZ-${TS}-BAD\",
    \"anschaffungsDatum\":\"2024-01-01T00:00:00Z\",
    \"anschaffungsKosten\":100,
    \"nutzungsdauerMonate\":12
  }")
assert_eq "invalid type → 400" "$ST_BAD_TYPE" "400"

ST_NEG_AK=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\":\"Maschine\",
    \"bezeichnung\":\"AVZ-${TS}-NEG\",
    \"anschaffungsDatum\":\"2024-01-01T00:00:00Z\",
    \"anschaffungsKosten\":-100,
    \"nutzungsdauerMonate\":12
  }")
assert_eq "AK <= 0 → 400" "$ST_NEG_AK" "400"

ST_NEG_ND=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  "$API/api/v1/assets?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\":\"Maschine\",
    \"bezeichnung\":\"AVZ-${TS}-ND0\",
    \"anschaffungsDatum\":\"2024-01-01T00:00:00Z\",
    \"anschaffungsKosten\":100,
    \"nutzungsdauerMonate\":0
  }")
assert_eq "ND <= 0 → 400" "$ST_NEG_ND" "400"

# ── 9. Cross-tenant → 401 ──
echo
note "=== 9. cross-tenant → 401 ==="
ST_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/assets?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST_CROSS" "401"

# ── 10. Missing companyId → 400 ──
echo
note "=== 10. missing companyId → 400 ==="
ST_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/assets" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$ST_NO_CID" "400"

summary
exit $?
