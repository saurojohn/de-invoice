#!/bin/bash
# Tier 911 — Zusammenveranlagung by year
#
# Measured: whether spouses are assessed together was one flag read for every
# year. Ticking it on the 2026 page of Anlage KAP doubled the Sparer-
# Pauschbetrag of 2025 as well (1 000 € → 2 000 €), and the Anlage Kind of
# 2025 counted the doubled child allowances. The choice is made for each
# Veranlagungsjahr (§ 26 EStG). Now the pages send the year shown; a choice
# holds from that year until a later one.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-599-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier911-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
# kap YEAR → the Sparer-Pauschbetrag of that year; kind YEAR → together?
kap() { AS GET "/api/v1/accounting/anlage-kap?companyId=$C&year=$1"; python3 -c "import sys,json;print(json.loads(sys.argv[1])['sparerPauschbetrag']['voll'])" "$BODY"; }
kind() { AS GET "/api/v1/accounting/anlage-kind?companyId=$C&year=$1"; python3 -c "import sys,json;print(json.loads(sys.argv[1])['saetze']['zusammenveranlagung'])" "$BODY"; }
together() { AS PUT "/api/v1/accounting/zusammenveranlagung?companyId=$C" "{\"zusammenveranlagung\":$1${2:+,\"year\":$2}}"; }

assert_eq "nothing chosen: 1 000 € in 2025 and 2026" "$(kap 2025)/$(kap 2026)" "1000/1000"
together true 2026
assert_eq "assessed together from 2026: saved" "$STATUS" "200"
assert_eq "2026: 2 000 €; 2025 keeps 1 000 € (was 2 000 €)" "$(kap 2026)/$(kap 2025)" "2000/1000"
assert_eq "…2027 too: 2 000 € (until a later choice)" "$(kap 2027)" "2000"
assert_eq "Anlage Kind: together in 2026, not in 2025 (was together)" "$(kind 2026)/$(kind 2025)" "True/False"
together false 2028
assert_eq "apart from 2028: 2028 1 000 €, 2027 still 2 000 €" "$(kap 2028)/$(kap 2027)" "1000/2000"
together "\"ja\"" 2026
assert_eq "a non-boolean is refused" "$STATUS" "400"
together true 1999
assert_eq "a year out of range is refused" "$STATUS" "400"

note "=== the flag stored before (no year) holds for the years before the first choice ==="
q "update \"Company\" set settings = (coalesce(settings,'{}'::jsonb) - 'zusammenveranlagungAb') || '{\"zusammenveranlagung\":true}'::jsonb where id='$C'" >/dev/null
assert_eq "the old flag answers for every year" "$(kap 2024)/$(kap 2026)" "2000/2000"
together false 2026
assert_eq "apart from 2026: 2025 keeps the old flag" "$(kap 2025)/$(kap 2026)" "2000/1000"

summary
