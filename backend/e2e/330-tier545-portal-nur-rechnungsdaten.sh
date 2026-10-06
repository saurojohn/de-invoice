#!/bin/bash
# Tier 545 — the customer portal shows the invoice, not the company's record of it
#
# `GET /customer-portal/invoice/:id` (public, by the customer's session token)
# returned the whole Invoice row with its payments. Measured before: the
# customer received the cost centre and cost object the company booked the
# invoice on, the internal-notes column, the id of the user who created it,
# the stored PDF's path, the voucher / SEPA batch / recurring-template ids,
# each line's product id — and each payment's internal note ("Auto-matched
# from bank statement <id> (txn <id>)").
#
# Now the answer names its fields: what is on the invoice, its lines, and the
# payments with amount, date, method and reference.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-330-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier545-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
TODAY=$(date +%Y-%m-%d)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"k-$TAG@example.test\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"costCenter\":\"KST-GEHEIM\",\"costObject\":\"KTR-GEHEIM\",\"notes\":\"Vielen Dank für Ihren Auftrag\",\"items\":[{\"description\":\"Beratung\",\"quantity\":2,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":100,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\",\"reference\":\"Abschlag\",\"notes\":\"INTERN: Kunde zahlt schleppend\"}"
assert_eq "fixture: an issued invoice on a cost centre, a payment with an internal note" "$STATUS" "201"
AS POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$K\"}"
TOKEN=$(python3 -c "
import sys,json,urllib.parse as u
d=json.loads(sys.argv[1]); url=d.get('url','')
print(u.parse_qs(u.urlparse(url).query).get('token',[''])[0] or d.get('token',''))" "$BODY")
curl -sS -o /tmp/t545.json "$API/api/v1/customer-portal/invoice/$I?token=$TOKEN"
J() { python3 -c "import sys,json;d=json.load(open('/tmp/t545.json'));print(eval(sys.argv[1]))" "$1"; }

note "=== what the company keeps to itself ==="
assert_eq "no cost centre / cost object (was KST-GEHEIM, KTR-GEHEIM)" "$(grep -c "GEHEIM" /tmp/t545.json)" "0"
assert_eq "no payment's internal note (was in the answer)" "$(grep -c "INTERN" /tmp/t545.json)" "0"
assert_eq "none of the internal columns" \
  "$(J "sorted(k for k in d if k in ('costCenter','costObject','internalNotes','createdById','pdfPath','voucherRefId','collectedBySepaBatchId','recurringInvoiceId','companyId','advanceInvoiceId','attachments','exchangeRate'))")" "[]"
assert_eq "no product id on a line, no note on a payment" "$(J "('productId' in d['items'][0], 'notes' in d['payments'][0], 'invoiceId' in d['payments'][0])")" "(False, False, False)"

note "=== what is on the invoice ==="
assert_eq "number, status, amounts" "$(J "(d['invoiceNumber'][:4], d['status'], float(d['subtotal']), float(d['totalVat']), float(d['total']), d['currency'])")" "('INV-', 'sent', 200.0, 38.0, 238.0, 'EUR')"
assert_eq "the invoice's own note" "$(J "d['notes']")" "Vielen Dank für Ihren Auftrag"
assert_eq "the line" "$(J "(d['items'][0]['description'], float(d['items'][0]['quantity']), d['items'][0]['unit'], float(d['items'][0]['unitPrice']), float(d['items'][0]['grossAmount']))")" "('Beratung', 2.0, 'Std', 100.0, 238.0)"
assert_eq "the payment: amount, method, reference" "$(J "(float(d['payments'][0]['amount']), d['payments'][0]['paymentMethod'], d['payments'][0]['reference'])")" "(100.0, 'bank_transfer', 'Abschlag')"
assert_eq "it is this customer's" "$(J "d['customerId']")" "$K"
rm -f /tmp/t545.json

summary
