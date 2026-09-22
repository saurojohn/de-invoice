#!/bin/bash
# Test 25: Tier 5 DATEV-export field coverage.
#
# Seeds a comprehensive set of Buchungsfälle that exercise
# every new field added in the Tier 5 refactor (Buchungslauf-ID,
# opening balances, Kostenstelle/Kostenträger, currency, payment
# method, country code, IgE/§13b reverse-charge). Runs the
# datev-export endpoint and asserts each field lands in the
# right DATEV column.
#
# Coverage:
#   5a  — Buchungslauf-ID in header + filename + opening balances
#   5b  — Kostenstelle 1 + Kostenträger (cols 18 + 19)
#   5c  — IgE (§1a) and §13b reverse-charge account flow
#   5d  — currency non-EUR + payment method (cols 14, 16, 17)
#   5e  — country code (col 21) for EU/non-EU splits
#
# The seed is self-contained: own customer (AT, US), own
# supplier (GB), own expense (RC, IgE), own invoice (IgE +
# CHF + §13b-out). All seeded rows + the company settings
# are deleted at the end (and re-cleaned at the start of
# a re-run, since the test uses fixed IDs).
#
# Implementation note: the CSV is Latin-1 encoded, so
# `awk -F';'` on a Buchungstext with umlauts (Erlöse,
# USt) is unreliable — `LC_ALL=C grep` cuts the line at
# the non-ASCII byte. We use Python for the column reads
# to keep the assertions correct.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 5 DATEV-export field coverage ==="

# ----- Fixed seed IDs (idempotent re-runs) -----
CUST_DE_ID="e2e0e0e0-0001-0000-0000-aaaaaa000001"
CUST_AT_ID="e2e0e0e0-0001-0000-0000-aaaaaa000002"
CUST_US_ID="e2e0e0e0-0001-0000-0000-aaaaaa000003"
SUPP_GB_ID="e2e0e0e0-0001-0000-0000-bbbbbb000001"
INV_IGE_ID="e2e0e0e0-0001-0000-0000-cccccccc0001"
INV_RC_ID="e2e0e0e0-0001-0000-0000-cccccccc0002"
INV_CHF_ID="e2e0e0e0-0001-0000-0000-cccccccc0003"
PAY_IGE_ID="e2e0e0e0-0001-0000-0000-ddddddd00001"
PAY_RC_ID="e2e0e0e0-0001-0000-0000-ddddddd00002"
PAY_CHF_ID="e2e0e0e0-0001-0000-0000-ddddddd00003"
EXP_RC_ID="e2e0e0e0-0001-0000-0000-eeeeeeee00001"
EXP_IGE_ID="e2e0e0e0-0001-0000-0000-eeeeeeee00002"

# ----- Clean up any prior run -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE id IN ('$PAY_IGE_ID', '$PAY_RC_ID', '$PAY_CHF_ID');
  DELETE FROM \"Invoice\" WHERE id IN ('$INV_IGE_ID', '$INV_RC_ID', '$INV_CHF_ID');
  DELETE FROM \"Expense\" WHERE id IN ('$EXP_RC_ID', '$EXP_IGE_ID');
  DELETE FROM \"Customer\" WHERE id IN ('$CUST_DE_ID', '$CUST_AT_ID', '$CUST_US_ID');
  DELETE FROM \"Supplier\" WHERE id = '$SUPP_GB_ID';
" >/dev/null 2>&1

# ----- Seed customers (3 different countries) -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Customer\" (id, \"companyId\", name, \"customerNumber\", address, \"createdAt\", \"updatedAt\") VALUES
    ('$CUST_DE_ID', '$COMPANY_ID', 'E2E T5 DE Customer', 'K-T5-DE', '{\"street\":\"Test 1\",\"city\":\"Frankfurt\",\"postalCode\":\"60311\",\"country\":\"DE\"}'::jsonb, now(), now()),
    ('$CUST_AT_ID', '$COMPANY_ID', 'E2E T5 AT Customer', 'K-T5-AT', '{\"street\":\"Mariahilfer 1\",\"city\":\"Wien\",\"postalCode\":\"1060\",\"country\":\"AT\"}'::jsonb, now(), now()),
    ('$CUST_US_ID', '$COMPANY_ID', 'E2E T5 US Customer', 'K-T5-US', '{\"street\":\"5th Ave\",\"city\":\"New York\",\"postalCode\":\"10001\",\"country\":\"US\"}'::jsonb, now(), now());
" >/dev/null 2>&1

