#!/bin/bash
# Tier 615 — a quote is invoiced, and delivered, in parts
#
# Tier 610 converted a quote "each time in full": a second conversion made a
# second invoice over everything. Now each line of a converted document names
# the line it was taken from (InvoiceItem.sourceItemId), and what is "still
# open" of a line is its quantity minus what invoices (or delivery notes, or
# order confirmations) made from it have taken — cancelled ones aside.
#   POST /invoices/:id/convert { to }                       → all that is open
#   POST /invoices/:id/convert { to, items:[{itemId,quantity}] } → a part
#   GET  /invoices/:id → conversion: { INV: { <itemId>: open }, DN: {…}, OC: {…} }
# Nothing open → 400. More than is open → 400. An absolute discount is
# divided by the share taken, so the parts add up to the quote.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-369-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier615-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
quote() { # items-json [extra-json-fields] → I
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","type":"QU","issueDate":"'$TODAY'","dueDate":"2099-01-31",'"${2:-}"'"items":'"$1"'}'
  I=$(json_field "$BODY" id)
}
convert() { AS POST "/api/v1/invoices/$1/convert?companyId=$C" "$2"; N=$(json_field "$BODY" id); }
line() { q "select id from \"InvoiceItem\" where \"invoiceId\"='$1' and description='$2'"; }
lines() { q "select string_agg(description || ' ' || quantity::numeric(10,2), ', ' order by \"sortOrder\") from \"InvoiceItem\" where \"invoiceId\"='$1'"; }
open() { # doc to → "A=… B=… C=…" by description
  AS GET "/api/v1/invoices/$1?companyId=$C"
  echo "$BODY" | python3 -c "
import sys,json
d=json.load(sys.stdin); c=d.get('conversion',{}).get(sys.argv[1])
print('-' if c is None else ' '.join('%s=%g' % (i['description'], c[i['id']]) for i in sorted(d['items'], key=lambda i: i['sortOrder'])))" "$2" 2>/dev/null
}
made() { q "select count(*) from \"Invoice\" where \"sourceDocumentId\"='$1'"; }
total() { q "select total::numeric(12,2) from \"Invoice\" where id='$1'"; }

company b; UB=$U; CB=$C
company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; K=$(json_field "$BODY" id)
ITEMS='[{"description":"A","quantity":10,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"B","quantity":4,"unit":"Stk","unitPrice":50,"vatRate":0.07},{"description":"C","quantity":-1,"unit":"Stk","unitPrice":20,"vatRate":0.19}]'
quote "$ITEMS"; Q=$I
A=$(line "$Q" A); B=$(line "$Q" B); CC=$(line "$Q" C)
quote "$ITEMS"; OTHER=$I; OA=$(line "$OTHER" A)

note "=== 1. what is open ==="
assert_eq "a fresh quote: everything is open, for an invoice, a delivery note and an order confirmation alike" \
  "$(open "$Q" INV) | $(open "$Q" DN) | $(open "$Q" OC)" "A=10 B=4 C=-1 | A=10 B=4 C=-1 | A=10 B=4 C=-1"

note "=== 2. a part ==="
convert "$Q" '{"to":"INV","items":[{"itemId":"'$B'","quantity":4},{"itemId":"'$A'","quantity":4}]}'; P1=$N
assert_eq "4 of A and all of B: an invoice draft with these two lines, in the quote's order (was: always everything)" "$STATUS $(lines "$P1")" "201 A 4.00, B 4.00"
assert_eq "each line names the quote's line" "$(q "select count(*) from \"InvoiceItem\" where \"invoiceId\"='$P1' and \"sourceItemId\" in ('$A','$B')")" "2"
assert_eq "6 of A and the negative line are still to be invoiced; nothing is delivered yet" "$(open "$Q" INV) | $(open "$Q" DN)" "A=6 B=0 C=-1 | A=10 B=4 C=-1"

note "=== 3. not more than is open ==="
for body in \
  '{"to":"INV","items":[{"itemId":"'$A'","quantity":7}]}' \
  '{"to":"INV","items":[{"itemId":"'$B'","quantity":1}]}' \
  '{"to":"INV","items":[{"itemId":"'$OA'","quantity":1}]}' \
  '{"to":"INV","items":[{"itemId":"'$A'","quantity":1},{"itemId":"'$A'","quantity":1}]}' \
  '{"to":"INV","items":[{"itemId":"'$A'","quantity":0}]}' \
  '{"to":"INV","items":[{"itemId":"'$A'","quantity":"3"}]}' \
  '{"to":"INV","items":[{"itemId":"'$A'","quantity":-2}]}' \
  '{"to":"INV","items":[{"itemId":"'$CC'","quantity":1}]}' \
  '{"to":"INV","items":[{"itemId":"'$A'","quantity":1.00001}]}' \
  '{"to":"INV","items":[]}' \
  '{"to":"INV","items":"alles"}'; do
  convert "$Q" "$body"; R="${R:-}$STATUS "
done
assert_eq "eleven parts that are none: 7 of 6, a finished line, another quote's line, a line twice, 0, \"3\", the wrong sign (both ways), five decimals, an empty list, no list — nothing made" \
  "$R$(made "$Q")" "400 400 400 400 400 400 400 400 400 400 400 1"
convert "$Q" '{"to":"INV","items":[{"itemId":"'$A'","quantity":7}]}'
assert_eq "the message names the line and what is open" "$(echo "$BODY" | grep -c 'Von der Position „A“ sind noch 6 offen')" "1"
U2=$U; C2=$C; U=$UB; C=$CB
convert "$Q" '{"to":"INV","items":[{"itemId":"'$A'","quantity":1}]}'
assert_eq "another company takes no part of this quote" "$STATUS $(made "$Q")" "404 1"
U=$U2; C=$C2

