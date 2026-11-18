#!/bin/bash
# Tier 867 — a search snippet carries no HTML from the data
#
# The snippets are rendered as HTML for their <mark>s (GlobalSearch.tsx,
# the customer list). Tier 317 escaped the text before marking — but when a
# product was found by its description and no word of its name was marked,
# the snippet was the raw name. Measured on Tier 866: a product named
# `<b onmouseover=alert(1)>X</b>`, searched for a word of its description,
# came back as that tag; the search box ran it for everyone in the company.
# The invoice number had the same fallback.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-559-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier867-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
PROD=$(python3 -c 'import json;print(json.dumps({"name":"<b onmouseover=alert(1)>X</b>","description":"Holzstuhl aus Eiche","basePrice":10,"vatRate":0.19,"unit":"Stk"}))')
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/products?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$PROD")
assert_eq "fixture: a product with a tag for a name" "$STATUS" "201"
snippets() { # path → the snippets, one per line
  curl -sS "$API$1" -H "x-user-id: $U" -H "x-company-id: $C" | python3 -c "
import sys,json
d=json.load(sys.stdin)
hits=[h for g in d['groups'] for h in g['hits']] if 'groups' in d else (d.get('hits') or d if isinstance(d,list) else d.get('results',[]))
for h in hits: print(h.get('snippet',''))"
}
S1=$(snippets "/api/v1/search/global?companyId=$C&q=eiche")
assert_eq "found by its description: the name as text (was: the raw tag)" "$S1" "&lt;b onmouseover=alert(1)&gt;X&lt;/b&gt;"
S2=$(snippets "/api/v1/search/global?companyId=$C&q=holzstuhl")
assert_eq "…and no tag in any snippet of the company" "$(printf '%s\n%s\n' "$S1" "$S2" | grep -c '<b')" "0"
assert_eq "the invoice number's fallback is escaped too" \
  "$(grep -c 'snippet = markTermsInText(r.invoiceNumber, \[\])' "$SCRIPT_DIR/../src/modules/search/search.service.ts")/$(grep -cE 'snippet = r\.(name|invoiceNumber)$' "$SCRIPT_DIR/../src/modules/search/search.service.ts")" "1/0"
summary
