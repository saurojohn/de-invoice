#!/bin/bash
# Tier 696 — an invoice cancelled by a Storno credit note is shown as such
#
# Since Tier 694 an issued invoice is cancelled by a credit note over its full
# amount. The credit note settles it: its status is "paid", and the invoice
# list and page said "Bezahlt" — the API said nothing else, and neither
# document's page named the other. GET /invoices and GET /invoices/:id now
# carry `fullyCredited` (issued credit notes cover the whole amount), and the
# detail its `creditNotes`.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-420-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier696-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\",\"items\":[{\"description\":\"Beratung\",\"quantity\":10,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
INV=$(json_field "$BODY" id); NR=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
detail() { AS GET "/api/v1/invoices/$1?companyId=$C"; }
listed() { AS GET "/api/v1/invoices?companyId=$C&pageSize=50"; py "[r['fullyCredited'] for r in d['data'] if r['id']=='$1']"; }

detail "$INV"
assert_eq "issued: not credited, no credit notes" "$(py "d['fullyCredited'], d['creditNotes']")" "(False, [])"

AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'; PART=$(json_field "$BODY" invoiceNumber)
detail "$INV"
assert_eq "a partial credit note: listed, not a Storno" "$(py "d['fullyCredited'], [c['invoiceNumber'] for c in d['creditNotes']]")" "(False, ['$PART'])"
assert_eq "…the list: not a Storno" "$(listed "$INV")" "[False]"

AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"reason":"Storno"}'; CN=$(json_field "$BODY" id); FULL=$(json_field "$BODY" invoiceNumber)
detail "$INV"
assert_eq "the rest credited: a Storno — status paid, fullyCredited (was: paid only)" "$(py "d['status'], d['fullyCredited'], [c['invoiceNumber'] for c in d['creditNotes']]")" "('paid', True, ['$PART', '$FULL'])"
assert_eq "…the list says so" "$(listed "$INV")" "[True]"
detail "$CN"
assert_eq "the credit note names its invoice and is no Storno itself" "$(py "d['referenceInvoice']['invoiceNumber'], d['fullyCredited']")" "('$NR', False)"
assert_eq "…the list: the credit note neither" "$(listed "$CN")" "[False]"

summary
