#!/bin/bash
# Tier 498 — an igL or an EU reverse-charge invoice states both USt-IdNrn.
#
# § 14a Abs. 1 / Abs. 3 UStG: an invoice for an innergemeinschaftliche
# Lieferung, or for a B2B service whose tax the customer in another member
# state owes, must carry the USt-IdNr. of the supplier and of the recipient.
# Measured before: Tier 494 accepted a Steuernummer instead of the supplier's
# USt-IdNr. — a company with a Steuernummer only issued an igL invoice and an
# EU reverse-charge invoice (200), the PDF showing no USt-IdNr. of its own;
# an EU reverse-charge invoice to a customer without a USt-IdNr. too.
#
# Now issuing refuses them (400) naming what is missing; a domestic invoice
# and a domestic § 13b invoice keep accepting the Steuernummer.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-284-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier498-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"   # address + Steuernummer, no USt-IdNr.
[[ -n "${C:-}" ]] && pass "fixture: a company with a Steuernummer only" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
customer() { # name country [vatId]
  local v=""; [[ -n "${3:-}" ]] && v=",\"vatId\":\"$3\""
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\"$v,\"address\":{\"street\":\"Rue 1\",\"postalCode\":\"75001\",\"city\":\"Stadt\",\"country\":\"$2\"}}"
  json_field "$BODY" id
}
issue() { # customer flags-json-fragment → status
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-10-02\"$2,\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
}
FR=$(customer Paris FR FR40303265045)
FRX=$(customer "Paris ohne USt-IdNr" FR)
DE=$(customer Bau DE)

note "=== a Steuernummer does not do for an igL ==="
issue "$FR" ',"euTransaction":true'
assert_eq "igL: refused (was 200)" "$STATUS" "400"
assert_eq "…for the company's USt-IdNr." "$(P "'USt-IdNr. Ihres Unternehmens' in d['message']")" "True"

note "=== nor for an EU reverse-charge service ==="
issue "$FR" ',"reverseCharge":true'
assert_eq "EU § 13b service: refused (was 200)" "$STATUS" "400"
issue "$FRX" ',"reverseCharge":true'
assert_eq "…and to a customer without a USt-IdNr. it names that too" \
  "$(P "('USt-IdNr. Ihres Unternehmens' in d['message'], 'USt-IdNr. des Kunden' in d['message'])")" "(True, True)"

note "=== domestic invoices keep the Steuernummer ==="
issue "$DE" ',"reverseCharge":true'
assert_eq "domestic § 13b (Bauleistung): issued" "$STATUS" "200"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$DE\",\"issueDate\":\"2026-10-02\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
assert_eq "domestic 19 %: issued" "$STATUS" "200"

note "=== with the company's USt-IdNr. ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789"}'
issue "$FR" ',"euTransaction":true'
assert_eq "igL: issued" "$STATUS" "200"
issue "$FR" ',"reverseCharge":true'
assert_eq "EU § 13b service: issued" "$STATUS" "200"

summary
