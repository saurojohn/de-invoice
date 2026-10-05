#!/bin/bash
# Tier 520 — the stock follows the issued invoice, and only its own company's
#
# Measured before, a tracked product with 10 in stock:
#   - a *draft* over 3 took 3 (7); changing the draft to 1 left 7; deleting
#     the draft left 7; an invoice issued and cancelled left its 3 taken;
#   - selling 50 of 1 set the stock to 0 while the history said "sale 50";
#   - another company's invoice with this product's id was created (201),
#     reduced this company's stock, and its stock warning showed the
#     product's name and quantity.
#
# Now: a draft takes nothing; the goods leave when the invoice is issued,
# follow an edit of its lines, and come back when it is cancelled or deleted;
# stock may go below 0 (oversold, and by how much); a product id of another
# company is refused. A credit note does not move stock.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-305-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C K
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier520-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
  K=$(json_field "$BODY" id)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
TODAY=$(date +%Y-%m-%d)
company A
[[ -n "${C:-}" && -n "${K:-}" ]] && pass "fixture: company A" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/products?companyId=$C" "{\"name\":\"$TAG Gürtel\",\"basePrice\":50,\"vatRate\":0.19,\"trackInventory\":true,\"stockQuantity\":10}"
PR=$(json_field "$BODY" id)
stock() { q "select trim(trailing '.' from trim(trailing '0' from \"stockQuantity\"::text)) from \"Product\" where id='$PR'"; }
line() { echo "{\"productId\":\"$PR\",\"description\":\"Gürtel\",\"quantity\":$1,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}"; }
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[$1]}"; I=$(json_field "$BODY" id); }
status() { AS PUT "/api/v1/invoices/$I/status?companyId=$C" "{\"status\":\"$1\"}"; }
assert_eq "fixture: 10 in stock" "$(stock)" "10"

note "=== a draft takes nothing ==="
inv "$(line 3)"
assert_eq "a draft over 3: still 10 (was 7)" "$(stock)" "10"
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"items\":[$(line 1)]}"
assert_eq "…changed to 1: 10" "$(stock)" "10"
AS DELETE "/api/v1/invoices/$I?companyId=$C"
assert_eq "…deleted: 10 (was 7)" "$STATUS/$(stock)" "200/10"

note "=== issued, edited, cancelled ==="
inv "$(line 3)"; status sent
assert_eq "issued over 3: 7" "$STATUS/$(stock)" "200/7"
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"items\":[$(line 5)]}"
assert_eq "edited on its day to 5: 5 (was 7)" "$STATUS/$(stock)" "200/5"
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"items\":[$(line 2),$(line 2)]}"
assert_eq "…to two lines of 2: 6" "$(stock)" "6"
status cancelled
assert_eq "cancelled: 10 again (was 7)" "$STATUS/$(stock)" "200/10"
assert_eq "…the history says what came back" "$(q "select string_agg(\"changeType\"||' '||trim(trailing '.' from trim(trailing '0' from quantity::text)), ', ' order by \"createdAt\") from \"ProductStockHistory\" where reference='$I'")" "sale 3, sale 2, return 1, return 4"
status cancelled
assert_eq "cancelling twice returns nothing twice" "$(stock)" "10"

note "=== issued and deleted on its day ==="
inv "$(line 4)"; status sent
assert_eq "issued over 4: 6" "$(stock)" "6"
AS DELETE "/api/v1/invoices/$I?companyId=$C"
assert_eq "deleted: 10" "$STATUS/$(stock)" "200/10"

note "=== more than there is ==="
inv "$(line 50)"
assert_eq "the draft warns" "$(P "d['stockWarnings'][0]['available']")/$(P "d['stockWarnings'][0]['required']")" "10/50"
status sent
assert_eq "issued over 50: −40 (was 0)" "$(stock)" "-40"
status cancelled
assert_eq "cancelled: 10" "$(stock)" "10"

note "=== a credit note does not move stock ==="
inv "$(line 3)"; status sent
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"reason":"Preisnachlass"}'
assert_eq "credit note created" "$STATUS" "201"
assert_eq "…the stock stays at 7" "$(stock)" "7"

note "=== a draft from before this tier (stock taken at creation) ==="
inv "$(line 2)"
q "update \"Product\" set \"stockQuantity\"=5 where id='$PR'; insert into \"ProductStockHistory\"(id,\"productId\",\"changeType\",quantity,\"previousQty\",\"newQty\",reference,\"referenceType\") values (gen_random_uuid(),'$PR','sale',2,7,5,'$I','invoice')" >/dev/null
status sent
assert_eq "issuing it takes nothing a second time" "$(stock)" "5"

note "=== another company ==="
UA=$U; CA=$C
company B
inv "$(line 4)"
assert_eq "B's invoice with A's product: 400 (was 201)" "$STATUS" "400"
assert_eq "…A's stock untouched (was reduced)" "$(stock)" "5"
assert_eq "…and nothing about the product in the answer" "$(echo "$BODY" | grep -c "Gürtel")" "0"
inv "{\"description\":\"eigene Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}"
assert_eq "B's own draft" "$STATUS" "201"
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"items\":[$(line 4)]}"
assert_eq "…edited to A's product: 400 (was 200)" "$STATUS" "400"
assert_eq "…no line of B points at A's product" "$(q "select count(*) from \"InvoiceItem\" it join \"Invoice\" i on i.id=it.\"invoiceId\" where i.\"companyId\"='$C' and it.\"productId\"='$PR'")" "0"

summary