note "=== 4. the rest ==="
convert "$Q" '{"to":"INV"}'; P2=$N
assert_eq "without a list: all that is open — 6 of A and the negative line" "$STATUS $(lines "$P2")" "201 A 6.00, C -1.00"
assert_eq "…and the two invoices together are the quote" \
  "$(q "select sum(total)::numeric(12,2) from \"Invoice\" where id in ('$P1','$P2')") $(open "$Q" INV)" "$(total "$Q") A=0 B=0 C=0"
convert "$Q" '{"to":"INV"}'
assert_eq "a third invoice: 400, everything is invoiced" "$STATUS/$(echo "$BODY" | grep -c 'bereits alles abgerechnet')/$(made "$Q")" "400/1/2"

note "=== 5. what comes back ==="
AS PUT "/api/v1/invoices/$P1/status?companyId=$C" '{"status":"cancelled"}'
assert_eq "the first invoice is cancelled: its lines are open again" "$STATUS $(open "$Q" INV)" "200 A=4 B=4 C=0"
AS PUT "/api/v1/invoices/$P2?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"A","quantity":5,"unit":"Stk","unitPrice":100,"vatRate":0.19,"sourceItemId":"'$A'"},{"description":"Fracht","quantity":1,"unit":"Stk","unitPrice":30,"vatRate":0.19},{"description":"untergeschoben","quantity":3,"unit":"Stk","unitPrice":50,"vatRate":0.07,"sourceItemId":"'$OA'"}]}'
assert_eq "the second draft is edited — 5 of A, the negative line gone, a line of its own, a line claiming another quote's: A has 5 open, C 1, and the other quote is untouched" \
  "$STATUS $(open "$Q" INV) | $(open "$OTHER" INV) | $(q "select count(*) from \"InvoiceItem\" where \"invoiceId\"='$P2' and \"sourceItemId\" is not null")" "200 A=5 B=4 C=-1 | A=10 B=4 C=-1 | 1"
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"A","quantity":2,"unit":"Stk","unitPrice":100,"vatRate":0.19,"sourceItemId":"'$A'"}]}'
assert_eq "a plain new invoice cannot claim a quote's line" "$STATUS $(q "select count(*) from \"InvoiceItem\" where \"invoiceId\"='$(json_field "$BODY" id)' and \"sourceItemId\" is not null") $(open "$Q" INV)" "201 0 A=5 B=4 C=-1"

note "=== 6. a discount in parts ==="
quote '[{"description":"A","quantity":10,"unit":"Stk","unitPrice":100,"vatRate":0.19}]' '"discountAmount":100,'; QA=$I; QA_A=$(line "$QA" A)
convert "$QA" '{"to":"INV","items":[{"itemId":"'$QA_A'","quantity":4}]}'; D1=$N
convert "$QA" '{"to":"INV"}'; D2=$N
assert_eq "100 € off a quote of 1 000 € net: 40 € off the invoice over 4, 60 € off the rest — together the quote's 1 071,00 €" \
  "$(total "$QA") = $(total "$D1") + $(total "$D2")" "1071.00 = 428.40 + 642.60"
quote '[{"description":"A","quantity":10,"unit":"Stk","unitPrice":100,"vatRate":0.19}]' '"discountPercent":10,'; QP=$I; QP_A=$(line "$QP" A)
convert "$QP" '{"to":"INV","items":[{"itemId":"'$QP_A'","quantity":5}]}'; DP=$N
assert_eq "10 % off: half the quote is half its sum" "$(total "$QP") $(total "$DP")" "1071.00 535.50"

note "=== 7. delivered in parts; the order confirmation once ==="
convert "$Q" '{"to":"DN","items":[{"itemId":"'$A'","quantity":3}]}'; DN1=$N
assert_eq "3 of A are delivered: 7 open — what is invoiced does not count here" "$STATUS $(lines "$DN1") / $(open "$Q" DN)" "201 A 3.00 / A=7 B=4 C=-1"
AS PUT "/api/v1/invoices/$DP/status?companyId=$C" '{"status":"sent"}'
DP_A=$(line "$DP" A)
convert "$DP" '{"to":"DN","items":[{"itemId":"'$DP_A'","quantity":2}]}'
assert_eq "an issued invoice over 5 is delivered 2 at a time" "$STATUS $(open "$DP" DN)" "201 A=3"
convert "$QP" '{"to":"OC"}'; A1=$STATUS
convert "$QP" '{"to":"OC"}'
assert_eq "an order confirmation over the whole quote — and no second one" "$A1 $STATUS/$(echo "$BODY" | grep -c 'bereits alles bestätigt')" "201 400/1"

note "=== 8. two at once ==="
quote '[{"description":"A","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'; QR=$I
(convert "$QR" '{"to":"INV"}'; echo "$STATUS" > "/tmp/$TAG.1") &
(convert "$QR" '{"to":"INV"}'; echo "$STATUS" > "/tmp/$TAG.2") &
wait
assert_eq "two clicks on 'invoice': one invoice over the quote, not two" "$(cat "/tmp/$TAG.1" "/tmp/$TAG.2" | sort | tr '\n' ' ')$(made "$QR")" "201 400 1"
rm -f "/tmp/$TAG.1" "/tmp/$TAG.2"
summary
