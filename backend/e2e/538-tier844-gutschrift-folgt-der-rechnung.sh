#!/bin/bash
# Tier 844 — a credit note follows the invoice it corrects.
#
# Measured before:
#  - a Kleinunternehmer's paid 1 000 € invoice cancelled (Storno): the EÜR,
#    Anlage S and Anlage G kept the § 19 line at 1 400 € and showed −1 000 €
#    on the taxed line (400 € on the § 19 line is what he received). Every
#    refund reduced the taxed line, whatever the invoice was — a tax-free
#    one too;
#  - a § 19 invoice credited after the regulation had ended: the credit note
#    was judged on its own date — −1 000 € of „sonstige steuerfreie Umsätze“
#    in the UStVA, a tax-free account in DATEV, „Steuerbefreite Leistung“ in
#    its e-invoice;
#  - a taxed invoice credited by a company that has become a Kleinunternehmer:
#    the EÜR left the refunded 190 € USt out;
#  - Tier 843 refused an invoice entered again from its kept copy after a
#    restore, because of the revenue received since.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
OP_U=$USER_ID; OP_C=$COMPANY_ID
Y=$(TZ=Europe/Berlin date +%Y); P=$((Y - 1)); M=$(TZ=Europe/Berlin date +%-m); TODAY=$(TZ=Europe/Berlin date +%F)
TAG="e2e-538-$(date +%s%N | cut -c1-13)"
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
company() { # tag mode → U C K
  local reg="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier844-e2e\",\"companyName\":\"$TAG $1\"}"
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$reg" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
  fixture_issuer "$C"
  local co="{\"defaultVatMode\":\"$2\",\"rechtsform\":\"Einzelunternehmen\",\"besteuerungsart\":\"soll\",\"phone\":\"+49 30 1\",\"email\":\"info@t538.example.test\",\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
  AS PUT "/api/v1/companies/$C?companyId=$C" "$co"
  assert_status 200 "fixture: $1 ($2)"
  local cu='{"name":"Kunde 538 GmbH","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"},"contact":{"email":"ap@kunde538.example.test"}}'
  AS POST "/api/v1/customers?companyId=$C" "$cu"; K=$(json_field "$BODY" id)
}
paid() { # date net rate [notes] → I N
  local b="{\"customerId\":\"$K\",\"issueDate\":\"$1\"${4:+,\"notes\":\"$4\"},\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  AS POST "/api/v1/invoices?companyId=$C" "$b"; I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber); local t; t=$(json_field "$BODY" total)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  assert_status 200 "fixture: $2 € issued on $1"
  local pay="{\"amount\":$t,\"paymentDate\":\"$1\",\"paymentMethod\":\"bank_transfer\"}"
  AS POST "/api/v1/invoices/$I/payments?companyId=$C" "$pay"
  assert_status 201 "fixture: …and paid"
}
storno() { # invoice id → CN CNN
  AS POST "/api/v1/invoices/$1/credit-note?companyId=$C" '{"reason":"Storno"}'
  assert_status 201 "the Storno credit note"
  CN=$(json_field "$BODY" id); CNN=$(json_field "$BODY" invoiceNumber)
}
lines() { # report year → [(kz, amount)] of the income lines that are not 0
  AS GET "/api/v1/accounting/$1?companyId=$C&year=$2"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(sorted((l['kennziffer'], round(float(l['amount']), 2)) for l in d['einnahmen'] if round(float(l['amount']), 2)))"
}
ustva() { # year month → the amounts that are not 0
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print({k: v for k, v in d.items() if isinstance(v, (int, float)) and not isinstance(v, bool) and v and k not in ('year', 'month')})"
}
konto() { # from to Belegfeld 1 → the Gegenkonto of that row in the DATEV export
  curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$1&endDate=$2" \
    | iconv -f latin1 -t utf-8 | awk -F';' -v n="\"$3\"" '$11 == n { print $8 }' | head -1
}
reason() { curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$1/xrechnung?companyId=$C" | python3 -c "import re,sys;print(' | '.join(re.findall(r'<cbc:TaxExemptionReason>([^<]*)<', sys.stdin.read())))"; }

note "=== 1. a Kleinunternehmer cancels a paid invoice ==="
company ku kleinunternehmer
paid "$TODAY" 1000 0.19; A=$I
paid "$TODAY" 400 0.19
assert_eq "before: 1 400 € of § 19 revenue" "$(lines euer "$Y")" "[('4120', 1400.0)]"
storno "$A"
assert_eq "EÜR: 400 € on the § 19 line, nothing else (was: 4120 at 1 400 €, 4100 at −1 000 €)" "$(lines euer "$Y")" "[('4120', 400.0)]"
assert_eq "Anlage S: the same" "$(lines anlage-s "$Y")" "[('4120', 400.0)]"
assert_eq "Anlage G: 400 € on 2130 (was: 2130 at 1 400 €, 2110 at −1 000 €)" "$(lines anlage-g "$Y")" "[('2130', 400.0)]"

note "=== 2. a § 19 invoice of last year, the regulation ended 30.06.$P, cancelled today ==="
company ende kleinunternehmer
paid "$P-03-02" 1000 0.19; A=$I; AN=$N
SWITCH="{\"defaultVatMode\":\"standard\",\"kleinunternehmerBis\":\"$P-06-30\"}"
AS PUT "/api/v1/companies/$C?companyId=$C" "$SWITCH"
assert_status 200 "the regulation ended on 30.06.$P"
storno "$A"
assert_eq "UStVA $M/$Y: the credit note of a § 19 invoice is in no line (was: otherExempt −1 000)" "$(ustva "$Y" "$M")" "{}"
assert_eq "EÜR $Y: the refund on the § 19 line (was: 4100)" "$(lines euer "$Y")" "[('4120', -1000.0)]"
assert_eq "DATEV: the credit note on the account of its invoice" \
  "$(konto "$TODAY" "$TODAY" "$CNN")" "$(konto "$P-03-01" "$P-03-31" "$AN")"
assert_eq "its e-invoice names § 19, as its invoice's does (was: Steuerbefreite Leistung)" \
  "$(reason "$CN")" "Kleinunternehmer gemäß § 19 UStG — keine Umsatzsteuer"

note "=== 3. a 19 % invoice of last year, a Kleinunternehmer since 01.07.$P, cancelled today ==="
company wechsel standard
paid "$P-02-03" 1000 0.19; A=$I
SWITCH="{\"defaultVatMode\":\"kleinunternehmer\",\"kleinunternehmerAb\":\"$P-07-01\"}"
AS PUT "/api/v1/companies/$C?companyId=$C" "$SWITCH"
assert_status 200 "a Kleinunternehmer since 01.07.$P"
storno "$A"
assert_eq "UStVA $M/$Y: the tax taken back (§ 17 UStG)" "$(ustva "$Y" "$M")" "{'umsatzsteuer': -190, 'differenzbetrag': -190}"
assert_eq "EÜR $Y: the refund on the taxed line, with its USt (was: the 190 € left out)" "$(lines euer "$Y")" "[('4100', -1000.0), ('4140', -190.0)]"

note "=== 4. a regular company cancels a tax-free invoice ==="
company frei standard
paid "$TODAY" 1000 0 "Steuerfrei nach § 4 Nr. 21 UStG"; A=$I
paid "$TODAY" 500 0.19
assert_eq "before: 1 000 € tax-free, 500 € taxed" "$(lines euer "$Y")" "[('4100', 500.0), ('4140', 95.0), ('4170', 1000.0)]"
storno "$A"
assert_eq "EÜR: the tax-free line back to 0 (was: 4170 at 1 000 €, 4100 at −500 €)" "$(lines euer "$Y")" "[('4100', 500.0), ('4140', 95.0)]"
assert_eq "Anlage G: 500 € on 2110 (was: 2190 at 1 000 €, 2110 at −500 €)" \
  "$(lines anlage-g "$Y" | python3 -c "import sys,ast;print([x for x in ast.literal_eval(sys.stdin.read()) if x[0] in ('2110', '2190')])")" "[('2110', 500.0)]"

note "=== 5. an invoice a restore lost, entered again past the § 19 limit ==="
STORE="${STORAGE_PATH:-}"
case "$STORE" in ""|"$HOME/data/"*|/data/*) fail "this part needs a throwaway STORAGE_PATH (got „$STORE“)"; summary; exit 1 ;; esac
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
path() { PSQL "select \"pdfPath\" from \"Invoice\" where id='$1'"; }
# Y issues the copies: its 000001, then the 1 000 € invoice as 000002
company quelle kleinunternehmer
paid "$TODAY" 10 0.19
paid "$TODAY" 1000 0.19; SRC=$I
assert_eq "the copy to restore is 000002" "$N" "INV-$Y-000002"
SRC_PDF="$STORE/$(path "$SRC")"
# X: 99 500 € received, then a restore leaves that copy as X's 000002
company verlust kleinunternehmer
paid "$TODAY" 99500 0.19
XDIR="$STORE/$(dirname "$(path "$I")")"; T=$(date +%s000)
cp "$SRC_PDF" "$XDIR/$((T + 1))_INV-$Y-000002.pdf"; cp "${SRC_PDF%.pdf}.xrechnung.xml" "$XDIR/$((T + 1))_INV-$Y-000002.xrechnung.xml"
XU=$U; XC=$C
U=$OP_U; C=$OP_C; AS GET "/api/v1/admin/backups/status" # (the check, as at the start after a restore)
U=$XU; C=$XC
AS POST "/api/v1/invoices/retired-numbers/INV-$Y-000002/restore?companyId=$C" '{}'
assert_status 200 "the lost 1 000 € invoice is entered again at 99 500 € received (was: refused, „übersteigt der Gesamtumsatz“)"
R=$(json_field "$BODY" id)
AS GET "/api/v1/invoices/$R?companyId=$C"
assert_eq "…issued, under its number, without USt" \
  "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['invoiceNumber'], d['status'], float(d['totalVat']), float(d['total']))")" "INV-$Y-000002 sent 0.0 1000.0"
B="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?companyId=$C" "$B"; I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_status 400 "a new 1 000 € invoice is still refused (Tier 843)"
AS DELETE "/api/v1/invoices/$I?companyId=$C"
summary
