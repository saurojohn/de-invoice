#!/bin/bash
# Tier 882 — an import reads a cell as a German spreadsheet writes it
#
# Found on the production images (the second walk), with the templates the
# import pages offer and a CSV as German Excel saves it:
#   - customers: „taxExempt = false“ stored a TAX-EXEMPT customer (`!!"false"`),
#     „type = private“ (the template's own example) a business — a consumer
#     then got the B2B interest and the 40 € flat fee —, „paymentTerms“ empty
#     30 days instead of the company's default, „abc“ 30 days, tags dropped;
#   - products: „1.234,56“ cost 1,234 €;
#   - expenses: a rent of „1.500,00“ net was 1,50 € with 0,29 € input VAT;
#   - the templates had no BOM, so Excel showed „MusterstraÃŸe“.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-574-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier882-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
errors() { python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d['imported'], ' | '.join(e['error'] for e in d['errors']))" "$BODY"; }

note "=== 1. customers: the values as a CSV gives them ==="
read -r -d '' CUST <<'JSON'
{"verifyVat":false,"rows":[
 {"name":"Nicht befreit GmbH","type":"business","street":"Weg 1","postalCode":"10115","city":"Berlin","country":"DE","email":"a@i574.example","paymentTerms":"14","taxExempt":"false","tags":"B2B, VIP"},
 {"name":"Befreit e.V.","type":"business","street":"Weg 2","postalCode":"10115","city":"Berlin","country":"DE","email":"b@i574.example","paymentTerms":"","taxExempt":"ja"},
 {"name":"Maria Mustermann","type":"private","street":"Musterstraße 7","postalCode":"80331","city":"München","country":"DE","email":"c@i574.example","taxExempt":""},
 {"name":"Unklar AG","type":"business","email":"d@i574.example","taxExempt":"vielleicht"},
 {"name":"Typ AG","type":"Behörde","email":"e@i574.example"},
 {"name":"Frist AG","type":"business","email":"f@i574.example","paymentTerms":"abc"}
]}
JSON
AS POST "/api/v1/customers/import?companyId=$C" "$CUST"
assert_eq "3 imported; the three unreadable rows reported, not guessed" "$STATUS $(errors)" \
  "201 3 Steuerbefreit „vielleicht“ — bitte ja/nein oder true/false | Kundentyp „Behörde“ unbekannt — „business“ (Firma) oder „individual“ (Privat) | Zahlungsfrist „abc“ — ganze Tage von 0 bis 365, leer für den Firmenstandard"
assert_eq "„taxExempt = false“: NOT tax-exempt (was: tax-exempt)" "$(q "select \"taxExempt\" from \"Customer\" where \"companyId\"='$C' and name='Nicht befreit GmbH'")" "f"
assert_eq "„ja“: tax-exempt" "$(q "select \"taxExempt\" from \"Customer\" where \"companyId\"='$C' and name='Befreit e.V.'")" "t"
assert_eq "„private“: a consumer (was: business)" "$(q "select type from \"Customer\" where \"companyId\"='$C' and name='Maria Mustermann'")" "individual"
assert_eq "payment terms: 14 as given; empty → the company's default (was: 30)" \
  "$(q "select coalesce(\"paymentTerms\"::text,'null') from \"Customer\" where \"companyId\"='$C' and name in ('Nicht befreit GmbH','Befreit e.V.') order by name desc")" "$(printf '14\nnull')"
assert_eq "tags from one cell (were dropped)" "$(q "select array_to_string(tags, '|') from \"Customer\" where \"companyId\"='$C' and name='Nicht befreit GmbH'")" "B2B|VIP"

note "=== 2. products: German amounts and rates ==="
read -r -d '' PROD <<'JSON'
{"rows":[
 {"name":"Maschine","sku":"I574-1","type":"good","unit":"piece","basePrice":"1.234,56","vatRate":"19 %"},
 {"name":"Buch","sku":"I574-2","type":"good","unit":"piece","basePrice":"19.99","vatRate":"0,07"},
 {"name":"Unklar","sku":"I574-3","type":"good","unit":"piece","basePrice":"1.500","vatRate":"19"}
]}
JSON
AS POST "/api/v1/products/import?companyId=$C" "$PROD"
assert_eq "2 imported; „1.500“ (1 500 or 1,5?) reported" "$STATUS $(errors)" "201 2 Ungültiger Preis: „1.500“ ist mehrdeutig (1500 oder 1,5?) — bitte ohne Tausenderpunkt oder mit Komma schreiben"
assert_eq "„1.234,56“ / „19 %“ → 1234.56 / 0.19 (was: 1.234); „19.99“ / „0,07“ as the template writes it" \
  "$(q "select name||'='||\"basePrice\"::numeric(12,2)||'/'||\"vatRate\"::numeric(5,2) from \"Product\" where \"companyId\"='$C' order by name")" "$(printf 'Buch=19.99/0.07\nMaschine=1234.56/0.19')"

note "=== 3. expenses: a rent of 1.500,00 ==="
read -r -d '' EXP <<'JSON'
{"rows":[
 {"description":"Miete November","invoiceDate":"02.11.2026","invoiceNumber":"M-574","supplierName":"Vermieter 574 GmbH","netAmount":"1.500,00","vatRate":"19 %","vatAmount":"285,00","grossAmount":"1.785,00","category":"Miete"}
]}
JSON
AS POST "/api/v1/expenses/import?companyId=$C" "$EXP"
assert_eq "imported" "$STATUS $(errors)" "201 1 "
assert_eq "net / VAT / gross 1500 / 285 / 1785 (was: 1,50 / 0,29 / 1,79)" \
  "$(q "select \"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2)||'/'||\"grossAmount\"::numeric(12,2) from \"Expense\" where \"companyId\"='$C'")" "1500.00/285.00/1785.00"

note "=== 4. the templates open in Excel ==="
for kind in customers products expenses; do
  BOM=$(curl -sS "$API/api/v1/$kind/import/template.csv?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" | head -c 3 | xxd -p)
  assert_eq "$kind template starts with the UTF-8 BOM" "$BOM" "efbbbf"
done
summary
