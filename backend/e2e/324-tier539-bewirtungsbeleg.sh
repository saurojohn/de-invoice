#!/bin/bash
# Tier 539 — the Bewirtungsbeleg's occasion and participants
#
# An entertainment expense is deductible (at 70 %, Tier 485) only with its
# record: place, day, participants, occasion and amount (§ 4 Abs. 5 Nr. 2
# Satz 2 EStG). Place, day and amount are on the bill; the occasion and the
# participants are what the taxpayer adds. Measured before: the app had no
# place for them (`bewirtungAnlass` → 400 "should not exist"), and nothing
# said which Bewirtungen had none.
#
# Now both can be entered and changed, an expense of the category "Bewirtung…"
# without them is flagged in the lists, and the EÜR says how many there are.
# The figures are not changed — the paper Beleg may carry the record.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-324-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier539-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
ex() { # category extra-json
  AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"$TAG\",\"category\":\"$1\",\"invoiceDate\":\"2026-05-10\",\"paidAt\":\"2026-05-10\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119${2:-}}"
}
flag() { AS GET "/api/v1/ustva/expenses?companyId=$C&year=2026"; P "[x['bewirtungNachweisFehlt'] for x in d if x['id']=='$1']"; }
hint() { AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"; P "(d['bewirtungOhneNachweis']['count'], d['bewirtungOhneNachweis']['betrag'])"; }

note "=== entered with the record ==="
ex "Bewirtung" ',"bewirtungAnlass":"Jahresgespräch Liefervertrag","bewirtungTeilnehmer":"A. Müller (Kunde AG), B. Schmidt, ich"'
assert_eq "a Bewirtung with occasion and participants: recorded (was 400 — no such field)" "$STATUS" "201"
E1=$(json_field "$BODY" id)
assert_eq "…both are stored" "$(q "select \"bewirtungAnlass\"||' | '||\"bewirtungTeilnehmer\" from \"Expense\" where id='$E1'")" "Jahresgespräch Liefervertrag | A. Müller (Kunde AG), B. Schmidt, ich"
assert_eq "…it is not flagged" "$(flag "$E1")" "[False]"

note "=== entered without ==="
ex "Bewirtung"
E2=$(json_field "$BODY" id)
assert_eq "a Bewirtung without them is still recorded" "$STATUS" "201"
assert_eq "…and flagged" "$(flag "$E2")" "[True]"
ex "Bewirtungskosten" ',"bewirtungAnlass":"Messe"'
E3=$(json_field "$BODY" id)
assert_eq "only the occasion: flagged — the participants are missing" "$(flag "$E3")" "[True]"
ex "Material"
E4=$(json_field "$BODY" id)
assert_eq "another category is never flagged" "$(flag "$E4")" "[False]"
assert_eq "the EÜR says: 2 Bewirtungen without the record, 200 € net" "$(hint)" "(2, 200)"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "…its figures are unchanged: 30 % of the three, 90 €, not deductible" "$(P "d['nichtAbziehbareBewirtung']")" "90"
AS GET "/api/v1/expenses?companyId=$C"
assert_eq "the expenses page's list flags the same two" "$(P "sorted(x['id'] for x in d['data'] if x.get('bewirtungNachweisFehlt')) == sorted(['$E2','$E3'])")" "True"

note "=== completed afterwards ==="
AS PUT "/api/v1/ustva/expenses/$E2?companyId=$C" '{"bewirtungAnlass":"Projektabschluss","bewirtungTeilnehmer":"C. Weber, ich"}'
assert_eq "the record is added to the open one" "$STATUS/$(flag "$E2")" "200/[False]"
AS PUT "/api/v1/ustva/expenses/$E3?companyId=$C" '{"bewirtungTeilnehmer":"   "}'
assert_eq "blanks are no participants" "$(flag "$E3")" "[True]"
assert_eq "the EÜR says: 1 left, 100 €" "$(hint)" "(1, 100)"
AS POST "/api/v1/expenses?companyId=$C" "{\"description\":\"$TAG\",\"category\":\"Bewirtung\",\"invoiceDate\":\"2026-05-11\",\"netAmount\":50,\"vatRate\":0.19,\"vatAmount\":9.5,\"grossAmount\":59.5,\"bewirtungAnlass\":\"Akquise\",\"bewirtungTeilnehmer\":\"D. Braun, ich\"}"
assert_eq "POST /expenses takes the two fields too" "$STATUS/$(P "d['bewirtungAnlass']")" "201/Akquise"

summary
