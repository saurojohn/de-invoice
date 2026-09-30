#!/bin/bash
# Tier 485 — entertainment is 70 % deductible
#
# § 4 Abs. 5 Nr. 2 EStG: of a Bewirtung expense only 70 % is a Betriebs-
# ausgabe for the tax profit (the input tax stays deductible). Measured before
# for a sole trader with one paid entertainment receipt of 100 + 19: EÜR 5600
# 100 (Gewinn -119 with the Vorsteuer), Anlage G -119 — the full 100
# deducted; KSt 1 had no add-back (Kz 80 a placeholder, labelled § 8b KStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-271-$(date +%s%N | cut -c1-13)"
company() { # name rechtsform
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier485-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "{\"rechtsform\":\"$2\"}"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
line() { P "[l['amount'] for l in d['$1'] if l['kennziffer']=='$2'][0]"; }

note "=== a sole trader (EÜR) ==="
company eu Einzelunternehmen
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Geschäftsessen","category":"Bewirtung","invoiceDate":"2026-05-10","paidAt":"2026-05-10","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
assert_eq "fixture: an entertainment receipt 100 + 19" "$STATUS" "201"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 5610 Bewirtung 70 % (was 5600 with 100)" "$(line ausgaben 5610)/$(line ausgaben 5600)" "70/0"
assert_eq "…the Vorsteuer in full" "$(line ausgaben 5850)" "19"
assert_eq "…the 30 % stated, not deducted" "$(P "d['nichtAbziehbareBewirtung']")" "30"
assert_eq "Gewinn -89 (was -119)" "$(P "d['totals']['gewinn']")" "-89"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2026"
assert_eq "Anlage S Gewinn -89" "$(P "d['totals']['gewinn']")" "-89"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2026"
assert_eq "Anlage G Gewinn -89 (was -119)" "$(P "d['totals']['gewinnVorKorrektur']")" "-89"
AS GET "/api/v1/accounting/guv?companyId=$C&year=2026"
assert_eq "GuV keeps the full cost: -100" "$(P "d['totals']['jahresueberschuss']")" "-100"

note "=== a GmbH (KSt 1) ==="
company gmbh GmbH
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Kundenveranstaltung","category":"Bewirtung","invoiceDate":"2026-06-10","paidAt":"2026-06-10","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190}'
AS GET "/api/v1/accounting/kst1?companyId=$C&year=2026"
assert_eq "Kz 80: 30 % added back, computed (was 0, placeholder)" "$(P "[(l['amount'], l['source']) for l in d['corrections'] if l['kennziffer']=='80'][0]")" "(300, 'computed')"
assert_eq "zvE = Jahresüberschuss + 300" "$(P "round(d['totals']['zve'] - d['totals']['jahresueberschuss'], 2)")" "300"

summary
