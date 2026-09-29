#!/bin/bash
# Tier 465 — a corrected UStVA carries Kz 10 in its ELSTER export
#
# Measured before: after a UStVA was submitted again as a corrected return
# (Tier 448, `berichtigt: true`), the ELSTER XML and the text preview were the
# same as for a first return — no Kz 10 "Berichtigte Anmeldung"; the user had
# to remember to tick it in Mein ELSTER. The filing kept "berichtigt" only as a
# prefix of its notes.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-254-$(date +%s%N | cut -c1-13)"
Y=2025

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier465-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"taxId":"123/456/78901"}'
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"invoiceNumber":"ER-1","description":"Material","invoiceDate":"'$Y'-03-10","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=3"
DATA="$BODY"
filing() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';${1:-pass};print(json.dumps(d))" "$DATA"; }
export_of() { # format
  curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/ustva/filings/$FID/elster-xml?companyId=$C&format=$1"
}

AS POST "/api/v1/ustva/filings?companyId=$C" "$(filing)"
assert_eq "first return submitted" "$STATUS" "201"
FID=$(json_field "$BODY" id)
assert_eq "not a corrected return" "$(py 'print(d["berichtigt"])')" "False"
assert_eq "XML: no Kz 10" "$(export_of xml | grep -c 'Kz010')" "0"

AS POST "/api/v1/ustva/filings?companyId=$C" "$(filing "d['berichtigt']=True")"
assert_eq "submitted again as a corrected return" "$STATUS" "201"
assert_eq "the filing says so (was only a notes prefix)" "$(py 'print(d["berichtigt"])')" "True"
assert_eq "XML: Kz 10 = 1 (was missing)" "$(export_of xml | grep -o 'B-Kz010=1')" "B-Kz010=1"
assert_eq "text preview: Kz 10 = 1 (was missing)" "$(export_of ascii | grep -c '^B-Kz010=1 .*Berichtigte Anmeldung')" "1"
assert_eq "the amounts are still there" "$(export_of xml | grep -o 'B-Kz066=[-+0-9]*')" "B-Kz066=+000000001900"

summary
