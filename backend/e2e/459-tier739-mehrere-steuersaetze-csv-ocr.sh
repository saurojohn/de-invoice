#!/bin/bash
# Tier 739 — an invoice with 19 % and 7 %: in the CSV import and in the OCR proposal
#
# Since Tier 581 an expense holds a VAT line per rate, but two ways in knew
# one rate:
#   1. the CSV import — sevDesk, lexoffice and DATEV export such an invoice
#      as a row per rate (same supplier, number, date). The second row was
#      refused as a duplicate of the first: only the 19 % part was booked.
#      Now the rows become one expense with its lines; rows of the same rate
#      add up; a row repeated word for word is still refused (it would
#      double the amount); different categories in one invoice are refused.
#   2. the OCR proposal — the first „USt 19 %" line was the receipt: the
#      19 % VAT as all of the VAT. Now a line per rate (`taxLines`), the
#      totals their sums.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-459-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier739-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
row() { # description number net rate vat [category] [date]
  printf '{"description":"%s","invoiceDate":"%s","supplierName":"%s Markt","invoiceNumber":"%s","netAmount":"%s","vatRate":"%s","vatAmount":"%s"%s}' \
    "$1" "${7:-2026-09-14}" "$TAG" "$2" "$3" "$4" "$5" "${6:+,\"category\":\"$6\"}"
}
lines() { # invoiceNumber → "rate:net:vat …" of its expense
  q "SELECT string_agg(l.\"vatRate\"::numeric(5,2) || ':' || l.\"netAmount\"::numeric(12,2) || ':' || l.\"vatAmount\"::numeric(12,2), ' ' ORDER BY l.position)
       FROM \"Expense\" e JOIN \"ExpenseTaxLine\" l ON l.\"expenseId\" = e.id WHERE e.\"companyId\" = '$C' AND e.\"invoiceNumber\" = '$1';"
}

note "=== 1. CSV: the rows of one invoice are one expense ==="
ROWS="[$(row 'Lebensmittel' 'K-1' 100 0.07 7 'Bewirtung'),$(row 'Getränke' 'K-1' 50 0.19 9.50 'Bewirtung'),$(row 'Pfand' 'K-1' 10 0.19 1.90 'Bewirtung'),$(row 'Einzelposten' 'K-2' 20 0.19 3.80)]"
BODY_IMPORT="{\"rows\":$ROWS}"
AS POST "/api/v1/expenses/import?companyId=$C" "$BODY_IMPORT"
assert_eq "4 rows imported, no error; rows 2–4 booked together as K-1 (was: rows 3 and 4 refused as duplicates)" \
  "$(P "(d['imported'], d['errors'], [(m['rows'], m['invoiceNumber'], m['rates']) for m in d['merged']])")" "(4, [], [([2, 3, 4], 'K-1', [0.19, 0.07])])"
assert_eq "K-1: one expense, 160 + 18,40 = 178,40, its rate that of the largest line (7 %)" \
  "$(q "SELECT count(*), sum(\"netAmount\")::numeric(12,2), sum(\"vatAmount\")::numeric(12,2), sum(\"grossAmount\")::numeric(12,2), max(\"vatRate\")::numeric(5,2) FROM \"Expense\" WHERE \"companyId\"='$C' AND \"invoiceNumber\"='K-1';")" "1|160.00|18.40|178.40|0.07"
assert_eq "…a line per rate, the two 19 % rows added up" "$(lines K-1)" "0.19:60.00:11.40 0.07:100.00:7.00"
assert_eq "…its description names the rows, its category kept" \
  "$(q "SELECT description, category FROM \"Expense\" WHERE \"companyId\"='$C' AND \"invoiceNumber\"='K-1';")" "Lebensmittel / Getränke / Pfand|Bewirtung"
assert_eq "K-2, a row of its own: an expense without lines, as before" \
  "$(q "SELECT count(*), (SELECT count(*) FROM \"ExpenseTaxLine\" l JOIN \"Expense\" e2 ON e2.id=l.\"expenseId\" WHERE e2.\"invoiceNumber\"='K-2' AND e2.\"companyId\"='$C') FROM \"Expense\" WHERE \"companyId\"='$C' AND \"invoiceNumber\"='K-2';")" "1|0"

