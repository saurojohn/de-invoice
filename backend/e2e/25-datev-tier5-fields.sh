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
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"Payment\" WHERE id IN ('$PAY_IGE_ID', '$PAY_RC_ID', '$PAY_CHF_ID');
  DELETE FROM \"Invoice\" WHERE id IN ('$INV_IGE_ID', '$INV_RC_ID', '$INV_CHF_ID');
  DELETE FROM \"Expense\" WHERE id IN ('$EXP_RC_ID', '$EXP_IGE_ID');
  DELETE FROM \"Customer\" WHERE id IN ('$CUST_DE_ID', '$CUST_AT_ID', '$CUST_US_ID');
  DELETE FROM \"Supplier\" WHERE id = '$SUPP_GB_ID';
" >/dev/null 2>&1

# ----- Seed customers (3 different countries) -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Customer\" (id, \"companyId\", name, \"customerNumber\", address, \"createdAt\", \"updatedAt\") VALUES
    ('$CUST_DE_ID', '$COMPANY_ID', 'E2E T5 DE Customer', 'K-T5-DE', '{\"street\":\"Test 1\",\"city\":\"Frankfurt\",\"postalCode\":\"60311\",\"country\":\"DE\"}'::jsonb, now(), now()),
    ('$CUST_AT_ID', '$COMPANY_ID', 'E2E T5 AT Customer', 'K-T5-AT', '{\"street\":\"Mariahilfer 1\",\"city\":\"Wien\",\"postalCode\":\"1060\",\"country\":\"AT\"}'::jsonb, now(), now()),
    ('$CUST_US_ID', '$COMPANY_ID', 'E2E T5 US Customer', 'K-T5-US', '{\"street\":\"5th Ave\",\"city\":\"New York\",\"postalCode\":\"10001\",\"country\":\"US\"}'::jsonb, now(), now());
" >/dev/null 2>&1

# ----- Seed UK supplier (§13b reverse-charge source) -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
  INSERT INTO \"Supplier\" (id, \"companyId\", name, address, \"createdAt\", \"updatedAt\") VALUES
    ('$SUPP_GB_ID', '$COMPANY_ID', 'E2E T5 UK Supplier', '{\"street\":\"221B Baker St\",\"city\":\"London\",\"postalCode\":\"NW16XE\",\"country\":\"GB\"}'::jsonb, now(), now());
" >/dev/null 2>&1

# ----- Seed 3 paid invoices -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
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
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
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
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
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
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
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

# Header columns via Python (Latin-1 safe)
read_header() {
  python3 -c "
import sys
with open('/tmp/datev-t5.csv', 'rb') as f:
    line = f.readline().decode('latin-1').rstrip('\r\n')
cols = line.split(';')
n = int(sys.argv[1])
print(cols[n-1] if n <= len(cols) else '')
" "$1"
}

assert_eq "5a: header field 5 (Buchungslauf)" \
  "$(read_header 5)" "Lauf 001"
assert_eq "5a: header field 6 (Berater-Nr)" \
  "$(read_header 6)" "11111"
assert_eq "5a: header field 7 (Mandanten-Nr)" \
  "$(read_header 7)" "22222"
assert_eq "5a: header field 20 (Kontenplan)" \
  "$(read_header 20)" "SKR03"

# EB-Werte lines present (Buchungstext "EB Bank" / "EB Forderungen")
# Match on buchungstext, not the EB- prefix, because the
# Belegfeld 1 already contains "EB-1200" / "EB-1400".
if LC_ALL=C grep -q "EB Bank" /tmp/datev-t5.csv; then
  pass "5a: EB Bank line present (Buchungslauf 0)"
else
  fail "5a: EB Bank line missing"
fi
if LC_ALL=C grep -q "EB Forderungen" /tmp/datev-t5.csv; then
  pass "5a: EB Forderungen line present"
else
  fail "5a: EB Forderungen line missing"
fi

