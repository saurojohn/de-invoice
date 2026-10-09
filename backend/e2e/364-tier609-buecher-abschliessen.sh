#!/bin/bash
# Tier 609 — closing the books (Festschreibung)
#
# A submitted UStVA locks the documents of its period (Tier 537). Nothing
# locked a manual voucher, and nothing closed a year: a voucher, an invoice or
# an expense could be dated into any past period at any time. A company can
# now close its books up to a day; up to and including that day nothing is
# written, changed or deleted — the correction belongs into the open period
# (a Storno is dated today). Lifting the closing needs a reason and is in the
# audit log.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-364-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier609-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
ITEM='[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]'
closed() { [[ "$STATUS" == "400" ]] && echo "$BODY" | grep -q 'Bücher sind bis einschließlich 31.03.2026 abgeschlossen' && echo locked || echo "$STATUS $(echo "$BODY" | cut -c1-90)"; }
draft() { AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$1'","items":'"$ITEM"'}'; I=$(json_field "$BODY" id); }
voucher() { AS POST "/api/v1/accounting/vouchers?companyId=$C" '{"companyId":"'$C'","date":"'$1'","description":"'$TAG'","status":"posted","lines":[{"accountId":"'$A1'","debit":50},{"accountId":"'$A2'","credit":50}]}'; V=$(json_field "$BODY" id); }
expense() { AS POST "/api/v1/expenses?companyId=$C" '{"description":"x","invoiceNumber":"'$2'","invoiceDate":"'$1'","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'; E=$(json_field "$BODY" id); }

company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"9977","name":"Test Soll","type":"asset"}'; A1=$(json_field "$BODY" id)
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"9978","name":"Test Haben","type":"revenue"}'; A2=$(json_field "$BODY" id)
draft 2026-03-10; AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; INV=$I
draft 2026-03-20; LATE=$I    # a draft dated into March, not issued yet
expense 2026-03-12 M-1; EXP=$E
voucher 2026-03-15; VOU=$V
[[ -n "$INV" && -n "$EXP" && -n "$VOU" ]] && pass "fixture: March has an invoice, an expense and a voucher" || fail "fixture incomplete: $BODY"

note "=== 1. closing ==="
AS GET "/api/v1/accounting/books-closing?companyId=$C"
assert_eq "nothing is closed at first" "$STATUS $BODY" '200 {"closedUntil":null}'
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2099-01-01"}'
assert_eq "a day in the future: 400" "$STATUS" "400"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"31.03.2026"}'
assert_eq "not a date: 400" "$STATUS" "400"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-02-30"}'
assert_eq "a day that does not exist: 400" "$STATUS" "400"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-03-31"}'
assert_eq "closed up to 31.03.2026" "$STATUS $BODY" '200 {"closedUntil":"2026-03-31"}'

note "=== 2. March is closed ==="
voucher 2026-03-20;                                  assert_eq "a voucher dated 20.03. (was: booked)" "$(closed)" "locked"
voucher 2026-03-31;                                  assert_eq "…the closing day itself is included" "$(closed)" "locked"
expense 2026-03-25 M-2;                              assert_eq "an expense dated 25.03." "$(closed)" "locked"
AS PUT "/api/v1/expenses/$EXP?companyId=$C" '{"netAmount":200}';   assert_eq "changing the expense of 12.03." "$(closed)" "locked"
AS DELETE "/api/v1/ustva/expenses/$EXP?companyId=$C";      assert_eq "deleting it" "$(closed)/$(q "select count(*) from \"Expense\" where id='$EXP'")" "locked/1"
AS PUT "/api/v1/invoices/$LATE/status?companyId=$C" '{"status":"sent"}'; assert_eq "issuing the draft dated 20.03." "$(closed)" "locked"
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"cancelled"}'; assert_eq "cancelling the invoice of 10.03." "$(closed)/$(q "select status from \"Invoice\" where id='$INV'")" "locked/sent"
AS POST "/api/v1/invoices/$INV/payments?companyId=$C" '{"amount":50,"paymentDate":"2026-03-28","paymentMethod":"bank_transfer"}'; assert_eq "a payment dated 28.03." "$(closed)" "locked"
AS POST "/api/v1/accounting/vouchers/$VOU/correct?companyId=$C" '{"date":"2026-03-20","lines":[{"accountId":"'$A1'","debit":60},{"accountId":"'$A2'","credit":60}]}'; assert_eq "a corrected voucher dated into March" "$(closed)" "locked"
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"'$TAG'","anschaffungsDatum":"2025-01-01","anschaffungsKosten":1200,"nutzungsdauerMonate":12}'
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2025" '{"year":2025}'; assert_eq "the depreciation of 2025 (dated 31.12.2025)" "$(closed)/$(q "select count(*) from \"Expense\" where \"companyId\"='$C' and \"afaYear\"=2025")" "locked/0"

