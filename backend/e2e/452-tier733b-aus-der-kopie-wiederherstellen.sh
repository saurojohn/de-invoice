#!/bin/bash
# Tier 733b — an invoice a restore lost, entered again from its kept copy
#
# Tier 733 retires the number of an issued invoice that came back from a
# restore only as its kept copy. The customer holds it; the books must too —
# under its number. Before: nothing could enter an invoice with a given
# number; the page could only say so.
#
# Here: company Y issues the invoices (so that real kept copies exist — a
# rich one with two rates, discount, Skonto, service period, order number and
# card payment; a plain one to a customer only Y has; a credit note on the
# rich one); company X has issued its 000001 and then finds Y's copies in its
# storage as 000002, 000003 and CN-000001 — what a restore of X leaves. X
# enters them again: the amounts as on the copy, the copy kept as the
# document, the customer found or created; the credit note only after its
# invoice; a copy whose lines do not give its total is refused, nothing stored.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
OP_U=$USER_ID; OP_C=$COMPANY_ID
TAG="t452-$(date +%s%N | cut -c1-13)"
YEAR=$(TZ=Europe/Berlin date +%Y); TODAY=$(TZ=Europe/Berlin date +%F)
STORE="${STORAGE_PATH:-}"
case "$STORE" in ""|"$HOME/data/"*|/data/*) fail "this spec needs a throwaway STORAGE_PATH (got „$STORE“)"; summary; exit 1 ;; esac
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() { # user company method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company() { # name → U C
  local reg="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier733b-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  AS x x POST "/api/v1/auth/register" "$reg"
  local u c; u=$(P "d['user']['id']"); c=$(P "d['user'].get('companyId') or d['company']['id']")
  local body='{"vatId":"DE123456789","phone":"+49 30 1","email":"info@t452.example.test","address":{"street":"Altstraße 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"bankName":"Testbank","iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
  AS "$u" "$c" PUT "/api/v1/companies/$c?companyId=$c" "$body"
  echo "$u $c"
}
customer() { # user company json → id
  AS "$1" "$2" POST "/api/v1/customers?companyId=$2" "$3"; P "d['id']"
}
ISSUE='{"status":"sent"}'
issue() { # user company body → ID NUM
  AS "$1" "$2" POST "/api/v1/invoices?companyId=$2" "$3"; ID=$(P "d['id']"); NUM=$(P "d['invoiceNumber']")
  AS "$1" "$2" PUT "/api/v1/invoices/$ID/status?companyId=$2" "$ISSUE"
}
KNORD='{"name":"Kunde Nord GmbH","type":"business","vatId":"DE987654321","address":{"street":"Ring 2","postalCode":"20095","city":"Hamburg","country":"DE"},"contact":{"email":"ap@nord.example.test"}}'
KNEU='{"name":"Nur bei Y AG","type":"business","address":{"street":"Weg 9","postalCode":"50667","city":"Köln","country":"DE"},"contact":{"email":"rechnung@nur-y.example.test"}}'

note "=== 1. the copies: Y issues them ==="
read -r YU YC < <(company Y)
YK1=$(customer "$YU" "$YC" "$KNORD"); YK2=$(customer "$YU" "$YC" "$KNEU")
issue "$YU" "$YC" "{\"customerId\":\"$YK1\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Vorab\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":10,\"vatRate\":0.19}]}"
RICH="{\"customerId\":\"$YK1\",\"issueDate\":\"$TODAY\",\"servicePeriodStart\":\"$YEAR-09-01\",\"servicePeriodEnd\":\"$YEAR-09-30\",\"discountPercent\":10,\"skontoPercent\":2,\"skontoDays\":10,\"orderReference\":\"PO-4711\",\"paymentMethod\":\"credit_card\",\"notes\":\"Danke für den Auftrag.\",\"items\":[{\"description\":\"Beratung\",\"quantity\":3,\"unit\":\"Std\",\"unitPrice\":120,\"vatRate\":0.19},{\"description\":\"Fachbuch\",\"quantity\":2,\"unit\":\"Stk\",\"unitPrice\":39.9,\"vatRate\":0.07}]}"
issue "$YU" "$YC" "$RICH"; Y2=$ID
assert_eq "Y's rich invoice is 000002" "$NUM" "INV-$YEAR-000002"
AS "$YU" "$YC" GET "/api/v1/invoices/$Y2?companyId=$YC"; Y2_TOTAL=$(P "d['total']"); Y2_VAT=$(P "d['totalVat']")
issue "$YU" "$YC" "{\"customerId\":\"$YK2\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":250,\"vatRate\":0.19}]}"; Y3=$ID
AS "$YU" "$YC" POST "/api/v1/invoices/$Y2/credit-note?companyId=$YC" '{"reason":"Storno"}'; YCN=$(P "d['id']")
AS "$YU" "$YC" GET "/api/v1/invoices/$YCN?companyId=$YC"; assert_eq "…and a credit note on it" "$(P "d['invoiceNumber']")" "CN-$YEAR-000001"
issue "$YU" "$YC" "{\"customerId\":\"$YK1\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Kleinteil\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":20,\"vatRate\":0.19}]}"; Y4=$ID
path() { PSQL "select \"pdfPath\" from \"Invoice\" where id='$1'"; }

note "=== 2. X: its 000001 issued, then a restore leaves Y's copies as X's ==="
read -r XU XC < <(company X); q="companyId=$XC"
XK=$(customer "$XU" "$XC" "$KNORD")
issue "$XU" "$XC" "{\"customerId\":\"$XK\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Vorab\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":10,\"vatRate\":0.19}]}"
XDIR="$STORE/$(dirname "$(path "$ID")")"; T=$(date +%s000)
place() { # Y's invoice id, its number = the number in X
  local src; src="$STORE/$(path "$1")"
  cp "$src" "$XDIR/$((T + $3))_$2.pdf"; cp "${src%.pdf}.xrechnung.xml" "$XDIR/$((T + $3))_$2.xrechnung.xml"
}
place "$Y2" "INV-$YEAR-000002" 1; place "$Y3" "INV-$YEAR-000003" 2; place "$YCN" "CN-$YEAR-000001" 3; place "$Y4" "INV-$YEAR-000004" 4
# 000004's copy altered: its lines no longer give its total
python3 - "$XDIR/$((T + 4))_INV-$YEAR-000004.xrechnung.xml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
s = re.sub(r'(<cbc:PriceAmount currencyID="EUR">)20\.00(</cbc:PriceAmount>)', r'\g<1>25.00\2', s, count=1)
open(p, 'w', encoding='utf-8').write(s)
PY
AS "$OP_U" "$OP_C" GET "/api/v1/admin/backups/status"   # (the check, as at the start after a restore)
AS "$XU" "$XC" GET "/api/v1/invoices/retired-numbers?$q"
assert_eq "X's page: the four numbers lost" "$STATUS/$(P "[r['invoiceNumber'] for r in d]")" "200/['CN-$YEAR-000001', 'INV-$YEAR-000002', 'INV-$YEAR-000003', 'INV-$YEAR-000004']"
curl -sS -o "$XDIR/../t452-copy.pdf" -H "x-user-id: $XU" -H "x-company-id: $XC" "$API/api/v1/invoices/retired-numbers/INV-$YEAR-000002/copy?$q"
assert_eq "the copy shown is the kept PDF itself" "$(cmp -s "$XDIR/../t452-copy.pdf" "$XDIR/$((T + 1))_INV-$YEAR-000002.pdf" && echo same)" "same"
rm -f "$XDIR/../t452-copy.pdf"
AS "$YU" "$YC" GET "/api/v1/invoices/retired-numbers?companyId=$XC"
assert_eq "another company cannot read X's list" "$STATUS" "403"

note "=== 3. the credit note waits for its invoice ==="
AS "$XU" "$XC" POST "/api/v1/invoices/retired-numbers/CN-$YEAR-000001/restore?$q" '{}'
assert_eq "422, the invoice named" "$STATUS/$(P "'INV-$YEAR-000002' in d['message'] and 'zuerst' in d['message']")" "422/True"

note "=== 4. the rich invoice: as on the copy, under its number ==="
AS "$XU" "$XC" POST "/api/v1/invoices/retired-numbers/INV-$YEAR-000002/restore?$q" '{}'
assert_eq "restored, the customer found" "$STATUS/$(P "d['invoiceNumber'], d['customerCreated']")" "200/('INV-$YEAR-000002', False)"
X2=$(P "d['id']")
AS "$XU" "$XC" GET "/api/v1/invoices/$X2?$q"
assert_eq "total and VAT as on the copy" "$(P "d['total'], d['totalVat']")" "('$Y2_TOTAL', '$Y2_VAT')"
assert_eq "issued, to Kunde Nord, dated as the copy" "$(P "d['status'], d['customerId'] == '$XK', d['issueDate'][:10]")" "('sent', True, '$TODAY')"
assert_eq "the lines: description, quantity, unit, price, rate" \
  "$(P "sorted((i['description'], float(i['quantity']), i['unit'], float(i['unitPrice']), float(i['vatRate'])) for i in d['items'])")" \
  "[('Beratung', 3.0, 'Std', 120.0, 0.19), ('Fachbuch', 2.0, 'Stk', 39.9, 0.07)]"
assert_eq "discount, Skonto, service period, order number, card, note" \
  "$(P "float(d['discountAmount']), float(d['skontoPercent']), d['skontoDays'], d['servicePeriodStart'][:10], d['servicePeriodEnd'][:10], d['orderReference'], d['paymentMethod'], d['notes']")" \
  "($(P "float(d['discountAmount'])"), 2.0, 10, '$YEAR-09-01', '$YEAR-09-30', 'PO-4711', 'credit_card', 'Danke für den Auftrag.')"
assert_eq "its kept copy is the copy the customer received" "$(PSQL "select \"pdfPath\" like '%/$((T + 1))_INV-$YEAR-000002.pdf' from \"Invoice\" where id='$X2'")" "t"

note "=== 5. the credit note now; a customer only the copy knows ==="
AS "$XU" "$XC" POST "/api/v1/invoices/retired-numbers/CN-$YEAR-000001/restore?$q" '{}'
assert_eq "the credit note restored" "$STATUS/$(P "d['invoiceNumber']")" "200/CN-$YEAR-000001"
AS "$XU" "$XC" GET "/api/v1/invoices/$(P "d['id']")?$q"
assert_eq "…against INV-$YEAR-000002, the whole amount" "$(P "d['referenceInvoiceId'] == '$X2', d['total']")" "(True, '-$Y2_TOTAL')"
AS "$XU" "$XC" POST "/api/v1/invoices/retired-numbers/INV-$YEAR-000003/restore?$q" '{}'
assert_eq "INV-$YEAR-000003 restored, its customer created from the copy" "$STATUS/$(P "d['customerCreated']")" "200/True"
assert_eq "…Nur bei Y AG, with the e-mail and the address" \
  "$(PSQL "select name || '|' || (contact->>'email') || '|' || (address->>'city') from \"Customer\" where \"companyId\"='$XC' and name='Nur bei Y AG'")" "Nur bei Y AG|rechnung@nur-y.example.test|Köln"

note "=== 6. a copy whose lines do not give its total: refused, nothing stored ==="
BEFORE=$(PSQL "select count(*) from \"Invoice\" where \"companyId\"='$XC'")
AS "$XU" "$XC" POST "/api/v1/invoices/retired-numbers/INV-$YEAR-000004/restore?$q" '{}'
assert_eq "422, both amounts named" "$STATUS/$(P "'nichts gespeichert' in d['message']")" "422/True"
assert_eq "no invoice stored" "$(PSQL "select count(*) from \"Invoice\" where \"companyId\"='$XC'")" "$BEFORE"
AS "$XU" "$XC" GET "/api/v1/invoices/retired-numbers?$q"
assert_eq "only it is left" "$(P "[r['invoiceNumber'] for r in d]")" "['INV-$YEAR-000004']"
AS "$XU" "$XC" POST "/api/v1/invoices/retired-numbers/INV-$YEAR-000099/restore?$q" '{}'
assert_eq "a number that is not lost: 404" "$STATUS" "404"

note "=== 7. the numbering goes on after them ==="
issue "$XU" "$XC" "{\"customerId\":\"$XK\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Danach\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":10,\"vatRate\":0.19}]}"
assert_eq "X's next invoice: 000005" "$NUM" "INV-$YEAR-000005"
# (nothing stays red for the specs after this one: 000004 entered by hand, as the message says)
PSQL "update \"Invoice\" set \"invoiceNumber\" = 'INV-$YEAR-000004' where id = '$ID'"
AS "$OP_U" "$OP_C" GET "/api/v1/admin/backups/status"
assert_eq "none of X's left on the backup page" "$(P "[l for l in d['restore']['lost'] if l['companyId'] == '$XC']")" "[]"

summary
