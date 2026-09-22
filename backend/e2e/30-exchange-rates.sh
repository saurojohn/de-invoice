#!/bin/bash
# Test 30: Tier 5d — ECB exchange rates in DATEV export
#
# Verifies the per-company exchangeRate snapshot is read by
# buildBuchungenFromDb. Since Tier 423 the DATEV amounts are in EUR: a
# non-EUR document without a stored EUR amount is converted at the snapshot
# rate. The cron @ 02:00 Berlin is not exercised here — the snapshot is
# seeded via SQL.
#
# Coverage:
#   1. No snapshot: a CHF invoice is booked 1:1
#   2. With a snapshot: invoice and payment converted at its rate
#   3. EUR invoices unchanged; no row carries a foreign currency code
#   4. A currency not in the snapshot: 1:1
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

# Tier 423: the DATEV amount is in EUR. A document without a stored EUR
# amount is converted at the company's ECB snapshot; without one, 1:1. (The
# export used to write the CHF amount unconverted, with the rate in a
# "Kurs" column at a position of its own layout.)
amt() { datev_rows "$1" | awk -F'\t' -v a="$2" 'index($8, a) {print $5}' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
assert_eq "no snapshot: CHF invoice and payment 1:1" "$(amt /tmp/csv-no-snap.csv E2E-T5D-CHF)" "1190.00"
assert_eq "no snapshot: NOK 1:1" "$(amt /tmp/csv-no-snap.csv E2E-T5D-NOK)" "1250.00"

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

# CHF 1 190 at 0.9248 CHF per EUR = 1 286.76 EUR, on the invoice row and
# the payment row alike.
assert_eq "snapshot: CHF invoice and payment converted at 0.9248" "$(amt /tmp/csv-with-snap.csv E2E-T5D-CHF)" "1286.76"
assert_eq "no foreign-currency code on a row booked in EUR" \
  "$(python3 - /tmp/csv-with-snap.csv <<'PY'
import csv, io, sys
rows = list(csv.reader(io.StringIO(open(sys.argv[1],'rb').read().decode('cp1252')), delimiter=';'))
i = rows[1].index('WKZ Umsatz')
print(sorted(set(r[i] for r in rows[2:] if r)))
PY
)" "['']"
assert_eq "EUR invoice unchanged" "$(amt /tmp/csv-with-snap.csv E2E-T5D-EUR)" "1190.00"
assert_eq "NOK (not in snapshot): 1:1" "$(amt /tmp/csv-with-snap.csv E2E-T5D-NOK)" "1250.00"

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
