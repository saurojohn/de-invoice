#!/bin/bash
# Tier 910 — the Hebesatz of a year
#
# Measured: the Hebesatz was one number (settings.hebesatz) read for every
# year. A GmbH entered its municipality's new 470 % with the 2026 prepayments,
# and its 2025 KSt 1 — Gewerbesteuer, the amount to pay, the tax provision of a
# year already closed — was computed anew at 470 %: 14 000 € became 16 450 €.
# Now the GewSt settings keep it per year (settings.hebesatzAb): a Hebesatz
# holds from the year it is entered for until a later one.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-598-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier910-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 598","type":"business","address":{"street":"Weg 1","postalCode":"10115","city":"Berlin","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-03-01\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100050,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: a GmbH with 100 050 € net in 2025" "$STATUS" "200"

# kst YEAR → "hebesatz gewst"
kst() { AS GET "/api/v1/accounting/kst1?companyId=$C&year=$1"; python3 -c "import sys,json;t=json.loads(sys.argv[1])['totals'];print(t['hebesatz'], t['gewst'])" "$BODY"; }
setH() { AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$1,\"q1\":0,\"q2\":0,\"q3\":0,\"q4\":0,\"hebesatz\":$2}"; }

assert_eq "2025, nothing entered: 400 %, GewSt 14 000" "$(kst 2025)" "400 14000"
setH 2026 470
assert_eq "470 % entered with the 2026 settings: answered for 2026" "$STATUS/$(python3 -c "import sys,json;print(json.loads(sys.argv[1])['hebesatz'])" "$BODY")" "200/470"
assert_eq "2025 keeps 400 %, GewSt 14 000 (was 470 %, 16 450)" "$(kst 2025)" "400 14000"
assert_eq "2026: 470 %" "$(kst 2026 | cut -d' ' -f1)" "470"
assert_eq "2027: still 470 % (until a later one)" "$(kst 2027 | cut -d' ' -f1)" "470"
setH 2025 450
assert_eq "450 % entered for 2025: 2025 at 450 %, GewSt 15 750" "$(kst 2025)" "450 15750"
assert_eq "…2026 keeps its 470 %" "$(kst 2026 | cut -d' ' -f1)" "470"

note "=== a Hebesatz stored before (one number) holds for the years before the first entry ==="
q "update \"Company\" set settings = (coalesce(settings,'{}'::jsonb) - 'hebesatzAb') || '{\"hebesatz\":480}'::jsonb where id='$C'" >/dev/null
assert_eq "the old number answers for every year" "$(kst 2024 | cut -d' ' -f1)/$(kst 2026 | cut -d' ' -f1)" "480/480"
setH 2026 490
assert_eq "490 % for 2026: 2025 keeps the 480 % stored before" "$(kst 2025 | cut -d' ' -f1)/$(kst 2026 | cut -d' ' -f1)" "480/490"

summary
