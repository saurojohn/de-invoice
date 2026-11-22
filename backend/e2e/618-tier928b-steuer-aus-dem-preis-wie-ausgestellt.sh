#!/bin/bash
# Tier 928b — the tax out of the price (Tier 850) by the customer as on the day of issue
#
# Tier 928 kept the customer's country and VAT id on an issued invoice for the
# returns. The check that finds invoices issued without VAT on a day § 19 no
# longer covers (taxOutOfPrice, refreshed when the Kleinunternehmer period
# changes) read the customer as it is: an export to a customer in Boston,
# exempt from nothing — once the customer moved to Köln, the next refresh
# called it a domestic sale owing its tax out of the price.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-618-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier928b-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Boston Inc 618","type":"business","address":{"street":"Main St 1","postalCode":"02108","city":"Boston","country":"US"}}'
K=$(json_field "$BODY" id)
# an export, invoiced without VAT
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "an export to Boston, issued" "$STATUS" "200"
AS PUT "/api/v1/customers/$K?companyId=$C" '{"address":{"street":"Ring 1","postalCode":"50667","city":"Köln","country":"DE"}}'
assert_eq "the customer moves to Köln" "$STATUS" "200"
# a change of the Kleinunternehmer setting refreshes taxOutOfPrice for the company's invoices
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer"}'
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"standard"}'
assert_eq "the export owes no tax out of its price (was 0.1900, as a domestic sale)" "$(q "select coalesce(\"taxOutOfPrice\"::text, 'none') from \"Invoice\" where id='$I'")" "none"

summary