note "=== 2. what is still refused ==="
ROWS="[$(row 'Ware' 'K-3' 40 0.19 7.60),$(row 'Ware' 'K-3' 40 0.19 7.60)]"
BODY_IMPORT="{\"rows\":$ROWS}"
AS POST "/api/v1/expenses/import?companyId=$C" "$BODY_IMPORT"
assert_eq "a row repeated word for word: refused, the first imported (not 80 €)" \
  "$(P "(d['imported'], [e['row'] for e in d['errors']], 'wiederholt Zeile 2' in d['errors'][0]['error'])")/$(q "SELECT \"netAmount\"::numeric(12,2) FROM \"Expense\" WHERE \"companyId\"='$C' AND \"invoiceNumber\"='K-3';")" "(1, [3], True)/40.00"
ROWS="[$(row 'Buch' 'K-4' 20 0.07 1.40 'Fachliteratur'),$(row 'Papier' 'K-4' 10 0.19 1.90 'Bürobedarf')]"
BODY_IMPORT="{\"rows\":$ROWS}"
AS POST "/api/v1/expenses/import?companyId=$C" "$BODY_IMPORT"
assert_eq "two categories in one invoice: both rows refused, saying why" \
  "$(P "(d['imported'], [e['row'] for e in d['errors']], 'verschiedene Kategorien' in d['errors'][0]['error'])")/$(q "SELECT count(*) FROM \"Expense\" WHERE \"companyId\"='$C' AND \"invoiceNumber\"='K-4';")" "(0, [2, 3], True)/0"
ROWS="[$(row 'Nachlieferung' 'K-1' 5 0.07 0.35)]"
BODY_IMPORT="{\"rows\":$ROWS}"
AS POST "/api/v1/expenses/import?companyId=$C" "$BODY_IMPORT"
assert_eq "K-1 again in a later file: a duplicate of the booked invoice" "$(P "(d['imported'], [e['row'] for e in d['errors']])")" "(0, [2])"
ROWS="[$(row 'Gutschrift Lebensmittel' 'G-1' -10 0.07 -0.70),$(row 'Gutschrift Getränke' 'G-1' -20 0.19 -3.80)]"
BODY_IMPORT="{\"rows\":$ROWS}"
AS POST "/api/v1/expenses/import?companyId=$C" "$BODY_IMPORT"
assert_eq "a credit note in two rates: one expense, negative, with its lines" \
  "$(P "d['imported']")/$(q "SELECT \"grossAmount\"::numeric(12,2) FROM \"Expense\" WHERE \"companyId\"='$C' AND \"invoiceNumber\"='G-1';")/$(lines G-1)" "2/-34.50/0.19:-20.00:-3.80 0.07:-10.00:-0.70"

note "=== 3. the OCR proposal ==="
ocr() { AS GET "/api/v1/ocr/extract?text=$(python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$1")"; }
ocr $'Edeka Markt\nNetto 112,00\nMwSt 19% auf 100,00 EUR 19,00 EUR\nMwSt 7% auf 12,00 EUR 0,84 EUR\nGesamtbetrag: 131,84 EUR'
assert_eq "two rates with their bases: a line each, totals their sums (was: net 112, VAT 19,00 — the 7 % missing)" \
  "$(P "([(l['vatRate'], l['netAmount'], l['vatAmount']) for l in d['taxLines']], d['netAmount'], d['vatAmount'], d['grossAmount'])")" \
  "([(0.19, 100, 19), (0.07, 12, 0.84)], 112, 19.84, 131.84)"
ocr $'Buchhandlung\nUSt 19 %: 3,80\nUSt 7 %: 1,40\nGesamtbetrag: 45,20 EUR'
assert_eq "without the bases: the net from VAT and rate, made to add up with the gross" \
  "$(P "([(l['vatRate'], l['netAmount'], l['vatAmount']) for l in d['taxLines']], d['netAmount'], d['vatAmount'])")" "([(0.19, 20, 3.8), (0.07, 20, 1.4)], 40, 5.2)"
ocr $'Musterfirma GmbH\nZwischensumme netto: 100,00 EUR\nUSt 19%: 19,00 EUR\nGesamtbetrag: 119,00 EUR'
assert_eq "one rate: as before, no lines" "$(P "('taxLines' in d, d['netAmount'], d['vatRate'], d['vatAmount'])")" "(False, 100, 0.19, 19)"

summary
