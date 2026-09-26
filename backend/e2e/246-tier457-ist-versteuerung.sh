#!/bin/bash
# Tier 457 — Ist-Versteuerung: output tax when the money comes in (§ 20 UStG)
#
# A business below the § 20 threshold (or a freelancer) may be allowed to owe
# the output tax in the period the payment arrives (§ 13 Abs. 1 Nr. 1 b UStG)
# instead of the period of the invoice. Measured before: the app knew only
# the Soll-Versteuerung — there was no setting (PUT besteuerungsart: 400), and
# the UStVA of March declared 190 € on an invoice paid in April and the full
# 7 € on a half-paid one.
# Now `Company.besteuerungsart` = 'ist' puts taxed sales into the period of
# their payments (the EÜR's payment walk, euer-zufluss.ts — Tier 454), per
# rate. Zero-rated sales (§ 4, igL, § 13b) stay at the invoice date; the input
# tax is unchanged (§ 15 — at the invoice). 'soll' (the default) is as before.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-246-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier457-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
sent() { # issueDate net rate → id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"bank_transfer\"}"; [[ "$STATUS" == 201 ]] || fail "payment $*: $STATUS $BODY"; }
A=$(sent 2026-03-10 1000 0.19); pay "$A" 1190 2026-04-05     # paid the month after
B=$(sent 2026-03-12 100 0.07);  pay "$B" 53.50 2026-03-20    # half paid
sent 2026-03-18 500 0 >/dev/null                              # § 4 exempt, unpaid
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Ware","invoiceDate":"2026-03-05","netAmount":200,"vatRate":0.19,"vatAmount":38,"grossAmount":238}'

ustva() { # month → "19%net/vat 7%net/vat exempt vorsteuer"
  AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=$1"
  py '
r={round(x["rate"],2):x for x in d["salesByRate"]}
f=lambda k:"%g/%g"%(round(r[k]["net"],2),round(r[k]["vat"],2)) if k in r else "0/0"
print(f(0.19), f(0.07), "%g" % d["otherExempt"], "%g" % round(d["vorsteuerSum"],2))'
}

note "=== Soll-Versteuerung (the default): by invoice date ==="
assert_eq "March: A, B in full, the exempt sale, input tax 38" "$(ustva 3)" "1000/190 100/7 500 38"
assert_eq "April: nothing" "$(ustva 4)" "0/0 0/0 0 0"

note "=== the setting ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"ist"}'
assert_eq "besteuerungsart 'ist' (was 400: no such setting)" "$STATUS" "200"
AS GET "/api/v1/companies/$C?companyId=$C"
assert_eq "…stored" "$(py 'print(d.get("besteuerungsart"))')" "ist"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"irgendwas"}'
assert_eq "an unknown value is refused" "$STATUS" "400"

note "=== Ist-Versteuerung: by payment ==="
assert_eq "March: half of B; the exempt sale and the input tax as before (was 1000/190 100/7)" "$(ustva 3)" "0/0 50/3.5 500 38"
assert_eq "April: A, paid then (was nothing)" "$(ustva 4)" "1000/190 0/0 0 0"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=3"
assert_eq "the return says which" "$(py 'print(d.get("besteuerungsart"))')" "ist"

note "=== back to Soll ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"soll"}'
assert_eq "March as before" "$(ustva 3)" "1000/190 100/7 500 38"

summary