# EB-Werte use 9000 (Eröffnungsbilanzkonto) as Gegenkonto.
# Find the EB-1200 row and read col 8.
EB_GEGEN=$(python3 -c "
with open('/tmp/datev-t5.csv', 'rb') as f:
    for line in f.read().decode('latin-1').splitlines():
        if 'EB Bank' in line:
            cols = line.split(';')
            print(cols[7])
            break
")
assert_eq "5a: EB Bank gegenkonto 9000" "$EB_GEGEN" "9000"

# EB-Werte dated 01.01 of start year.
EB_DATE=$(python3 -c "
with open('/tmp/datev-t5.csv', 'rb') as f:
    for line in f.read().decode('latin-1').splitlines():
        if 'EB Bank' in line:
            cols = line.split(';')
            print(cols[1])
            break
")
assert_eq "5a: EB date = 2026 1 1" "$EB_DATE" "2026 1 1"

# EB-Werte are the FIRST data rows (Buchungslauf 0
# precedes Buchungslauf 1+).
FIRST_DATA_BF1=$(python3 -c "
import sys
with open('/tmp/datev-t5.csv', 'rb') as f:
    f.readline()  # skip header
    line = f.readline().decode('latin-1').rstrip('\r\n')
print(line.split(';')[2])
")
if [[ "$FIRST_DATA_BF1" == EB-* ]]; then
  pass "5a: EB-Werte precede regular Buchungen"
else
  fail "5a: first data line is not EB-: $FIRST_DATA_BF1"
fi

# Helper: parse a single CSV line by content match and
# return column N (1-based). Reads the entire file and
# returns the first match. Returns "" if not found.
csv_col() {
  local anchor="$1" col="$2"
  python3 -c "
import sys
anchor, col = sys.argv[1], int(sys.argv[2])
with open('/tmp/datev-t5.csv', 'rb') as f:
    for line in f.read().decode('latin-1').splitlines():
        if anchor in line:
            cells = line.split(';')
            print(cells[col-1] if col <= len(cells) else '')
            break
    else:
        print('')
" "$anchor" "$col"
}

# ===== 5b: Kostenstelle 1 + Kostenträger (cols 18 + 19) =====

# IgE invoice Erlöse line
assert_eq "5b: IgE Erlöse kost1 (col 18)" \
  "$(csv_col 'Erlöse E2E-T5-IGE-01' 18)" "100"
assert_eq "5b: IgE Erlöse kost2 (col 19)" \
  "$(csv_col 'Erlöse E2E-T5-IGE-01' 19)" "PROJ-2026-IGE"

# RC invoice Erlöse line
assert_eq "5b: RC Erlöse kost1 (col 18)" \
  "$(csv_col 'Erlöse E2E-T5-RC-01' 18)" "200"
assert_eq "5b: RC Erlöse kost2 (col 19)" \
  "$(csv_col 'Erlöse E2E-T5-RC-01' 19)" "PROJ-2026-RC"

# CHF invoice Erlöse line — kost1=300, kost2 empty
assert_eq "5b: CHF Erlöse kost1 (col 18)" \
  "$(csv_col 'Erlöse E2E-T5-CHF-01' 18)" "300"
assert_eq "5b: CHF Erlöse kost2 (col 19) empty" \
  "$(csv_col 'Erlöse E2E-T5-CHF-01' 19)" ""

# §13b RC expense Bank→Aufwand line: kost1=400
assert_eq "5b: RC expense kost1 (col 18)" \
  "$(csv_col 'E2E-T5-EXP-RC' 18)" "400"
assert_eq "5b: RC expense kost2 (col 19)" \
  "$(csv_col 'E2E-T5-EXP-RC' 19)" "PROJ-EXP-2026"

# IgE expense — kost1=500, kost2 empty
assert_eq "5b: IgE expense kost1 (col 18)" \
  "$(csv_col 'E2E-T5-EXP-IGE' 18)" "500"
assert_eq "5b: IgE expense kost2 (col 19) empty" \
  "$(csv_col 'E2E-T5-EXP-IGE' 19)" ""

# ===== 5c: IgE + §13b account flow =====

# IgE: revenue on 8125 (Erlöse igL)
assert_eq "5c: IgE revenue on 8125" \
  "$(csv_col 'Erlöse E2E-T5-IGE-01' 8)" "8125"

# IgE: USt-Schlüssel = 0 (col 12)
assert_eq "5c: IgE USt-Schlüssel = 0" \
  "$(csv_col 'Erlöse E2E-T5-IGE-01' 12)" "0"

# IgE: ustBetrag = 0.00 (col 13)
assert_eq "5c: IgE ustBetrag = 0.00" \
  "$(csv_col 'Erlöse E2E-T5-IGE-01' 13)" "0.00"

# IgE: NO separate USt line for this invoice.
# Look for any "USt E2E-T5-IGE-01" line. Should not exist.
IGE_UST_COUNT=$(python3 -c "
import sys
with open('/tmp/datev-t5.csv', 'rb') as f:
    n = 0
    for line in f.read().decode('latin-1').splitlines():
        if 'USt E2E-T5-IGE-01' in line:
            n += 1
print(n)
")
assert_eq "5c: IgE has no separate USt line" "$IGE_UST_COUNT" "0"

# §13b outgoing invoice: same path
assert_eq "5c: 13b outgoing USt-Schlüssel = 0" \
  "$(csv_col 'Erlöse E2E-T5-RC-01' 12)" "0"
RC_UST_COUNT=$(python3 -c "
import sys
with open('/tmp/datev-t5.csv', 'rb') as f:
    n = 0
    for line in f.read().decode('latin-1').splitlines():
        if 'USt E2E-T5-RC-01' in line:
            n += 1
print(n)
")
assert_eq "5c: 13b outgoing has no separate USt line" "$RC_UST_COUNT" "0"

# §13b RC expense: inputVat 1780 (Vorsteuer §13b, col 7 = Soll-Konto)
assert_eq "5c: 13b RC expense inputVat = 1780" \
  "$(csv_col 'Vorsteuer E2E-T5-EXP-RC' 7)" "1780"

# IgE expense: inputVat 1782 (Vorsteuer IgE, fixed from wrong 1578)
assert_eq "5c: IgE expense inputVat = 1782" \
  "$(csv_col 'Vorsteuer E2E-T5-EXP-IGE' 7)" "1782"

# ===== 5d: currency + payment method (cols 14, 16) =====

# CHF invoice: currency CHF (col 16) on all its lines
assert_eq "5d: CHF invoice currency = CHF" \
  "$(csv_col 'Zahlungseingang E2E-T5-CHF-01' 16)" "CHF"
# And exchangeRate 1.0000 default (col 17)
assert_eq "5d: CHF Kurs = 1,0000" \
  "$(csv_col 'Zahlungseingang E2E-T5-CHF-01' 17)" "1,0000"

# EUR invoice: currency EUR, Kurs 1,0000
assert_eq "5d: EUR invoice currency = EUR" \
  "$(csv_col 'Zahlungseingang E2E-T5-IGE-01' 16)" "EUR"

# CHF invoice: USt-Schlüssel = 1 (19% USt, Regelsatz) — col 12
#
# Tier 26.4: the USt-Schlüssel is now the 2024+ DATEV
# code "1" (19% Regelsatz) instead of the legacy "3".
# Both are valid DATEV keys; the modern export uses
# "1" as the default for new 19% bookings. For
# backwards compat with existing Berater imports the
# legacy "3" is still accepted by the DATEV client.
assert_eq "5d: CHF invoice USt-Schlüssel = 1" \
  "$(csv_col 'Erlöse E2E-T5-CHF-01' 12)" "1"

# ===== 5e: country code (col 21) =====

# AT customer (IgE) → "AUT" on the IgE line
assert_eq "5e: AT customer → AUT" \
  "$(csv_col 'Erlöse E2E-T5-IGE-01' 21)" "AUT"

# DE customer (RC outgoing) → "DEU"
assert_eq "5e: DE customer → DEU" \
  "$(csv_col 'Zahlungseingang E2E-T5-RC-01' 21)" "DEU"

# US customer (CHF) → "USA"
assert_eq "5e: US customer → USA" \
  "$(csv_col 'Zahlungseingang E2E-T5-CHF-01' 21)" "USA"

# ===== 5e: payment method (col 14) =====

assert_eq "5e: IgE Erlöse paymentMethod = bank_transfer" \
  "$(csv_col 'Erlöse E2E-T5-IGE-01' 14)" "bank_transfer"
assert_eq "5e: RC Erlöse paymentMethod = sepa" \
  "$(csv_col 'Erlöse E2E-T5-RC-01' 14)" "sepa"
assert_eq "5e: CHF Erlöse paymentMethod = bank_transfer" \
  "$(csv_col 'Erlöse E2E-T5-CHF-01' 14)" "bank_transfer"

# ----- Cleanup -----
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c "
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
