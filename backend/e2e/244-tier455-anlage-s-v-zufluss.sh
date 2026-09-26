#!/bin/bash
# Tier 455 — Anlage S and Anlage V count payments, as the EÜR (§ 11 EStG)
#
# Tier 454 moved the EÜR to the cash principle. A freelancer's Anlage S is
# that EÜR (§ 18 EStG income, § 4 Abs. 3), and rental income (§ 21) is counted
# when received — but both annexes still took invoices at their issue date
# and expenses at their invoice date. Measured before, same fixtures as 243:
#   - 2025: 1 000 income from an invoice paid only in 2026 (was) — and the
#     300 bill paid in 2026 as a 2025 cost
#   - 2026: an unpaid invoice (200) and an unpaid bill (400)
#   - so Anlage S said another Gewinn than the EÜR it is built from
# Now both use the EÜR's selection (euer-zufluss.ts) and say so.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-244-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier455-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Mieter\",\"type\":\"individual\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'; S=$(json_field "$BODY" id)
sent() { # issueDate net → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
bill() { # invoiceDate net [paidAt]
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-'$RANDOM'","description":"Ware","invoiceDate":"'$1'","netAmount":'$2',"vatRate":0.19,"category":"Material"'${3:+,\"paidAt\":\"$3\"}'}'
  [[ "$STATUS" == 201 ]] || fail "bill $*: $STATUS $BODY"
}
A=$(sent 2025-11-10 1000)
AS POST "/api/v1/invoices/$A/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-01-15","paymentMethod":"bank_transfer"}'
sent 2026-04-01 200 >/dev/null
bill 2025-12-20 300 2026-01-10
bill 2026-06-01 400

s_() { AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=$1"; py 'e=d["totals"];print("%g/%g" % (e["einnahmenTotal"], e["ausgabenTotal"]))'; }
v_() { AS GET "/api/v1/accounting/anlage-v?companyId=$C&year=$1"; py 'e=d["totals"];print("%g/%g" % (e["einnahmenTotal"], e["werbungskostenTotal"]))'; }
g_() { AS GET "/api/v1/accounting/$1?companyId=$C&year=2026"; py 'print(d["totals"].get("gewinn", d["totals"].get("ueberschuss")))'; }

note "=== Anlage S ==="
assert_eq "2025: nothing was paid (was 1000/300)" "$(s_ 2025)" "0/0"
assert_eq "2026: the invoice and the bill paid in 2026 (was 200/400)" "$(s_ 2026)" "1000/300"
assert_eq "the same Gewinn as the EÜR" "$(g_ anlage-s)" "$(g_ euer)"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2026"
assert_eq "…counted when paid; 1 invoice, 1 bill still open" \
  "$(py 'print(d.get("prinzip"), (d["counts"].get("unbezahlt") or {}).get("invoices"), (d["counts"].get("unbezahlt") or {}).get("expenses"))')" "zufluss 1 1"

note "=== Anlage V ==="
assert_eq "2025: nothing received (was 1000/300)" "$(v_ 2025)" "0/0"
assert_eq "2026: the rent received and the bill paid (was 200/400)" "$(v_ 2026)" "1000/300"
AS GET "/api/v1/accounting/anlage-v?companyId=$C&year=2026"
assert_eq "…counted when paid" "$(py 'print(d.get("prinzip"))')" "zufluss"

summary
