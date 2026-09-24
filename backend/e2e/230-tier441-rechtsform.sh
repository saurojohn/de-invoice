#!/bin/bash
# Tier 441 — the company's legal form
#
# Measured before: there was no Company.rechtsform. KSt 1 and the packager
# read it anyway and fell back to "GmbH" — "Muster Beratung" (a sole trader)
# was a corporation, with KSt 1 and without Anlage G; a GmbH & Co. KG (a
# partnership) was one too. The GewSt Freibetrag of 24 500 € (Tier 438) went
# to every company: a GmbH with 50 050 € profit was shown 3 570 € GewSt
# instead of 7 000 €. PUT /companies/:id ignored a rechtsform.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-230-$(date +%s%N | cut -c1-13)"
Y=2025

company() { # company name → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$(echo "$1" | tr ' ' '-')@example.test\",\"password\":\"Tier441-e2e\",\"companyName\":\"$1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
revenue() {
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business"}'
  local cust inv; cust=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$cust'","issueDate":"'$Y'-03-01","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":50050,"vatRate":0.19}]}'
  inv=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$inv/status?companyId=$C" '{"status":"sent"}'
}
kst() { AS GET "/api/v1/accounting/kst1?companyId=$C&year=$Y"; py 'print(d["rechtsform"], d["isKapitalgesellschaft"])'; }
freibetrag() { AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"; py 'print(d["totals"]["freibetrag"])'; }
gewst() { AS GET "/api/v1/accounting/gewst?companyId=$C&year=$Y"; py 'print([l["amount"] for l in d["lines"] if l["kennziffer"]=="10"][0])'; }
setrf() { AS PUT "/api/v1/companies/$C" "{\"rechtsform\":$1}"; }

note "=== a company named '… GmbH', nothing set ==="
company "$TAG GmbH"
[[ -n "${C:-}" ]] && pass "fixture" || { fail "register"; summary; exit 1; }
revenue
assert_eq "KSt 1: GmbH, a corporation (from the name)" "$(kst)" "GmbH True"
assert_eq "no GewSt Freibetrag for a GmbH (was 24500)" "$(freibetrag)" "0"
assert_eq "GewSt: 50 000 x 3,5 % x 400 % (was 3570)" "$(gewst)" "7000"

note "=== set explicitly ==="
setrf '"Einzelunternehmen"'
assert_eq "PUT rechtsform accepted" "$STATUS" "200"
assert_eq "stored" "$(py 'print(d.get("rechtsform"))')" "Einzelunternehmen"
assert_eq "KSt 1: not a corporation (was GmbH True)" "$(kst)" "Einzelunternehmen False"
assert_eq "Freibetrag for a sole trader" "$(freibetrag)" "24500"
setrf '"GmbH & Co. KG"'
assert_eq "GmbH & Co. KG is a partnership (was a corporation)" "$(kst)" "GmbH & Co. KG False"
assert_eq "… with the Freibetrag" "$(freibetrag)" "24500"
setrf '"Limited"'
assert_eq "unknown legal form refused" "$STATUS" "400"
setrf 'null'
assert_eq "cleared: back to the name" "$(kst)" "GmbH True"

note "=== a name without a legal form ==="
company "$TAG Beratung"
revenue
assert_eq "KSt 1: unknown, not a corporation (was GmbH True)" "$(kst)" "nicht angegeben False"
curl -sS -o /tmp/t441.zip -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/berater-packager?companyId=$C&year=$Y"
rm -rf /tmp/t441 && mkdir -p /tmp/t441 && (cd /tmp/t441 && unzip -o -q /tmp/t441.zip)
assert_eq "packager: Anlage G for a non-corporation with revenue (was left out)" \
  "$(find /tmp/t441 -name '*Anlage-G.pdf' | wc -l | tr -d ' ')" "1"
assert_eq "packager: no KSt 1 (was included)" "$(find /tmp/t441 -name '*KSt*' | wc -l | tr -d ' ')" "0"

summary
