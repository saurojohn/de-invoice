#!/bin/bash
# Tier 978 — § 13b UStG shifts the tax only to an Unternehmer
#
# § 13b Abs. 5 Satz 1 UStG: the recipient owes the tax if he is an
# Unternehmer or a juristische Person. Measured: a 5 000 € Bauleistung with
# "Steuerschuldnerschaft des Leistungsempfängers" to a customer entered as a
# private person was issued at 0 % and declared in Kz 60 — the 950 € the
# supplier owes for it (§ 13a Abs. 1 Nr. 1 UStG) in no Kennzahl.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-665-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-3d +%F 2>/dev/null || TZ=Europe/Berlin date -d '3 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier978-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
cust() { # type name
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$2\",\"type\":\"$1\",\"address\":{\"street\":\"Ring 1\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
  K=$(json_field "$BODY" id)
}
rc() { # customerId
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$D\",\"deliveryDate\":\"$D\",\"reverseCharge\":true,\"notes\":\"Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)\",\"items\":[{\"description\":\"Bauleistung Dach\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":5000,\"vatRate\":0}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
cust individual "Max Privat"
rc "$K"
assert_eq "a § 13b invoice to a private person: refused (was 200, Kz 60)" "$STATUS/$(P "'13b Abs. 5' in d['message']")" "400/True"
AS GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "…it stays a draft" "$(json_field "$BODY" status)" "draft"
cust business "Bau GmbH"
rc "$K"
assert_eq "the same invoice to a business: issued" "$STATUS" "200"
AS GET "/api/v1/ustva/compute?companyId=$C&year=${D:0:4}&month=$((10#${D:5:2}))"
assert_eq "…the UStVA: Kz 60 holds the business invoice only" "$(P "float({k['kz']: k['value'] for k in d['kennzahlen']}.get('60') or 0)")" "5000.0"

summary
