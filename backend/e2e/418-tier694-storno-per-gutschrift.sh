#!/bin/bash
# Tier 694 — an issued invoice is cancelled by a Storno credit note
#
# The owner, 17.10.2026: „要改“. Measured before, an issued 1 190 € invoice of
# June, set to "cancelled" on the invoice page in October (200):
#   - it left the June UStVA (190 € output tax gone from a return that may be
#     filed already), and October showed nothing
#   - the customer kept the invoice stating 190 € tax and got no document —
#     the issuer owes that tax until the recipient has the correction
#     (§ 14c UStG), and the correction belongs to the month of the
#     cancellation (§ 17 UStG)
# Now the status "cancelled" is refused for an issued invoice (a draft is
# still cancelled by it); the invoice page's "Storniert" creates the Storno
# credit note over the full amount instead. When credit notes cover the whole
# invoice it is undone as the cancellation undid it: its goods come back to
# stock, its hours are open to be invoiced anew. A partial credit note (a
# reduction of the price) moves neither.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-418-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}; MONTH=$((10#${TODAY:5:2}))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier694-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
says() { grep -q "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }
ust() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; echo "$BODY" | python3 -c "import sys,json;print('%g' % json.load(sys.stdin)['umsatzsteuer'])"; }
status_of() { q "select status from \"Invoice\" where id='$1'"; }
setstatus() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" "{\"status\":\"$2\"}"; }
storno() { AS POST "/api/v1/invoices/$1/credit-note?companyId=$C" '{"reason":"Storno"}'; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/products?companyId=$C" "{\"name\":\"$TAG Gürtel\",\"basePrice\":50,\"vatRate\":0.19,\"trackInventory\":true,\"stockQuantity\":10}"
PR=$(json_field "$BODY" id)
stock() { q "select trim(trailing '.' from trim(trailing '0' from \"stockQuantity\"::text)) from \"Product\" where id='$PR'"; }

# a June invoice: 4 belts (200 €) and a 800 € service — 1 000 € net, 190 € tax
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\",\"items\":[{\"productId\":\"$PR\",\"description\":\"Gürtel\",\"quantity\":4,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19},{\"description\":\"Montage\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":800,\"vatRate\":0.19}]}"
INV=$(json_field "$BODY" id); setstatus "$INV" sent
assert_eq "fixture: issued in June — 6 belts left, June output tax 190" "$STATUS/$(stock)/$(ust 2026 6)" "200/6/190"
OCT_BEFORE=$(ust "$YEAR" "$MONTH")

note "=== 1. the status does not cancel an issued invoice ==="
setstatus "$INV" cancelled
assert_eq "status → cancelled: 400 (was 200)" "$STATUS" "400"
assert_eq "…the answer names the Stornorechnung and § 14c" "$(says Stornorechnung)/$(says '§ 14c')" "yes/yes"
assert_eq "…it stays issued, June keeps its tax, the belts stay sold (was: cancelled, 0, 10)" "$(status_of "$INV")/$(ust 2026 6)/$(stock)" "sent/190/6"

note "=== 2. a partial credit note moves nothing ==="
AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'; PART=$(json_field "$BODY" id)
assert_eq "a credit note over 119 €" "$STATUS" "201"
assert_eq "…the belts stay sold" "$(stock)" "6"

note "=== 3. the Storno credit note over the rest ==="
storno "$INV"; CN=$(json_field "$BODY" id)
assert_eq "the Storno credit note: 201" "$STATUS" "201"
assert_eq "…credit notes over the whole 1 190 €" "$(q "select sum(total) from \"Invoice\" where \"referenceInvoiceId\"='$INV' and type='CN' and status not in ('draft','cancelled')")" "-1190.0000"
assert_eq "…the belts are back: 10" "$(stock)" "10"
assert_eq "…June keeps its tax (the return may be filed)" "$(ust 2026 6)" "190"
assert_eq "…the correction is in the month of the Storno" "$(python3 -c "print('%g' % ($OCT_BEFORE - $(ust "$YEAR" "$MONTH")))")" "190"
assert_eq "…the invoice is settled by the credit notes, not 'cancelled'" "$(status_of "$INV")" "paid"
storno "$INV"
assert_eq "a second Storno: 400" "$STATUS" "400"

note "=== 4. the Storno stands ==="
setstatus "$CN" cancelled
assert_eq "the Storno credit note, settled with its invoice, is not withdrawn by a status" "$STATUS/$(says verrechnet)" "400/yes"
assert_eq "…the belts stay back: 10" "$(stock)" "10"

note "=== 5. hours come back with a full Storno only ==="
TODAY_ENTRY='{"date":"'$TODAY'","minutes":120,"description":"Beratung","customerId":"'$K'","hourlyRate":100}'
AS POST "/api/v1/time-entries?companyId=$C" "$TODAY_ENTRY"; E=$(json_field "$BODY" id)
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'"}'; H=$(json_field "$BODY" invoiceId)
setstatus "$H" sent
assert_eq "fixture: 2 hours billed on an issued invoice" "$STATUS/$(q "select \"invoiceId\"='$H' from \"TimeEntry\" where id='$E'")" "200/t"
AS POST "/api/v1/invoices/$H/credit-note?companyId=$C" '{"amount":23.8,"reason":"Kulanz"}'
assert_eq "a partial credit note: the hours stay billed" "$STATUS/$(q "select \"invoiceId\"='$H' from \"TimeEntry\" where id='$E'")" "201/t"
storno "$H"
assert_eq "the Storno credit note: the hours are open again, to be invoiced anew" "$STATUS/$(q "select \"invoiceId\" is null from \"TimeEntry\" where id='$E'")" "201/t"

note "=== 6. a draft is still cancelled by its status ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Entwurf\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}"
D=$(json_field "$BODY" id); setstatus "$D" cancelled
assert_eq "draft → cancelled: 200" "$STATUS/$(status_of "$D")" "200/cancelled"

note "=== 7. the invoice page ==="
PAGE="$SCRIPT_DIR/../../frontend/src/app/dashboard/invoices/[id]/page.tsx"
CHANGE=$(awk '/const changeStatus = async/{f=1} f{print} f&&/^  }$/{exit}' "$PAGE")
assert_eq "\"Storniert\" on an issued invoice posts the Storno credit note" \
  "$(grep -c 'stornoConfirm' <<<"$CHANGE")/$(grep -c '/credit-note' <<<"$CHANGE")/$(grep -c 'reason: "Storno"' <<<"$CHANGE")" "1/1/1"
for l in de en zh; do
  assert_eq "messages/$l.json has the Storno texts" \
    "$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]))['invoicePage'];print(all('{number}' in d[k] for k in ('stornoConfirm','stornoCreated')))" "$SCRIPT_DIR/../../frontend/messages/$l.json")" "True"
done

summary
