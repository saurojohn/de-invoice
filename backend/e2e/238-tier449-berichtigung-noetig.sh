#!/bin/bash
# Tier 449 — a submitted UStVA that no longer matches the books says so
#
# Measured before: after a UStVA was submitted, an expense or invoice of that
# period could still be entered or corrected (Tier 443 allows correcting an
# open expense). GET /ustva/filings then kept showing the submitted figures,
# with nothing to tell that the books now said otherwise — although § 153 AO
# requires a corrected return once the error is known.
#
# Now a submitted (or accepted) filing carries `abweichung` — live figures
# minus submitted ones for Umsatzsteuer, Vorsteuer and Zahllast — and
# `berichtigungNoetig` when any of them differs by a cent or more. A draft has
# neither (null): it is recomputed when saved.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-238-$(date +%s%N | cut -c1-13)"
Y=2026

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier449-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business"}'
CU=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CU'","issueDate":"'$Y'-05-10","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'

submit() { # [extra python]
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=5"
  local body; body=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';${1:-pass};print(json.dumps(d))" "$BODY")
  AS POST "/api/v1/ustva/filings?companyId=$C" "$body"
}
may() { AS GET "/api/v1/ustva/filings?companyId=$C"; py 'f=[x for x in d if x["periodLabel"]=="'$Y'-05"][0];'"$1"; }

note "=== submitted, matching the books ==="
submit
assert_eq "May submitted" "$STATUS" "201"
assert_eq "no correction needed" "$(may 'print(f.get("berichtigungNoetig"))')" "False"

note "=== an expense of May entered afterwards ==="
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Nachgereicht","invoiceDate":"'$Y'-05-20","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
assert_eq "expense recorded" "$STATUS" "201"
assert_eq "the filing flags it (was nothing)" "$(may 'print(f.get("berichtigungNoetig"))')" "True"
assert_eq "…with the differences: Vorsteuer +19, Zahllast −19" \
  "$(may 'a=f["abweichung"];print(float(a["outputVat"]), float(a["inputVat"]), float(a["payableVat"]))')" "0.0 19.0 -19.0"
assert_eq "…the stored figures are still the submitted ones" "$(may 'print(float(f["payableVat"]))')" "19.0"

note "=== the corrected return clears it ==="
submit "d['berichtigt']=True"
assert_eq "berichtigte Voranmeldung" "$STATUS" "201"
assert_eq "no correction needed any more" "$(may 'print(f.get("berichtigungNoetig"), float(f["payableVat"]))')" "False 0.0"

note "=== a draft is not compared ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=6"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$BODY")"
AS GET "/api/v1/ustva/filings?companyId=$C"
assert_eq "draft: berichtigungNoetig null" "$(py 'print([x.get("berichtigungNoetig") for x in d if x["periodLabel"]=="'$Y'-06"][0])')" "None"

summary
