#!/usr/bin/env bash
# e2e 104: Tier 78 — EU OSS (One-Stop-Shop) quarterly declaration.
#
# Validates the new /api/v1/reports/oss + /oss.csv endpoints
# that build a BZSt-OSS-Retourmeldung preview from the
# company's EU-B2C invoices.
#
# Filter rules (per the spec in oss.service.ts):
#   - status in [paid, sent, overdue] (drafts excluded,
#     counted separately in excludedDraft)
#   - customer.country is in EU-27
#   - customer has NO VAT ID (EU B2B → igL / reverse-charge,
#     not OSS)
#   - customer is in a DIFFERENT EU country than the
#     company (domestic B2C stays on UStVA)
#   - invoice type = INV (Gutschrift CN is excluded)
#
# Tests:
#   1. JSON shape (year, quarter, companyId, homeCountry,
#      countries[], totals, counts, generatedAt, disclaimer).
#   2. The fixture seed produces the expected
#      (country, vatRate) buckets + grand totals.
#   3. Exclusion counters report B2B + same-country +
#      non-EU + draft counts correctly.
#   4. Multi-rate invoice contributes to multiple
#      rate-buckets but only counts once per rate.
#   5. Per-(country, vatRate) line sums add up to the
#      country subtotal add up to the grand total.
#   6. CSV endpoint returns text/csv with the expected
#      header + one row per (country, vatRate) + a
#      total row.
#   7. CSV content uses German semicolon format.
#   8. year validation: 1999, 2101 → 400.
#   9. quarter validation: 0, 5 → 400.
#  10. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

# Stable test IDs — using $$ for namespace isolation
# so multiple parallel test runs don't collide.
TS="$(date +%s)-$$"
TEST_TAG="oss-tier78-$TS"
echo "=== Test: EU OSS (test tag: $TEST_TAG) ==="

# Cleanup hook (run on exit)
cleanup() {
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"InvoiceItem\" WHERE \"invoiceId\" IN (SELECT id FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'OSS-${TS}-%');" >/dev/null 2>&1
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"Invoice\" WHERE \"invoiceNumber\" LIKE 'OSS-${TS}-%';" >/dev/null 2>&1
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"Customer\" WHERE \"customerNumber\" LIKE 'OSS-${TS}-%';" >/dev/null 2>&1
}
trap cleanup EXIT

# Capture baseline counts (Polish #10: shared DB has
# residue from prior runs, so we assert deltas not
# absolutes). The test seeds 4 eligible + 1 each
# excluded; the baseline is whatever was already
# there.
api_get "/api/v1/reports/oss?companyId=$COMPANY_ID&year=2026&quarter=2"
TMP_BASELINE=$(mktemp -t oss-baseline.XXXXXX.json)
echo "$BODY" > "$TMP_BASELINE"
BASELINE_ELIG=$(python3 -c "import json;d=json.load(open('$TMP_BASELINE'));print(d['counts']['eligible'])")
BASELINE_B2B=$(python3 -c "import json;d=json.load(open('$TMP_BASELINE'));print(d['counts']['excludedB2B'])")
BASELINE_SC=$(python3 -c "import json;d=json.load(open('$TMP_BASELINE'));print(d['counts']['excludedSameCountry'])")
BASELINE_NEU=$(python3 -c "import json;d=json.load(open('$TMP_BASELINE'));print(d['counts']['excludedNonEU'])")
BASELINE_DR=$(python3 -c "import json;d=json.load(open('$TMP_BASELINE'));print(d['counts']['excludedDraft'])")
rm -f "$TMP_BASELINE"

# ── Seed test fixtures ──
echo
note "=== Seeding test customers + invoices ==="

# Customer set:
#  1. FR B2C (no VAT ID) — IN scope (cross-EU B2C)
#  2. AT B2C (no VAT ID) — IN scope
#  3. NL B2C (no VAT ID) — IN scope, will get a mixed-rate invoice
#  4. DE B2C (no VAT ID, same country as home) — OUT (sameCountry)
#  5. IT B2B (has VAT ID) — OUT (EU B2B → reverse-charge)
#  6. GB B2C (no VAT ID, post-Brexit non-EU) — OUT (non-EU)
#  7. ES B2C (no VAT ID) — IN scope
#
# Invoices all in 2026 Q2 (Apr–Jun).
# Each item is "rate:net" (semicolon-separated for multi-item invoices).
# Expected totals across the 4 in-scope invoices:
#   FR: net 100+50=150,    vat 20+2.75=22.75,  gross 172.75
#   AT: net 200+80=280,    vat 40+8=48,        gross 328
#   NL: net 300+150=450,   vat 63+13.5=76.5,   gross 526.5
#   ES: net 400+100=500,   vat 84+10=94,       gross 594
#   -----------------------------------------
#   Total: net 1380,       vat 241.25,         gross 1621.25

