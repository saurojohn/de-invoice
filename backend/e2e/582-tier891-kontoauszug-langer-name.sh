#!/bin/bash
# Tier 891 — the statement's customer block keeps clear of the address
#
# Found by reading a statement for the long-named customer of Tier 885: the
# „Kunde“ value ran across the page on one line, and the address block top
# right (four lines once the name wraps) printed its street and town over it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-582-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier891-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
DIR=$(mktemp -d)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Bundesanstalt für Immobilienaufgaben – Direktion Mitte, Sparte Facility Management Liegenschaft Kaserne Nord","type":"business","address":{"street":"Ellerstraße 56, Gebäude C, 3. OG, Raum 312","city":"Bonn","postalCode":"53119","country":"DE"}}'
K=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['id'])" "$BODY")
curl -sS "$API/api/v1/customers/$K/statement.pdf?companyId=$C&from=2026-01-01&to=2026-12-31" -H "x-user-id: $U" -H "x-company-id: $C" -o "$DIR/s.pdf"
POS=$(pdf_text "$DIR/s.pdf" --pos)
assert_eq "the „Kunde“ value wraps in its column (was: one line across the page, under the address)" \
  "$(python3 -c "
import json,sys
runs=json.loads(sys.argv[1])[0]
left=[r for r in runs if r['s'].startswith('Bundesanstalt') and r['x']<100]
print(len(left)==1 and len(left[0]['s'])<=45, left[0]['s'] if left else None)" "$POS")" "True Bundesanstalt für Immobilienaufgaben –"
assert_eq "the address ends above the opening balance" \
  "$(python3 -c "
import json,sys
runs=json.loads(sys.argv[1])[0]
y=lambda p: next(r['y'] for r in runs if r['s'].startswith(p))
print(y('53119 Bonn') < y('Anfangsbestand'))" "$POS")" "True"
rm -rf "$DIR"
summary
