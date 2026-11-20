#!/bin/bash
# Tier 886 — a quote thanks for the enquiry, not for the order
#
# Found by reading a quote PDF: the default closing line „Vielen Dank für
# Ihren Auftrag.“ stood on an Angebot — there is no order yet. Where the
# default stands, a quote now says „Vielen Dank für Ihre Anfrage. Wir freuen
# uns auf Ihren Auftrag.“; an invoice keeps the line, a company's own text is
# left as it is.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-578-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier886-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
DIR=$(mktemp -d)
TODAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Anfrage 578 GmbH","type":"business","address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(field id)
doc() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"type\":\"$1\",\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Kessel\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  curl -sS "$API/api/v1/invoices/$(field id)/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$DIR/$1.pdf"
  pdf_text "$DIR/$1.pdf"
}
QU=$(doc QU)
INV=$(doc INV)
assert_eq "the quote thanks for the enquiry (was: „für Ihren Auftrag“)" \
  "$(echo "$QU" | grep -c "Vielen Dank für Ihre Anfrage. Wir freuen uns auf Ihren Auftrag.")" "1"
assert_eq "the invoice keeps its line" "$(echo "$INV" | grep -c "Vielen Dank für Ihren Auftrag.")" "1"
rm -rf "$DIR"
summary
