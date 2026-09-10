#!/bin/bash
# Test 30: Tier 5d — ECB exchange rates in DATEV export
#
# Verifies the per-company exchangeRate snapshot
# is read by buildBuchungenFromDb and emitted
# in DATEV column 17 (Kurs) for every non-EUR
# row. The cron @ 02:00 Berlin is not exercised
# here — we seed the rate snapshot directly via
# SQL (the controller's manual refresh just
# forwards to the same service, so unit-testing
# the SQL read path covers the full integration).
#
# Coverage:
#   1. With no snapshot set, a CHF invoice falls
#      back to "1,0000" (the prior default)
#   2. After setting a snapshot, the same invoice
#      shows the configured rate on every line
#      (Zahlungseingang + Erlöse + USt)
#   3. EUR invoices keep the 1,0000 default
#      (the formatter always emits 4dp; EUR
#      doesn't need a real rate but DATEV
#      imports "1,0000" cleanly)
#   4. Currency not in the snapshot also falls
#      back to "1,0000"
#   5. The /api/v1/exchange-rates GET endpoint
#      returns the cached snapshot
#   6. The POST /api/v1/exchange-rates/refresh
#      endpoint fetches a fresh snapshot and
#      persists it (this is a network call —
#      we hit the real ECB API; it usually takes
#      500-1500ms)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 5d ECB exchange rates ==="

# ----- Fixed seed IDs -----
INV_CHF_ID="e2e0e0e0-0001-0000-0007-000000000030"
INV_CHF_NO="E2E-T5D-CHF-01"
INV_EUR_ID="e2e0e0e0-0001-0000-0007-000000000031"
INV_EUR_NO="E2E-T5D-EUR-01"
INV_NOK_ID="e2e0e0e0-0001-0000-0007-000000000032"
INV_NOK_NO="E2E-T5D-NOK-01"
PAY_CHF_ID="e2e0e0e0-0001-0000-0007-000000000033"
PAY_EUR_ID="e2e0e0e0-0001-0000-0007-000000000034"
PAY_NOK_ID="e2e0e0e0-0001-0000-0007-000000000035"

# Clean up any prior run
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE id IN ('$PAY_CHF_ID', '$PAY_EUR_ID', '$PAY_NOK_ID');
  DELETE FROM \"Invoice\" WHERE id IN ('$INV_CHF_ID', '$INV_EUR_ID', '$INV_NOK_ID');
  UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';" >/dev/null 2>&1

# Find a customer
CUST_ID=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT id FROM \"Customer\" WHERE \"companyId\" = '$COMPANY_ID' LIMIT 1;" 2>/dev/null | tr -d ' ')

# Seed: 3 paid invoices in CHF, EUR, NOK
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceNumber\",
    type, status, \"issueDate\", \"dueDate\",
    subtotal, \"totalVat\", total, currency, language, \"vatBreakdown\",
    \"reverseCharge\", \"euTransaction\", notes, \"templateType\", \"pdfPath\", attachments, \"createdAt\", \"updatedAt\")
  VALUES
    ('$INV_CHF_ID', '$COMPANY_ID', '$CUST_ID', '$INV_CHF_NO', 9801, 'INV', 'paid', '2026-05-20', '2026-06-20',
     1000.00, 190.00, 1190.00, 'CHF', 'de-DE', '[{\"rate\":0.19}]'::jsonb, false, false, 'CHF', 'standard', NULL, '[]', now(), now()),
    ('$INV_EUR_ID', '$COMPANY_ID', '$CUST_ID', '$INV_EUR_NO', 9802, 'INV', 'paid', '2026-05-20', '2026-06-20',
     1000.00, 190.00, 1190.00, 'EUR', 'de-DE', '[{\"rate\":0.19}]'::jsonb, false, false, 'EUR', 'standard', NULL, '[]', now(), now()),
    ('$INV_NOK_ID', '$COMPANY_ID', '$CUST_ID', '$INV_NOK_NO', 9803, 'INV', 'paid', '2026-05-20', '2026-06-20',
     1000.00, 250.00, 1250.00, 'NOK', 'de-DE', '[{\"rate\":0.25}]'::jsonb, false, false, 'NOK', 'standard', NULL, '[]', now(), now());

  INSERT INTO \"Payment\" (id, \"invoiceId\", amount, currency, \"paymentDate\", \"paymentMethod\", \"createdAt\")
  VALUES
    ('$PAY_CHF_ID', '$INV_CHF_ID', 1190.00, 'CHF', '2026-05-25', 'bank_transfer', now()),
    ('$PAY_EUR_ID', '$INV_EUR_ID', 1190.00, 'EUR', '2026-05-25', 'bank_transfer', now()),
    ('$PAY_NOK_ID', '$INV_NOK_ID', 1250.00, 'NOK', '2026-05-25', 'bank_transfer', now());
