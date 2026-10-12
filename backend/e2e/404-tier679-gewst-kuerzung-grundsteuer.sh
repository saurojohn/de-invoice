#!/bin/bash
# Tier 679 — trade tax: from 2025 the reduction for property is the
# Grundsteuer that is in the profit.
#
# § 9 Nr. 1 Satz 1 GewStG (gesetze-im-internet.de, 12.10.2026): the sum of
# the profit and the add-backs is reduced by "die im Erhebungszeitraum als
# Betriebsausgabe erfasste Grundsteuer" for property held as business
# assets. Up to 2024 it was 1,2 % of the property's Einheitswert.
#
# The line said „1,2% des Einheitswerts“ for every year and was a
# placeholder — always 0, although from 2025 the figure is in the books.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-404-$(date +%s%N | cut -c1-13)"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
K='[l for l in d["kurzungen"] if l["kennziffer"] == "5200"][0]'

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier679-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Stadtkasse","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'; SUP=$(field "d['id']")
exp() { # number category gross date
  AS POST "/api/v1/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"$1\",\"description\":\"$2\",\"invoiceDate\":\"$4\",\"paidAt\":\"$4\",\"category\":\"$2\",\"netAmount\":$3,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":$3,\"confirmDuplicate\":true}"
  [[ "$STATUS" == "201" ]] || fail "expense $2 → $STATUS"
}
exp G-24 Grundsteuer 400 2024-02-15
exp G-25a Grundsteuer 380 2025-02-15; exp G-25b "Grundsteuer Nachzahlung" 120 2025-08-15; exp B-25 Büromaterial 250 2025-03-01

note "=== 2025: the Grundsteuer of the year ==="
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2025"
assert_eq "the reduction is 500 € — the two Grundsteuer expenses (was 0, a placeholder)" "$(field "($K['amount'], $K['source'])")" "(500, 'computed')"
echo "$BODY" | grep -q "als Betriebsausgabe erfasste Grundsteuer" && pass "the line names the rule of 2025" || fail "the line still names the Einheitswert"
assert_eq "profit −750 €, less the 500 €: a Gewerbeertrag of −1 250 €" "$(field "(d['totals']['gewinnVorKorrektur'], d['totals']['kurzungenTotal'], d['totals']['gewerbeertrag'])")" "(-750, 500, -1250)"
AS GET "/api/v1/accounting/gewst?companyId=$C&year=2025"
assert_eq "the trade-tax form takes the same Gewerbeertrag" "$(field "d['gewerbeertrag']")" "-1250"

note "=== 2024: the old rule ==="
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2024"
assert_eq "no figure — the Einheitswert is not known here" "$(field "($K['amount'], $K['source'])")" "(0, 'placeholder')"
echo "$BODY" | grep -q "1,2% des Einheitswerts (§ 9 Nr. 1 GewStG, bis 2024)" && pass "… and the line says until when that held" || fail "2024: the line"

summary