TMP_SQL=$(mktemp -t oss-seed.XXXXXX)
cat > "$TMP_SQL" <<EOF
BEGIN;

-- 7 test customers (one row each). Address.country
-- uses the German name form to also exercise the
-- normaliseCountry alias table (the detector
-- accepts "Frankreich" → "FR" etc.).
INSERT INTO "Customer" (id, "companyId", name, "customerNumber", "vatId",
                       "address", "paymentTerms", "tags", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', 'OSSTest FR B2C',  'OSS-${TS}-FR-1', NULL,            '{"street":"1","city":"Paris","postalCode":"75001","country":"Frankreich"}'::jsonb,     30, ARRAY[]::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'OSSTest AT B2C',  'OSS-${TS}-AT-1', NULL,            '{"street":"1","city":"Wien","postalCode":"1010","country":"Österreich"}'::jsonb,       30, ARRAY[]::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'OSSTest NL B2C',  'OSS-${TS}-NL-1', NULL,            '{"street":"1","city":"Amsterdam","postalCode":"1011","country":"Niederlande"}'::jsonb, 30, ARRAY[]::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'OSSTest DE B2C',  'OSS-${TS}-DE-1', NULL,            '{"street":"1","city":"Berlin","postalCode":"10115","country":"Deutschland"}'::jsonb,   30, ARRAY[]::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'OSSTest IT B2B',  'OSS-${TS}-IT-1', 'IT12345678901', '{"street":"1","city":"Roma","postalCode":"00100","country":"Italien"}'::jsonb,         30, ARRAY[]::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'OSSTest GB B2C',  'OSS-${TS}-GB-1', NULL,            '{"street":"1","city":"London","postalCode":"EC1","country":"Großbritannien"}'::jsonb,   30, ARRAY[]::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', 'OSSTest ES B2C',  'OSS-${TS}-ES-1', NULL,            '{"street":"1","city":"Madrid","postalCode":"28001","country":"Spanien"}'::jsonb,       30, ARRAY[]::text[], now(), now())
;

COMMIT;
EOF
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice < "$TMP_SQL"
rm -f "$TMP_SQL"

# Now grab each customer's id (we need them for the invoices)
get_cust_id() {
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Customer\" WHERE \"companyId\"='$COMPANY_ID' AND \"customerNumber\"='$1';" \
    2>&1 | tr -d ' ' | head -1
}
CUST_FR=$(get_cust_id "OSS-${TS}-FR-1")
CUST_AT=$(get_cust_id "OSS-${TS}-AT-1")
CUST_NL=$(get_cust_id "OSS-${TS}-NL-1")
CUST_DE=$(get_cust_id "OSS-${TS}-DE-1")
CUST_IT=$(get_cust_id "OSS-${TS}-IT-1")
CUST_GB=$(get_cust_id "OSS-${TS}-GB-1")
CUST_ES=$(get_cust_id "OSS-${TS}-ES-1")
echo "  Customers seeded: FR=$CUST_FR AT=$CUST_AT NL=$CUST_DE IT=$CUST_IT GB=$CUST_GB ES=$CUST_ES"

# Invoices — Q2 2026 = Apr-Jun 2026.
# Each invoice has 1+ items; items carry the actual
# rate + net + vat. We compute vat = round(net*rate, 2).
# Helper macro:
add_invoice() {
  # $1=number, $2=customerId, $3=date(YYYY-MM-DD), $4=status, $5=items_spec
  # items_spec: "rate:net;rate:net;..."
  local num="$1" cust="$2" date="$3" status="$4" spec="$5"
  local inv_id="inv-${num}"
  # Compute total net + total vat for the invoice
  local total_net=0 total_vat=0
  local items_sql=""
  IFS=';' read -ra PARTS <<< "$spec"
  local sort=0
  for p in "${PARTS[@]}"; do
    local rate="${p%%:*}"
    local net="${p##*:}"
    local vat=$(python3 -c "print(round($net*$rate, 2))")
    local gross=$(python3 -c "print(round($net+($net*$rate), 2))")
    total_net=$(python3 -c "print(round($total_net+$net, 2))")
    total_vat=$(python3 -c "print(round($total_vat+$vat, 2))")
    items_sql="$items_sql
INSERT INTO \"InvoiceItem\" (id, \"invoiceId\", description, quantity, \"unitPrice\", \"vatRate\", \"netAmount\", \"vatAmount\", \"grossAmount\", \"sortOrder\", \"createdAt\")
VALUES (gen_random_uuid()::text, '$inv_id', 'Item-$rate-$net', 1, $net, $rate, $net, $vat, $gross, $sort, now());"
    sort=$((sort+1))
  done
  local total=$(python3 -c "print(round($total_net+$total_vat, 2))")
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<EOSQL
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$inv_id', '$COMPANY_ID', '$cust', '$num', 'INV', '$status',
        '$date'::date, $total_net, $total_vat, $total, 'EUR', 'de-DE',
        false, false, 'OSSTest', now(), now());
