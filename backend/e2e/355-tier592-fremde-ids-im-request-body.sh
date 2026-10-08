#!/bin/bash
# Tier 592 — another company's ids in a request BODY
#
# The company-scope sweeps so far put a foreign id into the path. Here company
# B sends ids of company A inside the body: an invoice for A's customer, a
# reminder for A's invoice, a voucher on A's accounts … Each must be refused
# and must leave A untouched. One was not: POST /invoices/bulk-download
# refused the PDFs but listed number, date, total and customer of A's invoices
# in the archive's _manifest.txt (its query had no company).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-355-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%Y-%m-%d)
D=$(mktemp -d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier592-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
ITEM='[{"description":"Geheimsache","quantity":1,"unit":"Stk","unitPrice":4711,"vatRate":0.19}]'

company a; UA=$U; CA=$C
[[ -n "${CA:-}" ]] && pass "fixture: company A" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Geheimkunde","type":"business","address":{"street":"Verborgen 1","postalCode":"80331","city":"München","country":"DE"}}'
KA=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$KA'","issueDate":"'$TODAY'","items":'"$ITEM"'}'
IA=$(json_field "$BODY" id); NA=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$IA/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Geheimlieferant"}'; SA=$(json_field "$BODY" id)
AS POST "/api/v1/products?companyId=$C" '{"name":"'$TAG' Geheimprodukt","basePrice":5}'; PA=$(json_field "$BODY" id)
AS POST "/api/v1/expenses?companyId=$C" '{"description":"geheim","invoiceNumber":"G-1","invoiceDate":"'$TODAY'","netAmount":10,"vatRate":0.19,"vatAmount":1.9,"grossAmount":11.9}'; EA=$(json_field "$BODY" id)
AS POST "/api/v1/accounting/accounts?companyId=$C" '{"accountNumber":"9977","name":"geheim","type":"asset"}'; ACA=$(json_field "$BODY" id)
AS POST "/api/v1/payments/mandates?companyId=$C" '{"companyId":"'$C'","customerId":"'$KA'","dateOfSignature":"2026-08-01","iban":"DE89370400440532013000","debitorName":"x"}'; MA=$(json_field "$BODY" id)
[[ -n "$IA" && -n "$SA" && -n "$PA" && -n "$EA" && -n "$ACA" && -n "$MA" ]] && pass "fixture: A has a customer, an issued invoice, a supplier, a product, an expense, an account, a mandate" || fail "fixture of A incomplete"
state() { q "select (select count(*) from \"Invoice\" where \"companyId\"='$CA')||'/'||(select count(*) from \"Customer\" where \"companyId\"='$CA')||'/'||(select count(*) from \"Mahnung\" where \"companyId\"='$CA')||'/'||(select count(*) from \"Voucher\" where \"companyId\"='$CA')||'/'||(select count(*) from \"SepaDirectDebitMandate\" where \"companyId\"='$CA')||'/'||(select status from \"Invoice\" where id='$IA')||'/'||(select coalesce(\"collectedBySepaBatchId\",'-') from \"Invoice\" where id='$IA')"; }
BEFORE=$(state)

company b; CB=$C
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' B-Kunde","type":"business","address":{"street":"a","postalCode":"1","city":"b","country":"DE"}}'; KB=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$KB'","issueDate":"'$TODAY'","items":[{"description":"eigene","quantity":1,"unit":"Stk","unitPrice":10,"vatRate":0.19}]}'; IB=$(json_field "$BODY" id); NB=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$IB/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/expenses?companyId=$C" '{"description":"eigene","invoiceNumber":"B-1","invoiceDate":"'$TODAY'","netAmount":10,"vatRate":0.19,"vatAmount":1.9,"grossAmount":11.9}'; EB=$(json_field "$BODY" id)

note "=== 1. the bulk download ==="
curl -sS -o "$D/a.zip" -X POST "$API/api/v1/invoices/bulk-download?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d '{"invoiceIds":["'$IA'","'$IB'"]}'
MAN=$(python3 -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.read('_manifest.txt').decode());print('FILES',[n for n in z.namelist() if not n.startswith('_')])" "$D/a.zip" 2>/dev/null)
assert_eq "the manifest does not name A's invoice, its amount or its customer (was: all three)" "$(echo "$MAN" | grep -c "$NA.*4711\|Geheimkunde\|5606")" "0"
assert_eq "…it still lists B's own invoice" "$(echo "$MAN" | grep -c "B-Kunde")" "1"
assert_eq "…and the archive holds B's document only" "$(echo "$MAN" | grep -c "FILES \['[^,]*'\]")" "1"

note "=== 2. A's ids in a body: refused ==="
no() { # label method path body
  AS "$2" "$3?companyId=$C" "$4"
  if [[ "$STATUS" =~ ^4 ]]; then pass "$1: $STATUS"; else fail "$1: $STATUS — $(echo "$BODY" | cut -c1-160)"; fi
}
no "an invoice for A's customer" POST /api/v1/invoices '{"customerId":"'$KA'","issueDate":"'$TODAY'","items":'"$ITEM"'}'
no "an invoice with A's product" POST /api/v1/invoices '{"customerId":"'$KB'","issueDate":"'$TODAY'","items":[{"description":"x","quantity":1,"unit":"Stk","unitPrice":1,"vatRate":0.19,"productId":"'$PA'"}]}'
no "a credit note document referring to A's invoice" POST /api/v1/invoices '{"customerId":"'$KB'","issueDate":"'$TODAY'","type":"CN","referenceInvoiceId":"'$IA'","items":'"$ITEM"'}'
no "a recurring invoice for A's customer" POST /api/v1/recurring-invoices '{"name":"x","customerId":"'$KA'","interval":"monthly","startDate":"2030-01-01","items":'"$ITEM"'}'
no "an expense with A's supplier" POST /api/v1/expenses '{"description":"x","invoiceNumber":"X-1","invoiceDate":"'$TODAY'","netAmount":10,"vatRate":0.19,"vatAmount":1.9,"grossAmount":11.9,"supplierId":"'$SA'"}'
no "an own expense moved to A's supplier" PUT "/api/v1/expenses/$EB" '{"supplierId":"'$SA'"}'
no "a reminder for A's invoice" POST /api/v1/reminders/send '{"invoiceId":"'$IA'","companyId":"'$CB'","level":"first"}'
no "…with A's company in the body" POST /api/v1/reminders/send '{"invoiceId":"'$IA'","companyId":"'$CA'","level":"first"}'
no "an instalment plan from A's invoice" POST /api/v1/installment-plans/from-invoice '{"invoiceId":"'$IA'","installmentCount":3,"firstDueDate":"2026-12-01"}'
no "a mandate for A's customer" POST /api/v1/payments/mandates '{"companyId":"'$CB'","customerId":"'$KA'","dateOfSignature":"2026-08-01","iban":"DE89370400440532013000","debitorName":"x"}'
no "…with A's company in the body" POST /api/v1/payments/mandates '{"companyId":"'$CA'","customerId":"'$KA'","dateOfSignature":"2026-08-01","iban":"DE89370400440532013000","debitorName":"x"}'
no "a direct debit with A's invoice and mandate" POST /api/v1/payments/direct-debit/batches '{"companyId":"'$CB'","collections":[{"invoiceId":"'$IA'","mandateId":"'$MA'"}],"executionDate":"2026-12-20","creditorIban":"DE89370400440532013000","creditorName":"B","creditorIdentifier":"DE98ZZZ09999999999"}'
no "a transfer batch with A's expense" POST /api/v1/payments/batches '{"companyId":"'$CB'","expenseIds":["'$EA'"],"executionDate":"2026-12-20","debtorIban":"DE89370400440532013000","debtorName":"B"}'
no "a voucher on A's account" POST /api/v1/accounting/vouchers '{"companyId":"'$CB'","date":"'$TODAY'","description":"x","status":"posted","lines":[{"accountId":"'$ACA'","debit":5},{"accountId":"'$ACA'","credit":5}]}'
no "…with A's company in the body" POST /api/v1/accounting/vouchers '{"companyId":"'$CA'","date":"'$TODAY'","description":"x","status":"posted","lines":[{"accountId":"'$ACA'","debit":5},{"accountId":"'$ACA'","credit":5}]}'
no "a cashbook entry for A's invoice" POST /api/v1/cashbook/entries '{"businessDate":"'$TODAY'","type":"einnahme","description":"x","amount":5,"invoiceId":"'$IA'"}'
no "a portal session for A's customer" POST /api/v1/customer-portal/admin/create-session '{"customerId":"'$KA'"}'
no "merging A's customer into an own one" POST /api/v1/customers/merge '{"sourceId":"'$KA'","targetId":"'$KB'"}'
no "a dunning pause for A's customer" POST /api/v1/mahnungspausen '{"customerId":"'$KA'","reason":"x"}'
no "a dunning pause for A's invoice" POST /api/v1/mahnungspausen '{"invoiceId":"'$IA'","reason":"x"}'
no "switching into A's company" POST /api/v1/users/me/switch-company '{"companyId":"'$CA'"}'
no "an invitation into A's company" POST /api/v1/users/invitations '{"email":"x-'$TAG'@example.test","role":"admin","companyId":"'$CA'"}'
AS POST "/api/v1/reminders/bulk-send?companyId=$C" '{"companyId":"'$CB'","invoiceIds":["'$IA'"],"level":"first"}'
assert_eq "bulk reminders with A's invoice: nothing sent, nothing told about it" "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['results'][0];print(d['succeeded'], r['invoiceNumber'], r['customerName'])")" "0 (missing) None"

note "=== 3. A is as it was ==="
assert_eq "A's invoices / customers / reminders / vouchers / mandates, the invoice's status and SEPA batch" "$(state)" "$BEFORE"
assert_eq "no row of B points at A's customer, invoice, supplier or product" "$(q "select (select count(*) from \"Invoice\" where \"companyId\"='$CB' and (\"customerId\"='$KA' or \"referenceInvoiceId\"='$IA'))+(select count(*) from \"Expense\" where \"companyId\"='$CB' and \"supplierId\"='$SA')+(select count(*) from \"InvoiceItem\" i join \"Invoice\" v on v.id=i.\"invoiceId\" where v.\"companyId\"='$CB' and i.\"productId\"='$PA')")" "0"
rm -rf "$D"
summary
