#!/bin/bash
# Tier 962 — the § 19 limit when an invoice is issued
#
# Issuing checks whether the year's Gesamtumsatz passes 100 000 € (§ 19 Abs. 1
# UStG). It added the invoice's net BEFORE its document discount, and a final
# invoice in full although its Proforma's advance was already in the revenue.
# Measured: 95 000 € received, then 6 000 € less 20 % (4 800 €) — refused
# (99 800 €); a final invoice of 60 000 € after 50 000 € received on its
# Proforma — refused, checked as 110 000 €.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-649-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}

company() {
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier962-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","defaultVatMode":"kleinunternehmer"}'
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
  K=$(json_field "$BODY" id)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
doc() { # type date net [extra json] → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"type\":\"$1\",\"customerId\":\"$K\",\"issueDate\":\"$2\",\"deliveryDate\":\"$2\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$3,\"vatRate\":0}]${4:+,$4}}"
  I=$(json_field "$BODY" id)
}
sent() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"sent"}'; }

note "=== the document discount ==="
company Rabatt
[[ -n "${C:-}" ]] && pass "fixture: a Kleinunternehmer" || { fail "register"; summary; exit 1; }
doc INV "$Y-01-02" 95000; sent "$I"
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":95000,\"paymentDate\":\"$Y-01-20\",\"paymentMethod\":\"bank_transfer\"}"
doc INV "$TODAY" 6000 '"discountPercent":20'; sent "$I"
assert_eq "95 000 € received, an invoice of 6 000 € less 20 % (4 800 €): issued (was refused at 99 800 €)" "$STATUS" "200"

note "=== a final invoice after an advance ==="
company Schluss
doc PI "$Y-01-03" 60000; PI=$I; sent "$PI"
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" "{\"amount\":50000,\"paymentDate\":\"$Y-01-10\",\"paymentMethod\":\"bank_transfer\"}"
AS POST "/api/v1/invoices/$PI/final-invoice?companyId=$C" "{\"issueDate\":\"$TODAY\"}"
FI=$(json_field "$BODY" id)
sent "$FI"
assert_eq "50 000 € received on the Proforma, its final invoice of 60 000 €: issued (was refused as 110 000 €)" "$STATUS" "200"
doc INV "$TODAY" 51000; sent "$I"
assert_eq "…another 51 000 € would pass the limit (50 000 received + 51 000): refused" "$STATUS" "400"

summary