$items_sql
EOSQL
}

# Eligible (in scope)
add_invoice "OSS-${TS}-FR-1" "$CUST_FR" "2026-04-15" "paid"  "0.20:100;0.055:50"
add_invoice "OSS-${TS}-AT-1" "$CUST_AT" "2026-05-10" "sent"  "0.20:200;0.10:80"
add_invoice "OSS-${TS}-NL-1" "$CUST_NL" "2026-06-05" "paid"  "0.21:300;0.09:150"  # mixed-rate single invoice
add_invoice "OSS-${TS}-ES-1" "$CUST_ES" "2026-05-20" "paid"  "0.21:400;0.10:100"
# Draft (excluded)
add_invoice "OSS-${TS}-FR-DRAFT" "$CUST_FR" "2026-04-15" "draft" "0.20:100"
# Excluded: same country
add_invoice "OSS-${TS}-DE-1" "$CUST_DE" "2026-05-15" "paid"  "0.19:1000"
# Excluded: B2B (has VAT ID)
add_invoice "OSS-${TS}-IT-1" "$CUST_IT" "2026-05-15" "paid"  "0.22:500"
# Excluded: non-EU
add_invoice "OSS-${TS}-GB-1" "$CUST_GB" "2026-05-15" "paid"  "0.20:500"

note "Seeded 8 invoices (4 in-scope, 1 draft, 1 same-country, 1 B2B, 1 non-EU)"

# ── 1. JSON shape ──
echo
note "=== 1. GET /reports/oss reachable + shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/reports/oss?companyId=$COMPANY_ID&year=2026&quarter=2" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "default 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['year','quarter','companyId','homeCountry','countries','totals','counts','generatedAt','disclaimer']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# ── 2. Expected bucket shape + country count ──
echo
note "=== 2. eligible fixtures: 4 countries (FR, AT, NL, ES) ==="
COUNTRIES_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
ccs = sorted(c['country'] for c in d['countries'])
expected = sorted(['FR','AT','NL','ES'])
print('true' if ccs == expected else f'got {ccs} expected {expected}')
")
assert_eq "4 EU-B2C countries in report" "$COUNTRIES_OK" "true"

# ── 3. Exclusion counts ──
echo
note "=== 3. exclusion counters ==="
EXCL_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
c = d['counts']
ok = (
  c['eligible'] == $BASELINE_ELIG + 4 and
  c['excludedB2B'] == $BASELINE_B2B + 1 and
  c['excludedSameCountry'] == $BASELINE_SC + 1 and
  c['excludedNonEU'] == $BASELINE_NEU + 1 and
  c['excludedDraft'] == $BASELINE_DR + 1
)
print('true' if ok else f'counts: {c}, baseline: elig={$BASELINE_ELIG} b2b={$BASELINE_B2B} sc={$BASELINE_SC} neu={$BASELINE_NEU} dr={$BASELINE_DR}')
")
assert_eq "counts: 4 eligible / 1 each excluded (delta from baseline)" "$EXCL_OK" "true"

# ── 4. Per-line counts: NL has 1 invoice, 2 rate-buckets ──
echo
note "=== 4. NL mixed-rate invoice: 1 invoice at 21%, 1 at 9% ==="
NL_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
nl = next((c for c in d['countries'] if c['country']=='NL'), None)
if not nl: print('no NL'); exit()
rates = sorted([v['vatRate'] for v in nl['vatRates']])
invoice_counts = sorted([v['invoiceCount'] for v in nl['vatRates']])
print('true' if rates == [0.09, 0.21] and invoice_counts == [1, 1] else f'rates={rates} counts={invoice_counts}')
")
assert_eq "NL has 2 rate lines, each with 1 invoice" "$NL_OK" "true"

# ── 5. Per-line sum consistency ──
echo
note "=== 5. per-line sums = country subtotals = grand total ==="
SUM_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
gt_n = d['totals']['netAmount']
gt_v = d['totals']['vatAmount']
gt_g = d['totals']['grossAmount']
c_n = sum(c['netAmount'] for c in d['countries'])
c_v = sum(c['vatAmount'] for c in d['countries'])
c_g = sum(c['grossAmount'] for c in d['countries'])
# each country's vatRates should sum to its subtotal
ok = (
  abs(gt_n - c_n) < 0.01 and
  abs(gt_v - c_v) < 0.01 and
  abs(gt_g - c_g) < 0.01
)
# per-line → country
for c in d['countries']:
  ln = sum(v['netAmount'] for v in c['vatRates'])
  lv = sum(v['vatAmount'] for v in c['vatRates'])
  if abs(ln - c['netAmount']) > 0.01: print(f'country {c[\"country\"]} net mismatch: line={ln} country={c[\"netAmount\"]}'); exit()
  if abs(lv - c['vatAmount']) > 0.01: print(f'country {c[\"country\"]} vat mismatch: line={lv} country={c[\"vatAmount\"]}'); exit()
