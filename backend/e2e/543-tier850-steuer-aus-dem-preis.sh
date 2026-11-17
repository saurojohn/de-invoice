#!/bin/bash
# Tier 850 — an invoice issued without USt on a day the Kleinunternehmer-
# regelung does not cover owes the tax out of its price, and the reports say so.
#
# Measured before (Tier 849): a § 19 invoice of 1 190 € of August, the end of
# the regulation then set back to 30.06. (Tier 843's advice once last year was
# over 25 000 €): UStVA 08 — 1 190 € of „sonstige steuerfreie Umsätze“, no
# tax; EÜR — 1 190 € on 4170; DATEV — 8195 without a key; GuV — 1 190 € of
# revenue. The 190 € owed were in no return. Now the reports take the tax out
# of the total at 19 % until the invoice is corrected; its Storno takes it back.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
Y=$(TZ=Europe/Berlin date +%Y); P=$((Y - 1)); M=$(TZ=Europe/Berlin date +%-m); TODAY=$(TZ=Europe/Berlin date +%F)
TAG="e2e-543-$(date +%s%N | cut -c1-13)"
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier850-e2e\",\"companyName\":\"$TAG KU\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; q="companyId=$C"
AS PUT "/api/v1/companies/$C?$q" '{"defaultVatMode":"kleinunternehmer","rechtsform":"Einzelunternehmen","besteuerungsart":"soll"}'
assert_status 200 "fixture: a Kleinunternehmer (Soll)"
AS POST "/api/v1/customers?$q" '{"name":"Kunde 543 GmbH","type":"business","address":{"street":"S 9","postalCode":"10115","city":"Berlin","country":"DE"}}'; K=$(json_field "$BODY" id)
B="{\"customerId\":\"$K\",\"issueDate\":\"$P-08-03\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1190,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?$q" "$B"; I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$I/status?$q" '{"status":"sent"}'
assert_status 200 "fixture: a § 19 invoice of 1 190 € of 03.08.$P"
PAY="{\"amount\":1190,\"paymentDate\":\"$P-08-10\",\"paymentMethod\":\"bank_transfer\"}"
AS POST "/api/v1/invoices/$I/payments?$q" "$PAY"
assert_status 201 "fixture: …paid on 10.08."

ustva() { # year month → "Kz=value …" of the Kennzahlen that are not 0
  AS GET "/api/v1/ustva/compute?$q&year=$1&month=$2"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(' '.join('%s=%s' % (k['kz'], k['value']) for k in d.get('kennzahlen', []) if k.get('value')) or '-')"
}
euer() { AS GET "/api/v1/accounting/euer?$q&year=$1"; echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(' '.join('%s=%s' % (l['kennziffer'], l['amount']) for l in sorted(d['einnahmen'], key=lambda l: l['kennziffer']) if l['amount']) or '-')"; }
datev() { # from to → "Gegenkonto/BU" of the invoice's revenue row
  curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?$q&startDate=$1&endDate=$2" \
    | iconv -f latin1 -t utf-8 | awk -F';' -v n="\"$3\"" '$11 == n && $8 ~ /^8/ { gsub(/"/, "", $9); print $8 "/" ($9 == "" ? "-" : $9) }' | head -1
}
guv() { AS GET "/api/v1/accounting/guv?$q&year=$1"; echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['totals']['umsatzerloese'])"; }

note "=== 1. while it is a § 19 invoice ==="
assert_eq "UStVA 08/$P: in no line" "$(ustva "$P" 8)" "-"
assert_eq "EÜR $P: 1 190 on 4120" "$(euer "$P")" "4120=1190"

note "=== 2. the end of the regulation set back to 30.06.$P ==="
SWITCH="{\"defaultVatMode\":\"standard\",\"kleinunternehmerBis\":\"$P-06-30\"}"
AS PUT "/api/v1/companies/$C?$q" "$SWITCH"
assert_status 200 "Umsatzsteuer from 01.07.$P"
assert_eq "UStVA 08/$P: 1 000 € taxed at 19 %, 190 € tax (was: 1 190 € „sonstige steuerfreie Umsätze“, no tax)" "$(ustva "$P" 8)" "81=1000 83=190"
assert_eq "EÜR $P: 1 000 on 4100, the 190 € received on 4140 (was: 1 190 on 4170)" "$(euer "$P")" "4100=1000 4140=190"
assert_eq "DATEV: the 19 % revenue account with its tax key (was: 8195 without one)" "$(datev "$P-08-01" "$P-08-31" "$N")" "8400/3"
assert_eq "GuV $P: 1 000 € of revenue (was: 1 190)" "$(guv "$P")" "1000"
assert_eq "the invoice itself is as issued: no tax stated, 1 190 €" \
  "$(PSQL "select \"totalVat\"::numeric(12,2)||' '||total::numeric(12,2)||' '||\"taxOutOfPrice\"::numeric(5,2) from \"Invoice\" where id='$I'")" "0.00 1190.00 0.19"
AS GET "/api/v1/accounting/kleinunternehmer-status?$q"
assert_eq "…and it is still listed for correction" "$(echo "$BODY" | python3 -c "import sys,json;print([r['invoiceNumber'] for r in json.load(sys.stdin)['ohneUmsatzsteuer']['rechnungen']])")" "['$N']"

note "=== 3. its Storno takes the tax back ==="
AS POST "/api/v1/invoices/$I/credit-note?$q" '{"reason":"Storno"}'
assert_status 201 "the Storno credit note"
CN=$(json_field "$BODY" id)
assert_eq "…carries the rate of its invoice" "$(PSQL "select \"taxOutOfPrice\"::numeric(5,2) from \"Invoice\" where id='$CN'")" "0.19"
assert_eq "UStVA $M/$Y: −1 000 € at 19 %, −190 € tax (§ 17 UStG)" "$(ustva "$Y" "$M")" "81=-1000 83=-190"
assert_eq "UStVA 08/$P unchanged" "$(ustva "$P" 8)" "81=1000 83=190"

note "=== 4. the end moved back again: the invoice is a § 19 one once more ==="
SWITCH="{\"kleinunternehmerBis\":\"$P-12-31\"}"
AS PUT "/api/v1/companies/$C?$q" "$SWITCH"
assert_status 200 "Kleinunternehmer up to 31.12.$P"
assert_eq "the rate is cleared on the invoice and its credit note" \
  "$(PSQL "select count(*) from \"Invoice\" where \"companyId\"='$C' and \"taxOutOfPrice\" is not null")" "0"
assert_eq "UStVA 08/$P: in no line again" "$(ustva "$P" 8)" "-"
assert_eq "EÜR $P: 1 190 on 4120 again" "$(euer "$P")" "4120=1190"

note "=== 5. the rate is the system's, never a request's ==="
B="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"taxOutOfPrice\":0.19,\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?$q" "$B"
assert_status 400 "an invoice sent with taxOutOfPrice is refused"
summary
