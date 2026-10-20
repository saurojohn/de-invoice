#!/bin/bash
# Tier 714 — an issued invoice does not become a draft again
#
# The status „Entwurf“ was open to every invoice. A draft is in no return —
# not the UStVA, the EÜR, DATEV — and in no list of what is owed. Measured: an
# invoice of 01.08.2026, issued, set back to „Entwurf“ in October: 200, and it
# was gone from the August UStVA. Since Tier 694 „Storniert“ makes a credit
# note for the same reason. On its issue day it may still go back, as it may
# be edited then (Tier 477 / 697): nothing paid, no credit note, not e-mailed.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-434-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier714-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
status_of() { q "select status from \"Invoice\" where id='$1'"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { # issueDate → I (issued)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"dueDate\":\"2026-12-31\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
ustva_aug() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=8"; P "round(float(d['umsatzsteuer']), 2)"; }
inv 2026-08-01; AUG=$I
inv "$TODAY"; FRESH=$I
inv "$TODAY"; PAID=$I
AS POST "/api/v1/invoices/$PAID/payments?companyId=$C" "{\"amount\":100,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
AS POST "/api/v1/invoices/$AUG/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'
CN=$(json_field "$BODY" id)
assert_eq "fixture: issued — of August, of today, of today with a payment; a credit note" \
  "$(status_of "$AUG")/$(status_of "$FRESH")/$(status_of "$PAID")/$(status_of "$CN")" "sent/sent/sent/sent"
assert_eq "fixture: the August UStVA holds its 190 € tax" "$(ustva_aug)" "190.0"

AS PUT "/api/v1/invoices/$AUG/status?companyId=$C" '{"status":"draft"}'
assert_eq "the invoice of August: not a draft again (was 200)" "$STATUS/$(status_of "$AUG")" "400/sent"
assert_eq "…the answer says why and what to do" "$(P "'Voranmeldung' in d['message'] and 'Gutschrift' in d['message']")" "True"
assert_eq "…and the August UStVA keeps its 190 € (a draft would leave it at 0)" "$(ustva_aug)" "190.0"
AS PUT "/api/v1/invoices/$PAID/status?companyId=$C" '{"status":"draft"}'
assert_eq "today's with a payment: not either" "$STATUS/$(status_of "$PAID")" "400/sent"
AS PUT "/api/v1/invoices/$CN/status?companyId=$C" '{"status":"draft"}'
assert_eq "the credit note (settled at once): not either" "$STATUS/$(status_of "$CN")" "400/sent"
AS PUT "/api/v1/invoices/$FRESH/status?companyId=$C" '{"status":"draft"}'
assert_eq "today's, untouched: back to draft, as it may be edited today" "$STATUS/$(status_of "$FRESH")" "200/draft"

summary