# ----- Seed UK supplier (§13b reverse-charge source) -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Supplier\" (id, \"companyId\", name, address, \"createdAt\", \"updatedAt\") VALUES
    ('$SUPP_GB_ID', '$COMPANY_ID', 'E2E T5 UK Supplier', '{\"street\":\"221B Baker St\",\"city\":\"London\",\"postalCode\":\"NW16XE\",\"country\":\"GB\"}'::jsonb, now(), now());
" >/dev/null 2>&1

# ----- Seed 3 paid invoices -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", \"sequenceNumber\",
                          type, status, \"issueDate\", \"dueDate\",
                          subtotal, \"totalVat\", total, \"discountPercent\", \"discountAmount\",
                          currency, language, \"vatBreakdown\", \"reverseCharge\", \"euTransaction\",
                          notes, \"templateType\", \"costCenter\", \"costObject\",
                          \"pdfPath\", attachments, \"createdAt\", \"updatedAt\") VALUES
    ('$INV_IGE_ID', '$COMPANY_ID', '$CUST_AT_ID', 'E2E-T5-IGE-01', 9501,
     'INV', 'paid', '2026-05-15', '2026-06-15',
     1000.00, 0.00, 1000.00, 0, 0,
     'EUR', 'de-DE', '[]', false, true,
     'IgE Test', 'standard', '100', 'PROJ-2026-IGE',
     NULL, '[]', now(), now()),
    ('$INV_RC_ID', '$COMPANY_ID', '$CUST_DE_ID', 'E2E-T5-RC-01', 9502,
     'INV', 'paid', '2026-05-16', '2026-06-16',
     500.00, 0.00, 500.00, 0, 0,
     'EUR', 'de-DE', '[]', true, false,
     '13b RC outgoing', 'standard', '200', 'PROJ-2026-RC',
     NULL, '[]', now(), now()),
    ('$INV_CHF_ID', '$COMPANY_ID', '$CUST_US_ID', 'E2E-T5-CHF-01', 9503,
     'INV', 'paid', '2026-05-17', '2026-06-17',
     800.00, 152.00, 952.00, 0, 0,
     'CHF', 'de-DE', '[{\"rate\":0.19,\"net\":800,\"vat\":152}]'::jsonb, false, false,
     'CHF non-EU', 'standard', '300', NULL,
     NULL, '[]', now(), now());
" >/dev/null 2>&1

# ----- Seed payments (so invoices are 'paid' and trigger revenue) -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Payment\" (id, \"invoiceId\", amount, currency, \"paymentDate\", \"paymentMethod\", notes, \"createdAt\") VALUES
    ('$PAY_IGE_ID', '$INV_IGE_ID', 1000.00, 'EUR', '2026-05-20', 'bank_transfer', 'E2E IgE', now()),
    ('$PAY_RC_ID', '$INV_RC_ID', 500.00, 'EUR', '2026-05-21', 'sepa', 'E2E RC', now()),
    ('$PAY_CHF_ID', '$INV_CHF_ID', 952.00, 'CHF', '2026-05-22', 'bank_transfer', 'E2E CHF', now());
" >/dev/null 2>&1

# ----- Seed 2 expenses: §13b reverse-charge + IgE -----
# EXP_RC: pure §13b (Bauleistung case) — VAT is 19% but
# the Leistungsempfänger owes it, so we book the
# Vorsteuer on account 1780. isIntraEU=false so it
# takes the reverseCharge branch, not the IgE branch.
# EXP_IGE: classic IgE (§1a UStG) — VAT 19% via account 1782.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Expense\" (id, \"companyId\", \"supplierId\", \"invoiceNumber\", description, \"invoiceDate\",
                          \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\",
                          category, \"isIntraEU\", \"isReverseCharge\", status, notes,
                          \"costCenter\", \"costObject\", \"createdAt\", \"updatedAt\") VALUES
    ('$EXP_RC_ID', '$COMPANY_ID', '$SUPP_GB_ID', 'E2E-T5-EXP-RC', 'UK-Bauleistung 13b',
     '2026-04-10', 2000.00, 0.1900, 380.00, 2380.00,
     'Beratung', false, true, 'booked', 'E2E',
     '400', 'PROJ-EXP-2026', now(), now()),
    ('$EXP_IGE_ID', '$COMPANY_ID', '$SUPP_GB_ID', 'E2E-T5-EXP-IGE', 'EU-Waren IgE',
     '2026-04-15', 1500.00, 0.1900, 285.00, 1785.00,
     'Material', true, false, 'booked', 'E2E',
     '500', NULL, now(), now());
" >/dev/null 2>&1

