#!/bin/bash
# Tier 509 — the Jahresüberschuss is not counted twice in the equity
#
# The Bilanz showed the whole equity as one Saldoposten (Aktiva − sonstige
# Passiva) and left 2400 Jahresüberschuss empty; the E-Bilanz sent that
# Saldoposten (as retainedEarnings) next to the Jahresüberschuss (netIncome)
# from the G+V. Measured before (spec 292's fixture): the Passiva facts
# summed to 18 917,50 against a total of 11 900 — the result twice.
#
# Now 2400 = the G+V's Jahresüberschuss and the Saldoposten is the rest of
# the equity; the E-Bilanz's Passiva facts add up to its total.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-295-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier509-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-06-02\",\"items\":[{\"description\":\"Projekt\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'

note "=== Bilanz ==="
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2025"
ek() { P "[None if l['amount'] is None else float(l['amount']) for s in d['passiva'] for l in s['lines'] if l['position']=='$1'][0]"; }
assert_eq "2400 Jahresüberschuss 7 017,50 (was empty)" "$(ek 2400)" "7017.5"
assert_eq "Saldoposten: the rest of the equity, 0 here (was 7 017,50 — the result in it)" "$(ek EKV)" "0.0"
assert_eq "the equity in total unchanged: 7 017,50" "$(P "float(d['totals']['eigenkapital'])")" "7017.5"
assert_eq "Aktiva = Passiva" "$(P "abs(d['totals']['aktiva'] - d['totals']['passiva']) < 0.01")" "True"

note "=== E-Bilanz ==="
AS GET "/api/v1/accounting/ebilanz?companyId=$C&year=2025"
assert_eq "the Passiva facts add up to the total (were 18 917,50 against 11 900)" \
  "$(P "(round(sum(float(p['value'] or 0) for p in d['positions'] if p['source'].startswith('bilanz.passiva') and p['source'] != 'bilanz.passiva.summe'), 2), float([p['value'] for p in d['positions'] if p['source']=='bilanz.passiva.summe'][0]))")" \
  "(11900.0, 11900.0)"

summary
