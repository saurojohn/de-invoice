#!/bin/bash
# Tier 448 — a submitted UStVA stays what was submitted; figures come from the books
#
# Measured before (POST /ustva/filings):
#   - the stored figures were whatever the request carried: Umsatzsteuer 999
#     was saved for a month whose computed Umsatzsteuer was 0;
#   - a filing marked "submitted" was overwritten by the next save — a draft
#     save set it back to "draft", cleared submittedAt and replaced the
#     figures: the record of what went to the Finanzamt was gone.
#
# Now the figures are compute()'s for the period. A submitted filing cannot be
# saved as a draft (409); submitting it again needs `berichtigt: true` — a
# corrected return (berichtigte Voranmeldung), whose notes keep the first
# submission's date and Zahllast.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-237-$(date +%s%N | cut -c1-13)"
Y=2026

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier448-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
says() { grep -qF "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }

AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business"}'
CU=$(json_field "$BODY" id)
invoice() { # day
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CU'","issueDate":"'$Y'-05-'$1'","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
}
invoice 10
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=5"
assert_eq "fixture: May has 19 Umsatzsteuer" "$(py 'print(d["umsatzsteuer"])')" "19"
DATA="$BODY"
filing() { # status [extra python]
  python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='$1';${2:-pass};print(json.dumps(d))" "$DATA"
}
stored() { AS GET "/api/v1/ustva/filings?companyId=$C"; py 'f=[x for x in d if x["periodLabel"]=="'$Y'-05"][0];print(f["status"], float(f["outputVat"]), float(f["payableVat"]))'; }

note "=== the figures are the books' ==="
AS POST "/api/v1/ustva/filings?companyId=$C" "$(filing draft "d['umsatzsteuer']=999;d['differenzbetrag']=999")"
assert_eq "draft saved" "$STATUS" "201"
assert_eq "stored Umsatzsteuer 19, not the 999 sent (was 999)" "$(stored)" "draft 19.0 19.0"

note "=== submitted ==="
AS POST "/api/v1/ustva/filings?companyId=$C" "$(filing submitted)"
assert_eq "submitted" "$STATUS/$(py 'print(d["status"], d["submittedAt"] is not None)')" "201/submitted True"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(filing draft)"
assert_eq "a draft save cannot overwrite it (was 201)" "$STATUS" "409"
assert_eq "…the message says it was submitted" "$(says "übermittelt")" "yes"
assert_eq "…still submitted (was back to draft)" "$(stored)" "submitted 19.0 19.0"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(filing submitted)"
assert_eq "submitting again without berichtigt is refused" "$STATUS" "409"

note "=== a corrected return ==="
invoice 20
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=5"
DATA="$BODY"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(filing submitted "d['berichtigt']=True")"
assert_eq "berichtigte Voranmeldung accepted" "$STATUS" "201"
assert_eq "…with the corrected figures" "$(stored)" "submitted 38.0 38.0"
AS GET "/api/v1/ustva/filings?companyId=$C"
assert_eq "…and the first submission in its notes" \
  "$(py 'print("Berichtigte Voranmeldung" in d[0]["notes"] and "Zahllast damals 19.00" in d[0]["notes"])')" "True"

summary
