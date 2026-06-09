#!/bin/bash
# Test 06: dayBalance math — Anfangsbestand is correctly attributed
# to the day it belongs to, and the running balance chains
# across days.
# This test would have caught the original dayBalance bug
# where the Anfangsbestand was excluded from `anfang` because
# the "prior days" query used `lt: dayStart` (strictly less than
# the eroeffnung row's date).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: dayBalance chains correctly across days ==="

# 6/1: eroeffnung 500 + einnahme 100 + ausgabe 50 = endbestand 550
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"eroeffnung\",
  \"description\":\"Anfangsbestand\",\"amount\":500
}" >/dev/null
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"einnahme\",
  \"description\":\"Verkauf 1\",\"amount\":100
}" >/dev/null
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-01\",\"type\":\"ausgabe\",
  \"description\":\"Porto\",\"amount\":50
}" >/dev/null

api_get "/api/v1/cashbook/day?companyId=$COMPANY_ID&date=2026-06-01"
ANFANG=$(json_field "$BODY" anfang)
EIN=$(json_field "$BODY" einnahmen)
AUS=$(json_field "$BODY" ausgaben)
ENDE=$(json_field "$BODY" ende)
assert_eq "6/1 anfang (Anfangsbestand)" "$ANFANG" "500"
assert_eq "6/1 einnahmen" "$EIN" "100"
assert_eq "6/1 ausgaben" "$AUS" "50"
assert_eq "6/1 ende" "$ENDE" "550"

# 6/2: 1 einnahme 200, no other entries
api_post "/api/v1/cashbook/entries?companyId=$COMPANY_ID" "{
  \"createdById\":\"$USER_ID\",\"businessDate\":\"2026-06-02\",\"type\":\"einnahme\",
  \"description\":\"Verkauf 2\",\"amount\":200
}" >/dev/null

api_get "/api/v1/cashbook/day?companyId=$COMPANY_ID&date=2026-06-02"
ANFANG2=$(json_field "$BODY" anfang)
EIN2=$(json_field "$BODY" einnahmen)
ENDE2=$(json_field "$BODY" ende)
assert_eq "6/2 anfang (chains from 6/1 ende)" "$ANFANG2" "550"
assert_eq "6/2 einnahmen" "$EIN2" "200"
assert_eq "6/2 ende" "$ENDE2" "750"

# 6/3: no entries
api_get "/api/v1/cashbook/day?companyId=$COMPANY_ID&date=2026-06-03"
ANFANG3=$(json_field "$BODY" anfang)
EIN3=$(json_field "$BODY" einnahmen)
ENDE3=$(json_field "$BODY" ende)
assert_eq "6/3 anfang (carries forward)" "$ANFANG3" "750"
assert_eq "6/3 einnahmen (no entries)" "$EIN3" "0"
assert_eq "6/3 ende" "$ENDE3" "750"

# Month summary — 6/1+6/2 should give einnahmen 300, ausgaben 50
api_get "/api/v1/cashbook/month?companyId=$COMPANY_ID&year=2026&month=6"
MS_EIN=$(json_field "$BODY" einnahmen)
MS_AUS=$(json_field "$BODY" ausgaben)
assert_eq "month einnahmen" "$MS_EIN" "300"
assert_eq "month ausgaben" "$MS_AUS" "50"

# Storno on 6/1 — endbestand recomputes correctly
EID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"CashBookEntry\" WHERE \"companyId\" = '$COMPANY_ID' AND type = 'ausgabe' AND amount = 50 LIMIT 1;" 2>/dev/null | tr -d ' ')
api_post "/api/v1/cashbook/entries/$EID/reverse?companyId=$COMPANY_ID" \
  "{\"reason\":\"Storno Test\",\"createdById\":\"$USER_ID\"}" >/dev/null

api_get "/api/v1/cashbook/day?companyId=$COMPANY_ID&date=2026-06-01"
ENDE_AFTER=$(json_field "$BODY" ende)
# Originally ende=550, storno of 50€ ausgabe means balance should now be 600
assert_eq "6/1 ende after Storno (550 + 50)" "$ENDE_AFTER" "600"

# And 6/2 anfang chains from 6/1's new ende
api_get "/api/v1/cashbook/day?companyId=$COMPANY_ID&date=2026-06-02"
ANFANG2_AFTER=$(json_field "$BODY" anfang)
assert_eq "6/2 anfang after 6/1 Storno (chains)" "$ANFANG2_AFTER" "600"

cleanup_cashbook
summary
