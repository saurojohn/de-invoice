#!/bin/bash
# Tier 487 — an igL or § 13b invoice charges no VAT
#
# Measured before: an invoice marked igL (euTransaction) and one marked § 13b
# (reverseCharge), each with a 1 000 € line at 19 % — as an API caller or an
# import sends it; the form sets 0 % itself — went out at 1 190 € with
# "USt 19 %: 190,00". VAT shown on an invoice is owed (§ 14c UStG), and the
# UStVA declared 380 € output tax for supplies that are tax-free / the
# customer's to tax. As for a Kleinunternehmer (Tier 480), the lines are
# put at 0 % — also on an update and when the flag is the company default.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-273-$(date +%s%N | cut -c1-13)"
TODAY=$(python3 -c "import datetime, zoneinfo;print(datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier487-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111111
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"FR Kunde","type":"business","vatId":"FR12345678901","address":{"street":"Rue 1","postalCode":"75001","city":"Paris","country":"FR"}}'; FR=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Bau GmbH","type":"business","vatId":"DE123456789","address":{"street":"Bauweg 1","postalCode":"50667","city":"Köln","country":"DE"}}'; DE=$(json_field "$BODY" id)
inv() { # customer flagjson date
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$3\",$2\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
}
vat() { P "'%g/%g' % (float(d['totalVat']), float(d['total']))"; }

inv "$FR" '"euTransaction":true,' 2026-09-01; I1=$(json_field "$BODY" id)
assert_eq "igL with a 19 % line: no VAT (was 190 / 1190)" "$(vat)" "0/1000"
inv "$DE" '"reverseCharge":true,' 2026-09-01; I2=$(json_field "$BODY" id)
assert_eq "§ 13b with a 19 % line: no VAT (was 190 / 1190)" "$(vat)" "0/1000"
for i in $I1 $I2; do AS PUT "/api/v1/invoices/$i/status?companyId=$C" '{"status":"sent"}'; done
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=9"
assert_eq "UStVA: no output tax (was 380)" "$(P "d['umsatzsteuer']")" "0"
assert_eq "…the igL in Kz 41" "$(P "d['igL']")" "1000"

note "=== update and company default ==="
inv "$DE" '"reverseCharge":true,' "$TODAY"; I3=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I3?companyId=$C" '{"items":[{"description":"Leistung","quantity":2,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'
assert_eq "an update of a § 13b invoice stays without VAT" "$(vat)" "0/2000"
AS PUT "/api/v1/companies/$C" '{"defaultVatMode":"reverseCharge"}'
inv "$DE" '' 2026-09-02
assert_eq "§ 13b from the company default: no VAT" "$(P "'%s %g' % (d['reverseCharge'], float(d['totalVat']))")" "True 0"
AS PUT "/api/v1/companies/$C" '{"defaultVatMode":"standard"}'
inv "$DE" '' 2026-09-02
assert_eq "a standard invoice keeps its 19 %" "$(vat)" "190/1190"

summary
