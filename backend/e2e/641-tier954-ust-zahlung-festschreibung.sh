#!/bin/bash
# Tier 954 — VAT payments and the closed books
#
# The EÜR counts what was paid to and refunded by the tax office on its day
# (Zeilen 18 / 58): the payment of a return, an annual return's balance, the
# Sondervorauszahlung. None of them met the closing — after the books were
# closed to 31.12.2025 such a payment of December 2025 could be entered,
# deleted or moved, and the closed EÜR 2025 changed with it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-641-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier954-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a sole trader (EÜR)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
eur2025() { AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"; P "(float(d['totals']['einnahmenTotal']), float(d['totals']['ausgabenTotal']))"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"euer"}'
AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"sonstige","year":2025,"paidAt":"2025-11-10","amount":300}'
PAID=$(json_field "$BODY" id)
assert_eq "a VAT payment of 10.11.2025" "$STATUS" "201"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=12"
DATA=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
AS POST "/api/v1/ustva/filings?companyId=$C" "$DATA"
DEC=$(json_field "$BODY" id)
assert_eq "December 2025 submitted" "$STATUS" "201"
BEFORE=$(eur2025)
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2025-12-31"}'
assert_eq "the books closed to 31.12.2025" "$STATUS" "200"

AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"sonstige","year":2025,"paidAt":"2025-12-10","amount":200}'
assert_eq "another payment of 10.12.2025: refused (was 201)" "$STATUS/$(P "'Festschreibung' in str(d.get('message'))")" "400/True"
AS DELETE "/api/v1/ustva/payments/$PAID?companyId=$C"
assert_eq "the payment of 10.11.2025 deleted: refused (was 200)" "$STATUS" "400"
AS PUT "/api/v1/ustva/filings/$DEC/payment?companyId=$C" '{"paidAt":"2025-12-28","amount":0}'
assert_eq "December's return paid on 28.12.2025: refused (was 200)" "$STATUS" "400"
assert_eq "the closed EÜR 2025 unchanged" "$(eur2025)" "$BEFORE"
AS PUT "/api/v1/ustva/filings/$DEC/payment?companyId=$C" '{"paidAt":"2026-01-10","amount":0}'
assert_eq "paid on 10.01.2026 (open year): taken" "$STATUS" "200"

summary
