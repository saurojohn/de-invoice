#!/bin/bash
# Tier 928 — the customer as on the day of issue
#
# The UStVA, the ZM, the OSS return and the DATEV export classify a sale by
# the customer's country and VAT id — read from the customer as it is today.
# Measured: a sale to a consumer in Paris (OSS, Kz 45), its month submitted;
# the customer moved to Köln — the month's return said Kz 35 / 36 (domestic
# tax). Likewise a business customer's new VAT id rewrote the ZM line.
# An invoice keeps both from the day it is issued (Invoice.customerCountry,
# customerVatId).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-615-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2})); Q=$(( (M - 1) / 3 + 1 ))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier928-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH in the OSS scheme" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll","ossVerfahren":true,"vatId":"DE811907980"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Marie Dupont 615","type":"individual","address":{"street":"Rue 2","city":"Paris","postalCode":"75001","country":"FR"}}'
FR=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Acme SARL 615","type":"business","vatId":"FR40303265045","address":{"street":"Rue 3","city":"Lyon","postalCode":"69001","country":"FR"}}'
B2B=$(json_field "$BODY" id)
issue() { # customer net rate extra
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\"${4:-},\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
kz() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"; P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}"; }
issue "$FR" 1000 0.2
assert_eq "a sale to a consumer in Paris, issued" "$STATUS" "200"
issue "$B2B" 500 0 ',"euTransaction":true'
assert_eq "an igL to a business in Lyon, issued" "$STATUS" "200"
BEFORE=$(kz)
AS GET "/api/v1/ustva/zm?companyId=$C&year=$Y&month=$M"
ZM_BEFORE=$(P "[(r['land'], r['ustIdNr'], r['betrag']) for r in d['rows']]")
AS GET "/api/v1/reports/oss?companyId=$C&year=$Y&quarter=$Q"
OSS_BEFORE=$(P "round(d['totals']['vatAmount'], 2)")
assert_eq "before: OSS 200 € French tax" "$OSS_BEFORE" "200"

note "=== the customers change afterwards ==="
AS PUT "/api/v1/customers/$FR?companyId=$C" '{"address":{"street":"Ring 1","city":"Köln","postalCode":"50667","country":"DE"}}'
assert_eq "the consumer moves to Köln" "$STATUS" "200"
AS PUT "/api/v1/customers/$B2B?companyId=$C" '{"vatId":"FR83404833048"}'
assert_eq "the business gets a new VAT id" "$STATUS" "200"
assert_eq "UStVA unchanged (was Kz 35 / 36, domestic tax)" "$(kz)" "$BEFORE"
AS GET "/api/v1/ustva/zm?companyId=$C&year=$Y&month=$M"
assert_eq "ZM unchanged: the VAT id of the day of the supply" "$(P "[(r['land'], r['ustIdNr'], r['betrag']) for r in d['rows']]")" "$ZM_BEFORE"
AS GET "/api/v1/reports/oss?companyId=$C&year=$Y&quarter=$Q"
assert_eq "OSS unchanged (was 0)" "$(P "round(d['totals']['vatAmount'], 2)")" "200"

note "=== a sale after the move is a domestic one ==="
issue "$FR" 100 0.19
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
assert_eq "Kz 81: the new sale's 100" "$(P "{k['kz']:k['value'] for k in d['kennzahlen'] if k.get('value')}.get('81', 0)")" "100"
assert_eq "…kept on it: DE" "$(q "select \"customerCountry\" from \"Invoice\" where id='$I'")" "DE"
assert_eq "a draft keeps nothing yet" "$(q "select count(*) from \"Invoice\" where \"companyId\"='$C' and status='draft' and \"customerCountry\" is not null")" "0"

summary
