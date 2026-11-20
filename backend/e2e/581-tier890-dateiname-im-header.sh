#!/bin/bash
# Tier 890 — a file name in a header, as RFC 6266 writes it
#
# Found by downloading a customer's statement with a customer number of the
# company's own choosing: „K–1“ (an en dash) answered 500 — Node refuses a
# character above U+00FF in a header —, „K"2“ ended the quoted name (the file
# was saved as „Kontoauszug_K“), „Müller 3“ arrived as „M?ller“. An
# attachment named „Rechnung Müller.pdf“ was sent as
# filename="Rechnung%20M%C3%BCller.pdf", which the application's own
# download code saved under that name.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-581-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier890-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
DIR=$(mktemp -d)
statement() {
  local body
  body=$(python3 -c "import json,sys;print(json.dumps({'name':'Nummer '+sys.argv[1],'customerNumber':sys.argv[1],'type':'business','address':{'street':'Weg 1','city':'Köln','postalCode':'50667','country':'DE'}}))" "$1")
  AS POST "/api/v1/customers?companyId=$C" "$body"
  local id; id=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['id'])" "$BODY")
  curl -sS -o /dev/null -D "$DIR/h" "$API/api/v1/customers/$id/statement.pdf?companyId=$C&from=2026-01-01&to=2026-12-31" -H "x-user-id: $U" -H "x-company-id: $C"
  echo "$(head -1 "$DIR/h" | awk '{print $2}') $(grep -i '^content-disposition:' "$DIR/h" | sed 's/^[^:]*: //' | tr -d '\r')"
}
assert_eq "„K–1“: 200, an ASCII name and the name as it is (was: 500)" "$(statement 'K–1')" \
  "200 attachment; filename=\"Kontoauszug_K_1_2026-01-01_2026-12-31.pdf\"; filename*=UTF-8''Kontoauszug_K%E2%80%931_2026-01-01_2026-12-31.pdf"
assert_eq "„K\"2“: the quote does not end the name" "$(statement 'K"2')" \
  "200 attachment; filename=\"Kontoauszug_K_2_2026-01-01_2026-12-31.pdf\"; filename*=UTF-8''Kontoauszug_K%222_2026-01-01_2026-12-31.pdf"
assert_eq "„Müller 3“: ue in the ASCII name, ü in the UTF-8 one (was: M?ller)" "$(statement 'Müller 3')" \
  "200 attachment; filename=\"Kontoauszug_Mueller 3_2026-01-01_2026-12-31.pdf\"; filename*=UTF-8''Kontoauszug_M%C3%BCller%203_2026-01-01_2026-12-31.pdf"
assert_eq "an ASCII name: the header as before" "$(statement 'K-4')" \
  "200 attachment; filename=\"Kontoauszug_K-4_2026-01-01_2026-12-31.pdf\""
rm -rf "$DIR"
summary