" >/dev/null 2>&1

# ===== 1) Without snapshot: rates default to 1.0000 =====
curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/csv-no-snap.csv

CHF_RATE_NO_SNAP=$(LC_ALL=C grep "E2E-T5D-CHF" /tmp/csv-no-snap.csv | head -1 | python3 -c "
import sys
cols = sys.stdin.read().strip().split(';')
print(cols[16] if len(cols) > 16 else '')
")
# The Kurs column uses German decimal
# (1,0000) — same as test 25's existing
# assertion for the no-snapshot default.
assert_eq "no snapshot: CHF rate defaults to 1,0000" "$CHF_RATE_NO_SNAP" "1,0000"

NOK_RATE_NO_SNAP=$(LC_ALL=C grep "E2E-T5D-NOK" /tmp/csv-no-snap.csv | head -1 | python3 -c "
import sys
cols = sys.stdin.read().strip().split(';')
print(cols[16] if len(cols) > 16 else '')
")
assert_eq "no snapshot: NOK rate defaults to 1,0000" "$NOK_RATE_NO_SNAP" "1,0000"

# ===== 2) Set a snapshot, re-export =====
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\"
  SET settings = jsonb_build_object(
    'datev', jsonb_build_object(
      'exchangeRates', jsonb_build_object(
        'date', '2026-06-19',
        'fetchedAt', '2026-06-19T15:00:00Z',
        'base', 'EUR',
        'rates', jsonb_build_object(
          'CHF', '0.9248',
          'USD', '1.1467',
          'GBP', '0.86653'
        )
      )
    )
  )
  WHERE id = '$COMPANY_ID';" >/dev/null 2>&1

curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/csv-with-snap.csv

# All 3 lines of the CHF invoice (Zahlungseingang +
# Erlöse + USt) should have rate 0,9248 (German
# decimal — see format note above).
ALL_CHF_RATES=$(LC_ALL=C grep "E2E-T5D-CHF" /tmp/csv-with-snap.csv | python3 -c "
import sys
for line in sys.stdin:
    cols = line.strip().split(';')
    if len(cols) > 16:
        print(cols[16])
" | sort -u)
if [[ "$ALL_CHF_RATES" == "0,9248" ]]; then
  pass "snapshot: all 3 CHF lines show 0,9248"
else
  fail "snapshot: CHF rates not consistent: $ALL_CHF_RATES"
fi

# The rate is 4-decimal (per DATEV spec)
PREC=$(LC_ALL=C grep "E2E-T5D-CHF" /tmp/csv-with-snap.csv | head -1 | python3 -c "
import sys
cols = sys.stdin.read().strip().split(';')
r = cols[16] if len(cols) > 16 else ''
# Count decimals after the ,
if ',' in r:
    print(len(r.split(',')[1]))
else:
    print(0)
")
assert_eq "rate has 4 decimals" "$PREC" "4"

# ===== 3) EUR invoices: rate stays 1,0000 (the
# formatter always emits 4dp; EUR doesn't need
# an actual rate but DATEV still imports "1,0000"
# cleanly, so the system keeps it for consistency) =====
EUR_LINE=$(LC_ALL=C grep "E2E-T5D-EUR" /tmp/csv-with-snap.csv | head -1 | python3 -c "
import sys
cols = sys.stdin.read().strip().split(';')
print(repr(cols[15]) if len(cols) > 15 else '')
")
# col 15 (0-indexed) = col 16 in DATEV = Währung. Expect 'EUR'.
assert_eq "EUR line currency col" "$EUR_LINE" "'EUR'"

EUR_KURS=$(LC_ALL=C grep "E2E-T5D-EUR" /tmp/csv-with-snap.csv | head -1 | python3 -c "
import sys
cols = sys.stdin.read().strip().split(';')
print(cols[16] if len(cols) > 16 else 'MISSING')
")
assert_eq "EUR line: Kurs stays 1,0000" "$EUR_KURS" "1,0000"

# ===== 4) Currency not in snapshot: 1,0000 =====
NOK_RATE_WITH_SNAP=$(LC_ALL=C grep "E2E-T5D-NOK" /tmp/csv-with-snap.csv | head -1 | python3 -c "
import sys
cols = sys.stdin.read().strip().split(';')
print(cols[16] if len(cols) > 16 else '')
")
assert_eq "NOK (not in snapshot) rate defaults to 1,0000" "$NOK_RATE_WITH_SNAP" "1,0000"

# ===== 5) GET /api/v1/exchange-rates returns the snapshot =====
# GET uses ?companyId= query param (no body) so
# the call can be cached and is RESTful.
GET_BODY=$(curl -sS \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/exchange-rates?companyId=$COMPANY_ID")
GET_DATE=$(echo "$GET_BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('date', '') if d else '')
")
GET_RATES_COUNT=$(echo "$GET_BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(len(d.get('rates', {})) if d else 0)
")
assert_eq "GET /exchange-rates returns the snapshot date" "$GET_DATE" "2026-06-19"
assert_eq "GET /exchange-rates has 3 rates" "$GET_RATES_COUNT" "3"

# ===== 6) POST /api/v1/exchange-rates/refresh (real network call) =====
# This is the only assertion that hits the real
# ECB API. If the network is down this test will
# fail — that's intentional (we want CI to
# surface network issues, not silently skip).
REFRESH_RES=$(curl -sS -X POST -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "{\"companyId\":\"$COMPANY_ID\"}" \
  "http://localhost:3001/api/v1/exchange-rates/refresh" -w "\n%{http_code}")
REFRESH_STATUS=$(echo "$REFRESH_RES" | tail -n1)
REFRESH_BODY=$(echo "$REFRESH_RES" | sed '$d')

if [[ "$REFRESH_STATUS" == "201" ]]; then
  pass "POST /exchange-rates/refresh returns 201"
else
  fail "POST /exchange-rates/refresh failed (HTTP $REFRESH_STATUS)"
  echo "$REFRESH_BODY" | head -3
fi

# Verify the refresh wrote a fresh snapshot
NEW_DATE=$(echo "$REFRESH_BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('date', '') if d else '')
")
# The fetchedAt is "now" — date should be today or
# the most recent ECB business day (Mon-Fri).
if [[ -n "$NEW_DATE" && "$NEW_DATE" > "2020" ]]; then
  pass "refresh: new snapshot date = $NEW_DATE"
else
  fail "refresh: snapshot date looks wrong: '$NEW_DATE'"
fi

# Verify the snapshot was persisted
PERSISTED=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT settings::jsonb->'datev'->'exchangeRates'->>'date' FROM \"Company\" WHERE id = '$COMPANY_ID';" 2>/dev/null | tr -d ' ')
if [[ "$PERSISTED" == "$NEW_DATE" ]]; then
  pass "refresh: snapshot persisted in DB"
else
  fail "refresh: persisted date ($PERSISTED) != response date ($NEW_DATE)"
fi

# ----- Cleanup -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE id IN ('$PAY_CHF_ID', '$PAY_EUR_ID', '$PAY_NOK_ID');
  DELETE FROM \"Invoice\" WHERE id IN ('$INV_CHF_ID', '$INV_EUR_ID', '$INV_NOK_ID');
  UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
