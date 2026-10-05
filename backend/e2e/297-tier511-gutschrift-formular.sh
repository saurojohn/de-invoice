#!/bin/bash
# Tier 511 — the invoice form's credit note, and unknown document types
#
# POST /invoices takes a type. Measured before:
#  - "FOO" was stored as it came — numbered as an INV and then in no report;
#  - type CN (the create form's credit note) took no reference at all, or a
#    draft / someone else's invoice, and any amount — −119 € of revenue with
#    no invoice behind it (§ 31 Abs. 5 UStDV);
#  - issuing such a draft credit note was only a status change: its invoice
#    stayed open in full although the revenue was taken back.
#
# Now: only INV / RCV / PI / CN; a CN needs an issued INV / RCV of the
# company, goes to that invoice's customer, stays within what the invoice has
# left to credit, and issuing it settles the invoice as the "Gutschrift"
# button does (a 'Gutschrift' payment, the rest as customer credit).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-297-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier511-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
customer() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"; json_field "$BODY" id; }
TODAY=$(date +%Y-%m-%d)
doc() { # extra-json net → STATUS / BODY
  AS POST "/api/v1/invoices?companyId=$C" "{\"issueDate\":\"$TODAY\"$1,\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
}
issue() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"sent"}'; }
KA=$(customer A); KB=$(customer B)
doc ",\"customerId\":\"$KA\"" 100; INV=$(json_field "$BODY" id); issue "$INV"      # 119 €
doc ",\"customerId\":\"$KA\"" 100; DRAFT=$(json_field "$BODY" id)

note "=== the document type ==="
doc ",\"customerId\":\"$KA\",\"type\":\"FOO\"" 100
assert_eq "an unknown type: 400 (was stored, numbered as an INV)" "$STATUS" "400"

note "=== a credit note needs its invoice ==="
doc ",\"customerId\":\"$KA\",\"type\":\"CN\"" 50
assert_eq "without a reference: 400 (was 201)" "$STATUS" "400"
doc ",\"type\":\"CN\",\"referenceInvoiceId\":\"$DRAFT\"" 50
assert_eq "referring to a draft: 400" "$STATUS" "400"
doc ",\"type\":\"CN\",\"referenceInvoiceId\":\"00000000-0000-0000-0000-000000000000\"" 50
assert_eq "referring to no invoice of this company: 400" "$STATUS" "400"
doc ",\"type\":\"CN\",\"referenceInvoiceId\":\"$INV\"" 200
assert_eq "more than the invoice (238 € on 119 €): 400" "$STATUS" "400"
doc ",\"customerId\":\"$KB\",\"type\":\"CN\",\"referenceInvoiceId\":\"$INV\"" 50
assert_eq "a valid one is a draft" "$STATUS" "201"
CN=$(json_field "$BODY" id)
assert_eq "…for the invoice's customer, whatever was sent" "$(q "select \"customerId\" from \"Invoice\" where id='$CN'")" "$KA"

note "=== issuing it settles the invoice ==="
issue "$CN"
assert_eq "issued" "$STATUS" "200"
assert_eq "a 'Gutschrift' of 59,50 € on the invoice (was nothing)" \
  "$(q "select coalesce(sum(amount),0)::numeric(12,2) from \"Payment\" where \"invoiceId\"='$INV' and \"paymentMethod\"='Gutschrift'")" "59.50"
assert_eq "…which stays open for the other 59,50 €" "$(q "select status from \"Invoice\" where id='$INV'")" "sent"
doc ",\"type\":\"CN\",\"referenceInvoiceId\":\"$INV\"" 60
assert_eq "a second one over the rest (71,40 € on 59,50 €): 400" "$STATUS" "400"
doc ",\"type\":\"CN\",\"referenceInvoiceId\":\"$INV\"" 50; CN2=$(json_field "$BODY" id); issue "$CN2"
assert_eq "the rest credited: the invoice is settled" "$(q "select status from \"Invoice\" where id='$INV'")" "paid"

note "=== a credit note on a paid invoice becomes customer credit ==="
doc ",\"customerId\":\"$KB\"" 100; PAID=$(json_field "$BODY" id); issue "$PAID"
AS POST "/api/v1/invoices/$PAID/payments?companyId=$C" "{\"amount\":119,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
doc ",\"type\":\"CN\",\"referenceInvoiceId\":\"$PAID\"" 100; CN3=$(json_field "$BODY" id); issue "$CN3"
assert_eq "issued" "$STATUS" "200"
assert_eq "119 € of credit for the customer" "$(q "select coalesce(sum(amount),0)::numeric(12,2) from \"CustomerCreditTransaction\" where \"customerId\"='$KB'")" "119.00"

summary