# ----- Set per-company DATEV config (Berater-Nr, Mandanten-Nr, EB) -----
# Simple jsonb literal — much cleaner than a multi-step
# jsonb_set. Default values from a missing field should
# still be 00000 / 00001, so 11111/22222 are unambiguous
# in the assertion.
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  UPDATE \"Company\"
  SET settings = '{
    \"datev\": {
      \"beraterNr\": \"11111\",
      \"mandantenNr\": \"22222\",
      \"laufNr\": {\"2026\": 1},
      \"openingBalances\": [
        {\"konto\": \"1200\", \"betrag\": 5000.00, \"shVz\": \"S\", \"buchungstext\": \"EB Bank\"},
        {\"konto\": \"1400\", \"betrag\": 2500.00, \"shVz\": \"S\", \"buchungstext\": \"EB Forderungen\"}
      ]
    }
  }'::jsonb
  WHERE id = '$COMPANY_ID';
" >/dev/null 2>&1

# ----- Fetch the DATEV export -----
curl -sS -D /tmp/datev-t5-headers.txt \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/reports/datev-export?companyId=$COMPANY_ID&startDate=2026-01-01&endDate=2026-12-31" \
  -o /tmp/datev-t5.csv

# ===== 5a: Buchungslauf-ID + filename + EB-Werte =====

# Filename: EXTF_Buchungsstapel_<date>_L<laufNr>.csv
if LC_ALL=C grep -qi "filename=\"EXTF_Buchungsstapel_2026-01-01_L001.csv\"" /tmp/datev-t5-headers.txt; then
  pass "5a: filename EXTF_Buchungsstapel_2026-01-01_L001.csv"
else
  fail "5a: filename pattern wrong"
  grep -i "filename" /tmp/datev-t5-headers.txt | head -1
fi