# Expected values (from seed):
# FR: net 100+50=150, vat 20+2.75=22.75, gross 172.75
# AT: net 200+80=280, vat 40+8=48, gross 328
# NL: net 300+150=450, vat 63+13.5=76.5, gross 526.5
# ES: net 400+100=500, vat 84+10=94, gross 594
# Total: net 1380, vat 241.25, gross 1621.25
ok2 = (
  abs(d['totals']['netAmount'] - 1380) < 0.01 and
  abs(d['totals']['vatAmount'] - 241.25) < 0.01 and
  abs(d['totals']['grossAmount'] - 1621.25) < 0.01
)
print('true' if (ok and ok2) else f'grand: N={gt_n} V={gt_v} G={gt_g} (expected 1380 / 241.25 / 1621.25)')
")
assert_eq "totals + per-line sums are consistent" "$SUM_OK" "true"

# ── 6. CSV endpoint ──
echo
note "=== 6. /reports/oss.csv returns text/csv with expected header + rows ==="
CSV_RESP=$(curl -sS -o /tmp/oss-test.csv -w "%{http_code}|%{content_type}" \
  "$API/api/v1/reports/oss.csv?companyId=$COMPANY_ID&year=2026&quarter=2" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
HTTP=$(echo "$CSV_RESP" | cut -d'|' -f1)
CT=$(echo "$CSV_RESP" | cut -d'|' -f2)
assert_eq "CSV 200" "$HTTP" "200"
assert_eq "CSV content-type" "$CT" "text/csv; charset=utf-8"

# CSV structure: header + 6 data rows (NL+ES+AT+FR = 4 countries × 2 rates = 8)
# Actually 4 countries × 2 rates = 8 data rows + Summe row.
# But countries are sorted desc by grossAmount so:
# ES 594 → ES 0.21, ES 0.10
# NL 526.5 → NL 0.21, NL 0.09
# AT 328 → AT 0.20, AT 0.10
# FR 172.75 → FR 0.20, FR 0.055
CSV_ROWS=$(wc -l < /tmp/oss-test.csv | tr -d ' ')
assert_eq "CSV line count = 1 header + 8 data + 1 blank + 1 summe = 11" "$CSV_ROWS" "11"

HEADER=$(head -1 /tmp/oss-test.csv)
assert_eq "CSV header" "$HEADER" "Mitgliedstaat;USt-Satz;Netto (EUR);USt (EUR);Brutto (EUR);Rechnungen"

# Last line is the Summe row
LAST=$(tail -1 /tmp/oss-test.csv)
echo "$LAST" | grep -q "Summe" || fail "last line should be Summe row: got '$LAST'"
echo "$LAST" | grep -q "1.380,00" || fail "Summe net should be 1.380,00 (DE format): got '$LAST'"
echo "$LAST" | grep -q "241,25" || fail "Summe vat should be 241,25: got '$LAST'"
echo "$LAST" | grep -q "1.621,25" || fail "Summe gross should be 1.621,25: got '$LAST'"

# ── 7. year validation ──
echo
note "=== 7. year validation ==="
ST_Y1999=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/oss?companyId=$COMPANY_ID&year=1999&quarter=2" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$ST_Y1999" "400"
ST_Y2101=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/oss?companyId=$COMPANY_ID&year=2101&quarter=2" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$ST_Y2101" "400"

# ── 8. quarter validation ──
echo
note "=== 8. quarter validation ==="
ST_Q0=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/oss?companyId=$COMPANY_ID&year=2026&quarter=0" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "quarter=0 → 400" "$ST_Q0" "400"
ST_Q5=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/oss?companyId=$COMPANY_ID&year=2026&quarter=5" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "quarter=5 → 400" "$ST_Q5" "400"

# ── 9. Cross-tenant → 401 ──
echo
note "=== 9. cross-tenant → 401 ==="
ST_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/oss?companyId=$COMPANY_ID&year=2026&quarter=2" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST_CROSS" "401"

# ── 10. Missing companyId → 400 ──
echo
note "=== 10. missing companyId → 400 ==="
ST_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/oss?year=2026&quarter=2" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$ST_NO_CID" "400"

rm -f "$TMP" /tmp/oss-test.csv
summary
exit $?
