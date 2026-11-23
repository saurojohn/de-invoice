#!/bin/bash
# Tier 960 — an asset whose purchase bill is booked as a cost
#
# The bill form has no Sachkonto: a laptop entered there (3 000 € + 570 €,
# "Computer") stays a cost. Put into the asset register as well, it was
# deducted twice — in full and through its AfA. Measured (sole trader, EÜR
# 2025): costs 4 486,67 € instead of 1 486,67 € (570 € Vorsteuer + 916,67 €
# AfA); the reconciliation said nothing. § 6 Abs. 1 Nr. 1, § 7 Abs. 1 EStG.
# The reconciliation now lists such an asset with its bill; booking the bill
# on the asset's account removes the double deduction.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-647-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier960-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
costs() { AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"; P "float(d['totals']['ausgabenTotal'])"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"euer"}'
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Laptop","category":"Computer","invoiceDate":"2025-02-01","paidAt":"2025-02-01","netAmount":3000,"vatRate":0.19,"vatAmount":570,"grossAmount":3570}'
BILL=$(json_field "$BODY" id)
AS POST "/api/v1/assets?companyId=$C" '{"type":"Betriebsausstattung","bezeichnung":"Laptop","anschaffungsDatum":"2025-02-01","anschaffungsKosten":3000,"nutzungsdauerMonate":36}'
assert_eq "the laptop: a bill as a cost, and in the asset register" "$STATUS" "201"
assert_eq "EÜR 2025: deducted twice — 3 000 + 916,67 AfA + 570 Vorsteuer" "$(costs)" "4486.67"

AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=2025"
assert_eq "the reconciliation lists it, with its bill and the asset's account (was nothing)" \
  "$(P "[(a['expenseId'] == '$BILL', a['account'], float(a['net'])) for a in d.get('assetsBookedAsCost', [])]")" "[(True, '0400', 3000.0)]"
AS PUT "/api/v1/expenses/$BILL?companyId=$C" '{"accountNumber":"0400"}'
assert_eq "the bill booked on 0400" "$STATUS" "200"
assert_eq "EÜR 2025: the AfA and the Vorsteuer only" "$(costs)" "1486.67"
AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=2025"
assert_eq "…and the reconciliation is clear" "$(P "(d.get('assetsBookedAsCost'), d.get('assetPurchases'))")" "([], [])"

summary
