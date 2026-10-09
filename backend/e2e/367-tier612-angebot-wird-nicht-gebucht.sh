#!/bin/bash
# Tier 612 — a quote is not booked, not dunned and not the customer's bill
#
# After Tier 610 every write route that names an invoice was tried with an
# offered quote and a delivered delivery note, and every list was searched
# for them. Measured:
#   POST /accounting/vouchers/generate/<quote>  → 201, a voucher 1400 an
#        4200 / 2200 over the quote's sum — and the same for a delivery note.
#        The route never asked what it was booking: a DRAFT invoice, a
#        CANCELLED one and a Proforma were booked as well (201 each), and a
#        credit note was written with a negative Soll and Haben.
#   POST /mahnungspausen {invoiceId: <quote>}   → 201, a dunning pause
#   GET  /reminders/<quote>/email-data          → 200, a reminder text for it;
#        without a level, or with an unknown one  → 500 for any invoice
#   GET  /customers/:id/summary                 → "lastInvoice" was the quote
#   the customer portal                         → listed the quote and the
#        delivery note next to the invoices, each with its page and PDF
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-367-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
doc() { # type → I
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","type":"'$1'","issueDate":"'$TODAY'","dueDate":"2099-01-31","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'
  I=$(json_field "$BODY" id)
}
status() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"'$2'"}'; }
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
book() { AS POST "/api/v1/accounting/vouchers/generate/$1?companyId=$C" '{}'; }
vouchers() { q "select count(*) from \"Voucher\" where \"companyId\"='$C'"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier612-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"'$TAG'-kunde@example.test"}}'; K=$(json_field "$BODY" id)
doc INV; INV=$I; status "$INV" sent
doc INV; DRAFT=$I
doc INV; GONE=$I; status "$GONE" sent; status "$GONE" cancelled
doc PI;  PI=$I;  status "$PI" sent
doc QU;  QU=$I;  status "$QU" offered
doc DN;  DN=$I;  status "$DN" delivered
[[ -n "$INV" && -n "$QU" && -n "$DN" && -n "$PI" ]] && pass "fixture: an invoice, a draft, a cancelled invoice, a Proforma, a quote, a delivery note" || fail "fixture incomplete: $BODY"

note "=== 1. a voucher is generated from an issued invoice — and from nothing else ==="
for id in "$QU" "$DN" "$DRAFT" "$GONE" "$PI"; do book "$id"; R="${R:-}$STATUS "; done
assert_eq "a quote, a delivery note, a draft, a cancelled invoice, a Proforma: 400, nothing booked (was: 201 each)" "$R$(vouchers)" "400 400 400 400 400 0"
book "$QU"
assert_eq "…and the message says why" "$(echo "$BODY" | grep -c 'Angebot“ ist kein Umsatz')" "1"
book "$INV"; V=$(json_field "$BODY" id)
assert_eq "the issued invoice is booked: 119 Soll, 100 + 19 Haben" \
  "$STATUS $(q "select string_agg(debit::numeric(10,2) || '/' || credit::numeric(10,2), ' ' order by \"sortOrder\") from \"VoucherLine\" where \"voucherId\"='$V'")" \
  "201 119.00/0.00 0.00/100.00 0.00/19.00"
AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"reason":"Teilgutschrift","amount":59.5}'; CN=$(json_field "$BODY" id)
book "$CN"; V=$(json_field "$BODY" id)
assert_eq "its credit note is booked the other way round, with positive amounts (was: -59,50 Soll, -50,00 / -9,50 Haben)" \
  "$STATUS $(q "select string_agg(debit::numeric(10,2) || '/' || credit::numeric(10,2), ' ' order by \"sortOrder\") from \"VoucherLine\" where \"voucherId\"='$V'") $(q "select description from \"Voucher\" where id='$V'" | cut -d' ' -f1)" \
  "201 0.00/59.50 50.00/0.00 9.50/0.00 Gutschrift"
assert_eq "no voucher line of the company has a negative amount" "$(q "select count(*) from \"VoucherLine\" l join \"Voucher\" v on v.id=l.\"voucherId\" where v.\"companyId\"='$C' and (l.debit < 0 or l.credit < 0)")" "0"

note "=== 2. nothing is dunned on a quote ==="
AS POST "/api/v1/mahnungspausen?companyId=$C" '{"invoiceId":"'$QU'","reason":"x"}'
assert_eq "no dunning pause for a quote (was: 201)" "$STATUS/$(q "select count(*) from \"Mahnungspause\" where \"companyId\"='$C'")" "400/0"
AS POST "/api/v1/mahnungspausen?companyId=$C" '{"invoiceId":"'$INV'","reason":"Kunde bestreitet"}'
assert_eq "…for an invoice there is" "$STATUS" "201"
AS GET "/api/v1/reminders/$QU/email-data?companyId=$C&level=first"
assert_eq "no reminder text for a quote (was: 200)" "$STATUS" "400"
AS GET "/api/v1/reminders/$INV/email-data?companyId=$C";              A=$STATUS
AS GET "/api/v1/reminders/$INV/email-data?companyId=$C&level=dritte"; B=$STATUS
AS GET "/api/v1/reminders/$INV/email-data?companyId=$C&level=first"
assert_eq "the reminder text of an invoice: no level 400, an unknown level 400 (was: 500 each), a level 200" "$A $B $STATUS" "400 400 200"

note "=== 3. the customer's last invoice, and the customer's portal ==="
AS GET "/api/v1/customers/$K/summary?companyId=$C"
assert_eq "the summary's last invoice is an invoice (was: the delivery note, the newest document)" "$(field "d['stats']['lastInvoice']['type'] in ('INV','CN','PI')")" "True"
AS POST "/api/v1/customer-portal/admin/create-session" '{"customerId":"'$K'"}'
TOKEN=$(echo "$BODY" | grep -oE '[0-9a-f]{64}' | head -1)
[[ -n "$TOKEN" ]] && pass "a portal session for the customer" || fail "no portal token: $STATUS $BODY"
LIST=$(curl -sS "$API/api/v1/customer-portal/invoices?token=$TOKEN")
assert_eq "the portal lists the customer's invoices — no quote, no delivery note (was: both)" \
  "$(echo "$LIST" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('invoices',d.get('data',d));print(sorted(set(x['type'] for x in r)), any(x['id'] in ('$QU','$DN') for x in r), any(x['id']=='$INV' for x in r))" 2>/dev/null)" \
  "['CN', 'INV', 'PI'] False True"
for id in "$QU" "$DN"; do
  P="${P:-}$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customer-portal/invoice/$id?token=$TOKEN")/$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customer-portal/invoice/$id/pdf?token=$TOKEN")/$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/customer-portal/invoice/$id/mark-paid?token=$TOKEN" -H 'Content-Type: application/json' -d '{}') "
done
assert_eq "…and opens neither by its id: page, PDF, 'I have paid'" "$P" "404/404/404 404/404/404 "
assert_eq "the invoice itself is there" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customer-portal/invoice/$INV?token=$TOKEN")" "200"
summary
