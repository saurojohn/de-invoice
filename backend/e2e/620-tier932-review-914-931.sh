#!/bin/bash
# Tier 932 — what the review of Tiers 914–931 found
#
# 1. Tier 915: a change of the Gewinnermittlung planned for next year was
#    pulled into this year by the next save of the settings page (it sends the
#    whole form): wechsel [{2027,bilanz}] → [] and this year by Bilanz.
# 2. Tier 917: the first UStVA rhythm set — for next year — was stored as the
#    single value, every year's: this year's deadlines changed at once.
# 3. Tier 921: the Mindest-Ist lock also refused a payment that carries no VAT
#    (a Kleinunternehmer's advance invoice) in a submitted month.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-620-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2})); NY=$((Y + 1))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company() {
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier932-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 620","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
  K=$(json_field "$BODY" id)
}

note "=== 1. a switch planned for next year survives the next save of the settings ==="
company a
[[ -n "${C:-}" ]] && pass "fixture: a sole trader" || { fail "register"; summary; exit 1; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","gewinnermittlung":"euer"}'
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"gewinnermittlung\":\"bilanz\",\"gewinnermittlungAb\":$NY}"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"phone":"+49 221 123456","gewinnermittlung":"bilanz"}'
assert_eq "an unrelated save: the switch stays planned for $NY (was gone)" "$(q "select settings->'gewinnermittlungWechsel' from \"Company\" where id='$C'")" "[{\"ab\": $NY, \"art\": \"bilanz\", \"vorher\": \"euer\"}]"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
assert_eq "…$Y stays an EÜR (was bilanz)" "$(P "d['gewinnermittlung']")" "euer"

note "=== 2. the first rhythm set, for next year only ==="
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" "{\"ustvaRhythmus\":\"quarterly\",\"year\":$NY}"
assert_eq "stored for $NY only (was the single value)" "$(q "select coalesce(settings->>'ustvaRhythmus','-'), settings->'ustvaRhythmusAb' from \"Company\" where id='$C'")" "-|{\"$NY\": \"quarterly\"}"
assert_eq "…this year's rhythm as the books say (not quarterly)" "$(P "(d['rhythm'], d['rhythmNextYear'])")" "('monthly', 'quarterly')"

note "=== 3. a Kleinunternehmer's advance payment in a submitted month ==="
company b
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","defaultVatMode":"kleinunternehmer"}'
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$NY-01-05\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":100,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "the payment, which carries no VAT: 201 (was 400)" "$STATUS" "201"

summary
