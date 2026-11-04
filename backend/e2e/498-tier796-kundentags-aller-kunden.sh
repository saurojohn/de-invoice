#!/bin/bash
# Tier 796 — the tag chips of the customer list are the tags of all the
# company's customers
#
# The list page counted the tags of the 50 customers it showed: a company with
# more customers was not offered a tag that only customers on another page had
# (locally the fixture's VIP was not offered once the test database held more
# than 50 customers). GET /customers/tags counts them over the whole company.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-498-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
company() { # suffix → "user company"
  local body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier796-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  curl -sS -o "$D/reg" -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body"
  python3 -c "import json;d=json.load(open('$D/reg'));print(d['user']['id'], d['user']['companyId'])"
}
read -r U C < <(company a)
read -r U2 C2 < <(company b)
# 60 customers (the list is by name); the last one alone has "Nur-Alt", ten
# have "VIP", one an empty tag
q "insert into \"Customer\"(id,\"companyId\",type,name,address,contact,tags,\"createdAt\",\"updatedAt\")
   select gen_random_uuid()::text,'$C','business','$TAG Kunde '||lpad(n::text,2,'0'),'{}'::jsonb,'{}'::jsonb,
          case when n = 60 then array['Nur-Alt'] when n <= 10 then array['VIP'] when n = 11 then array[''] else '{}'::text[] end,
          now(), now()
     from generate_series(1,60) n" >/dev/null
q "insert into \"Customer\"(id,\"companyId\",type,name,address,contact,tags,\"createdAt\",\"updatedAt\")
   values (gen_random_uuid()::text,'$C2','business','$TAG fremd','{}'::jsonb,'{}'::jsonb,array['Fremd'],now(),now())" >/dev/null
tags() { curl -sS "$API/api/v1/customers/tags?companyId=$2" -H "x-user-id: $1" -H "x-company-id: $2"; }
st=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customers/tags?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "GET /customers/tags (was 404)" "$st" "200"
assert_eq "every tag of the company, the most used first" "$(tags $U $C | python3 -c "import json,sys;print(json.load(sys.stdin))")" "[{'tag': 'VIP', 'count': 10}, {'tag': 'Nur-Alt', 'count': 1}]"
page1=$(curl -sS "$API/api/v1/customers?companyId=$C&page=1&pageSize=50" -H "x-user-id: $U" -H "x-company-id: $C" | python3 -c "import json,sys;print(sum('Nur-Alt' in (c.get('tags') or []) for c in json.load(sys.stdin)['data']))")
assert_eq "…though the customer with Nur-Alt is not on the first page of 50" "$page1" "0"
assert_eq "another company's tags are not among them" "$(tags $U2 $C2 | python3 -c "import json,sys;print([r['tag'] for r in json.load(sys.stdin)])")" "['Fremd']"
st=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customers/tags?companyId=$C" -H "x-user-id: $U2" -H "x-company-id: $C2")
assert_eq "…and its user does not read them" "$([ "$st" = 403 ] || [ "$st" = 400 ] && echo refused || echo "$st")" "refused"
summary