note "=== 3. the open period works, and takes the corrections ==="
voucher 2026-04-01;                                  assert_eq "a voucher dated 01.04." "$STATUS" "201"
expense 2026-04-02 A-1;                              assert_eq "an expense dated 02.04." "$STATUS" "201"
AS POST "/api/v1/invoices/$INV/payments?companyId=$C" '{"amount":50,"paymentDate":"2026-04-03","paymentMethod":"bank_transfer"}'; assert_eq "a payment dated 03.04. on the March invoice" "$STATUS" "201"
PAY=$(json_field "$BODY" id)
AS POST "/api/v1/accounting/vouchers/$VOU/reversal?companyId=$C" '{"reason":"falsch"}'
assert_eq "a Storno of the March voucher — dated today, in the open period" "$STATUS/$(q "select count(*) from \"Voucher\" where \"reversedById\"='$VOU' and date > '2026-03-31'")" "201/1"
AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"reason":"Korrektur"}'
assert_eq "a credit note for the March invoice — dated today" "$STATUS" "201"

note "=== 4. another company is not affected ==="
UA=$U; CA=$C; KA=$K
company b
AS POST "/api/v1/expenses?companyId=$C" '{"description":"x","invoiceNumber":"B-1","invoiceDate":"2026-03-25","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
assert_eq "its expense dated 25.03." "$STATUS" "201"
AS PUT "/api/v1/accounting/books-closing?companyId=$CA" '{"closedUntil":null,"reason":"fremde Firma"}'
assert_eq "…and it cannot lift A's closing" "$([[ "$STATUS" == "403" || "$STATUS" == "404" ]] && echo refused || echo "$STATUS")/$(q "select \"booksClosedUntil\" from \"Company\" where id='$CA'")" "refused/2026-03-31"
U=$UA; C=$CA; K=$KA

note "=== 5. lifting the closing ==="
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":null}'
assert_eq "without a reason: 400" "$STATUS/$(q "select \"booksClosedUntil\" from \"Company\" where id='$C'")" "400/2026-03-31"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-02-28","reason":"Nachbuchung laut Steuerberater"}'
assert_eq "back to 28.02. with a reason" "$STATUS $BODY" '200 {"closedUntil":"2026-02-28"}'
expense 2026-03-25 M-3
assert_eq "March is open again" "$STATUS" "201"
expense 2026-02-10 F-1
assert_eq "February is still closed" "$STATUS/$(echo "$BODY" | grep -c '28.02.2026')" "400/1"
assert_eq "the audit log has the closing and the lifting, with the reason" \
  "$(q "select string_agg(action || ':' || coalesce(\"newData\"->>'booksClosedUntil','-') || ':' || coalesce(\"newData\"->>'reason','-'), ' | ' order by seq) from \"AuditLog\" where \"companyId\"='$C' and action like 'books.%'")" \
  "books.closed:2026-03-31:- | books.reopened:2026-02-28:Nachbuchung laut Steuerberater"
summary