# Tier 423: the export is a real DATEV Buchungsstapel now (EXTF 700,
# Formatversion 13), read here by column heading. The columns this spec
# checked by position (currency, Kurs, ISO3 country, payment method in
# columns 14–21) belonged to a layout of the app's own; DATEV has no such
# columns in those places. Amounts are in EUR (a CHF invoice at its stored
# rate); the ZM needs the customer's VAT id, which is in "EU-Land u. USt-IdNr.".
hdr() { python3 -c "
import sys
line = open('/tmp/datev-t5.csv','rb').readline().decode('cp1252').rstrip('\r\n')
print(line.split(';')[int(sys.argv[1])-1].strip('\"'))" "$1"; }
# The value in column HEADING of the first row whose Buchungstext contains ANCHOR.
col() { python3 - "$1" "$2" <<'PY'
import csv, io, sys
rows = list(csv.reader(io.StringIO(open('/tmp/datev-t5.csv','rb').read().decode('cp1252')), delimiter=';'))
cols = rows[1]
m = [r for r in rows[2:] if r and sys.argv[1] in r[cols.index('Buchungstext')]]
print(m[0][cols.index(sys.argv[2])] if m else '<no row>')
PY
}
count() { datev_rows /tmp/datev-t5.csv | awk -F'\t' -v a="$1" 'index($8, a) {n++} END {print n+0}'; }

assert_eq "5a: header: EXTF 700 Buchungsstapel v13" "$(hdr 1) $(hdr 2) $(hdr 4) $(hdr 5)" "EXTF 700 Buchungsstapel 13"
assert_eq "5a: header field 11 (Berater-Nr)" "$(hdr 11)" "11111"
assert_eq "5a: header field 12 (Mandanten-Nr)" "$(hdr 12)" "22222"
assert_eq "5a: header field 14 (Sachkontenlänge)" "$(hdr 14)" "4"
assert_eq "5a: header field 31 (Anwendungsinformation: Buchungslauf)" "$(hdr 31)" "Lauf 001"

if LC_ALL=C grep -q "EB Bank" /tmp/datev-t5.csv; then pass "5a: EB Bank line present"; else fail "5a: EB Bank line missing"; fi
if LC_ALL=C grep -q "EB Forderungen" /tmp/datev-t5.csv; then pass "5a: EB Forderungen line present"; else fail "5a: EB Forderungen line missing"; fi
assert_eq "5a: EB Bank gegenkonto 9000" "$(col 'EB Bank' 'Gegenkonto (ohne BU-Schlüssel)')" "9000"
assert_eq "5a: EB date = 1 January (TTMM)" "$(col 'EB Bank' 'Belegdatum')" "0101"
FIRST_DATA_BF1=$(datev_rows /tmp/datev-t5.csv | head -1 | cut -f1)
[[ "$FIRST_DATA_BF1" == EB-* ]] && pass "5a: EB-Werte precede regular Buchungen" || fail "5a: first data line is not EB-: $FIRST_DATA_BF1"

K1='KOST1 – Kostenstelle'; K2='KOST2 – Kostenstelle'
assert_eq "5b: IgE invoice KOST1" "$(col 'Rechnung E2E-T5-IGE-01' "$K1")" "100"
assert_eq "5b: IgE invoice KOST2" "$(col 'Rechnung E2E-T5-IGE-01' "$K2")" "PROJ-2026-IGE"
assert_eq "5b: RC invoice KOST1" "$(col 'Rechnung E2E-T5-RC-01' "$K1")" "200"
assert_eq "5b: RC invoice KOST2" "$(col 'Rechnung E2E-T5-RC-01' "$K2")" "PROJ-2026-RC"
assert_eq "5b: CHF invoice KOST1" "$(col 'Rechnung E2E-T5-CHF-01' "$K1")" "300"
assert_eq "5b: CHF invoice KOST2 empty" "$(col 'Rechnung E2E-T5-CHF-01' "$K2")" ""
assert_eq "5b: RC expense KOST1" "$(col 'UK-Bauleistung 13b' "$K1")" "400"
assert_eq "5b: RC expense KOST2" "$(col 'UK-Bauleistung 13b' "$K2")" "PROJ-EXP-2026"
assert_eq "5b: IgE expense KOST1" "$(col 'EU-Waren IgE' "$K1")" "500"
assert_eq "5b: IgE expense KOST2 empty" "$(col 'EU-Waren IgE' "$K2")" ""

assert_eq "5c: igL revenue on 8125" "$(col 'Rechnung E2E-T5-IGE-01' 'Gegenkonto (ohne BU-Schlüssel)')" "8125"
assert_eq "5c: igL without tax key (was an invented '0')" "$(col 'Rechnung E2E-T5-IGE-01' 'BU-Schlüssel')" ""
assert_eq "5c: igL: invoice + payment rows only (no USt row), gross = net" "$(count 'E2E-T5-IGE-01' ) $(col 'Rechnung E2E-T5-IGE-01' 'Umsatz (ohne Soll/Haben-Kz)')" "2 1000,00"
assert_eq "5c: § 13b outgoing (domestic customer) on 8337, no key" \
  "$(col 'Rechnung E2E-T5-RC-01' 'Gegenkonto (ohne BU-Schlüssel)')/$(col 'Rechnung E2E-T5-RC-01' 'BU-Schlüssel')" "8337/"
assert_eq "5c: § 13b expense: net 2000, key 94 (was a Vorsteuer row on 1780)" \
  "$(col 'UK-Bauleistung 13b' 'Umsatz (ohne Soll/Haben-Kz)')/$(col 'UK-Bauleistung 13b' 'BU-Schlüssel')" "2000,00/94"
assert_eq "5c: igE expense: net 1500, key 19 (was a Vorsteuer row on 1782)" \
  "$(col 'EU-Waren IgE' 'Umsatz (ohne Soll/Haben-Kz)')/$(col 'EU-Waren IgE' 'BU-Schlüssel')" "1500,00/19"
assert_eq "5c: both expenses on the supplier's Kreditor, H" \
  "$(datev_rows /tmp/datev-t5.csv | awk -F'\t' '$1 ~ /^E2E-T5-EXP/ {print substr($3,1,1) length($3) $6}' | sort -u)" "75H"

assert_eq "5d: CHF invoice in EUR (no stored rate → 1:1), 19 % key 3" \
  "$(col 'Rechnung E2E-T5-CHF-01' 'Umsatz (ohne Soll/Haben-Kz)')/$(col 'Rechnung E2E-T5-CHF-01' 'WKZ Umsatz')/$(col 'Rechnung E2E-T5-CHF-01' 'BU-Schlüssel')" "952,00//3"

assert_eq "5e: the payments: Bank 1200 an the customer's Debitor, S" \
  "$(datev_rows /tmp/datev-t5.csv | awk -F'\t' 'index($8, "Zahlung E2E-T5") {print $3, substr($4,1,1) length($4), $5, $6}' | sort -u | tr '\n' '|')" \
  "1200 15 1000.00 S|1200 15 500.00 S|1200 15 952.00 S|"

# ----- Cleanup -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE id IN ('$PAY_IGE_ID', '$PAY_RC_ID', '$PAY_CHF_ID');
  DELETE FROM \"Invoice\" WHERE id IN ('$INV_IGE_ID', '$INV_RC_ID', '$INV_CHF_ID');
  DELETE FROM \"Expense\" WHERE id IN ('$EXP_RC_ID', '$EXP_IGE_ID');
  DELETE FROM \"Customer\" WHERE id IN ('$CUST_DE_ID', '$CUST_AT_ID', '$CUST_US_ID');
  DELETE FROM \"Supplier\" WHERE id = '$SUPP_GB_ID';
  UPDATE \"Company\" SET settings = NULL WHERE id = '$COMPANY_ID';
" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
