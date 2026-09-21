#!/bin/bash
# Tier 417 — the UStVA puts each amount on its line, under the official Kennzahl
#
# Measured before, in one month:
#   § 13b sale to a German customer (1 000)      → "sonstige steuerfreie Umsätze", not Kz 60
#   B2B service to an Austrian company (500)     → counted as igL
#   igL 300 with a 100 refund                    → igL 800 (the 0 % credit note never subtracted)
#   § 13b purchase 2 000 + igE 400               → 456 € tax owed, 0 € deductible: Zahllast +456
#   input tax on a 16 % invoice                  → dropped
# and every Kennzahl in the UStVA / UStJA exports was invented — the amount
# payable went out as "Kz 81", which on the USt 1 A 2026 is the 19 % tax base.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-206-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); YEAR=$(date +%Y); MONTH=$(date +%-m)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier417-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"taxId":"123/456/78901"}'
cust() { AS POST "/api/v1/customers?companyId=$C" "$1"; json_field "$BODY" id; }
KDE=$(cust '{"name":"Bau GmbH","type":"business","vatId":"DE987654321","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}')
KAT=$(cust '{"name":"Wien GmbH","type":"business","vatId":"ATU12345678","address":{"street":"a","city":"Wien","postalCode":"1060","country":"AT"}}')
KFR=$(cust '{"name":"Paris SARL","type":"business","vatId":"FR12345678901","address":{"street":"a","city":"Paris","postalCode":"75001","country":"FR"}}')
sent() { # customer body → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\",$2}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
line() { echo "{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0}"; }
sent "$KDE" "\"reverseCharge\":true,\"items\":[$(line Bauleistung 1000)]" >/dev/null
sent "$KAT" "\"reverseCharge\":true,\"items\":[$(line Beratung 500)]" >/dev/null
IGL=$(sent "$KFR" "\"euTransaction\":true,\"items\":[$(line Ware 300)]")
AS POST "/api/v1/invoices/$IGL/credit-note?companyId=$C" '{"amount":100}'
expense() { AS POST "/api/v1/ustva/expenses?companyId=$C" "$1"; [[ "$STATUS" == 201 || "$STATUS" == 200 ]] || fail "expense: $STATUS $BODY"; }
expense "{\"description\":\"Subunternehmer Bau\",\"invoiceDate\":\"$TODAY\",\"netAmount\":2000,\"vatRate\":0.19,\"vatAmount\":0,\"grossAmount\":2000,\"isReverseCharge\":true}"
expense "{\"description\":\"Ware aus Irland\",\"invoiceDate\":\"$TODAY\",\"netAmount\":400,\"vatRate\":0.19,\"vatAmount\":0,\"grossAmount\":400,\"isIntraEU\":true}"
expense "{\"description\":\"Rechnung 2020 mit 16 %\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.16,\"vatAmount\":16,\"grossAmount\":116}"
pass "fixture: three sales, a refund, three purchases"

note "=== 1. zero-rated sales on their own lines ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
UV="$BODY"
F() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$UV" "$1"; }
assert_eq "§ 13b sale → reverseChargeSales (Kz 60)" "$(F "d['reverseChargeSales']")" "1000"
assert_eq "EU B2B service → euServicesSales (Kz 21), not igL" "$(F "d['euServicesSales']")" "500"
assert_eq "igL 300 − refund 100 = 200 (was 800)" "$(F "d['igL']")" "200"
assert_eq "nothing left in 'sonstige steuerfreie' (was 1000)" "$(F "d['otherExempt']")" "0"

note "=== 2. tax owed on purchases, and the same tax deducted ==="
assert_eq "§ 13b purchase: 2000 / 380 (Kz 84 / 85)" "$(F "'%s/%s' % (d['reverseChargeOther']['net'], d['reverseChargeOther']['vat'])")" "2000/380"
assert_eq "igE: 400 / 76 (Kz 89)" "$(F "'%s/%s' % (d['intraEuAcquisitions']['net'], d['intraEuAcquisitions']['vat'])")" "400/76"
assert_eq "Vorsteuer § 13b 380 (Kz 67; was 0)" "$(F "d['vorsteuer']['fromReverseCharge']")" "380"
assert_eq "Vorsteuer igE 76 (Kz 61; was 0)" "$(F "d['vorsteuer']['fromIgE']")" "76"
assert_eq "Vorsteuer at 16 % counted (was dropped)" "$(F "d['vorsteuer']['fromOther']")" "16"
assert_eq "Umsatzsteuer 456" "$(F "d['umsatzsteuer']")" "456"
assert_eq "Differenz −16 (was +456)" "$(F "d['differenzbetrag']")" "-16"

note "=== 3. the export writes the USt 1 A 2026 Kennzahlen ==="
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$UV")"
[[ "$STATUS" == 201 || "$STATUS" == 200 ]] && pass "filing saved with the new fields (DTO accepts them)" || fail "save filing: $STATUS $BODY"
FID=$(json_field "$BODY" id)
AS GET "/api/v1/ustva/filings/$FID/elster-xml?companyId=$C"
XML="$BODY"
KZ() { python3 -c "import re,sys;m=re.search(r'B-Kz%s=([+-]\d+)' % sys.argv[2], sys.argv[1]);print(int(m.group(1)) if m else '-')" "$XML" "$1"; }
assert_eq "Kz 060 = 1000,00 (§ 13b sales)" "$(KZ 060)" "100000"
assert_eq "Kz 021 = 500,00 (§ 18b)" "$(KZ 021)" "50000"
assert_eq "Kz 041 = 200,00 (igL)" "$(KZ 041)" "20000"
assert_eq "Kz 089 = 400,00 (igE 19 %)" "$(KZ 089)" "40000"
assert_eq "Kz 084 / 085 = 2000,00 / 380,00" "$(KZ 084)/$(KZ 085)" "200000/38000"
assert_eq "Kz 066 = 16,00 (Vorsteuer aus Rechnungen)" "$(KZ 066)" "1600"
assert_eq "Kz 061 = 76,00 / Kz 067 = 380,00" "$(KZ 061)/$(KZ 067)" "7600/38000"
assert_eq "Kz 083 = −16,00 (the amount payable; it went out as Kz 081)" "$(KZ 083)" "-1600"
assert_eq "no Kz 081 — there are no 19 % sales" "$(KZ 081)" "-"
AS GET "/api/v1/ustva/filings/$FID/elster-xml?companyId=$C&format=ascii"
grep -q "Keine amtliche Upload-Datei" <<<"$BODY" && pass "the list says it is not an ELSTER upload" || fail "list header"

note "=== 4. the UStJA carries the USt 2 A 2026 numbers ==="
AS GET "/api/v1/ustva/ustja?companyId=$C&year=$YEAR"
J() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);l=[x for x in d['lines'] if x['kennziffer']==sys.argv[2]];print(l[0].get(sys.argv[3]) if l else '-')" "$BODY" "$1" "$2"; }
assert_eq "Kz 209 = 1000 (§ 13b sales)" "$(J 209 net)" "1000"
assert_eq "Kz 721 = 500 (§ 18b)" "$(J 721 net)" "500"
assert_eq "Kz 877 / 878 = 2000 / 380" "$(J 877 net)/$(J 878 vat)" "2000/380"
assert_eq "Kz 467 = 380 (Vorsteuer § 13b)" "$(J 467 vat)" "380"
assert_eq "zahllast −16" "$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['totals']['zahllast'])" "$BODY")" "-16"

summary; exit $?
