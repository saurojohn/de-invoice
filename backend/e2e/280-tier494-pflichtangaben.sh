#!/bin/bash
# Tier 494 — an invoice is issued only with its mandatory details (§ 14 Abs. 4 UStG)
#
# Measured before: a freshly registered company (empty address, no
# Steuernummer / USt-IdNr.) issued a 1 190 € invoice to a customer without an
# address — PUT …/status {"status":"sent"} 200.
#
# Now issuing returns 400 with the list of what is missing; a
# Kleinbetragsrechnung (≤ 250 € gross, § 33 UStDV) needs only the supplier's
# name and address; a recurring template that issues its invoices fails its
# run the same way.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-280-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier494-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a freshly registered company (no address, no tax number)" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Ohne Adresse\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
draft() { # customer price
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  json_field "$BODY" id
}
issue() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"sent"}'; }

note "=== 1 190 € with nothing filled in ==="
I=$(draft "$K" 1000); issue "$I"
assert_eq "issuing is refused (was 200)" "$STATUS" "400"
assert_eq "…naming all four gaps" \
  "$(P "[x in d['message'] for x in ['Anschrift Ihres Unternehmens', 'Steuernummer oder USt-IdNr.', 'Anschrift des Kunden', '§ 14 Abs. 4 UStG']]")" "[True, True, True, True]"
AS GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "the invoice stays a draft" "$(P "d['status']")" "draft"

note "=== a Kleinbetragsrechnung needs the supplier's name and address only ==="
I2=$(draft "$K" 200)   # 238 € gross
issue "$I2"
assert_eq "238 €: refused while the company has no address" "$STATUS" "400"
assert_eq "…for the address only" "$(P "('Anschrift Ihres Unternehmens' in d['message'], 'Steuernummer' in d['message'], 'Anschrift des Kunden' in d['message'])")" "(True, False, False)"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"address":{"street":"Hauptstr. 1","postalCode":"10115","city":"Berlin","country":"DE"}}'
issue "$I2"
assert_eq "…issued once it has one" "$STATUS" "200"

note "=== above 250 € the tax number and the customer's address ==="
issue "$I"
assert_eq "still refused" "$STATUS" "400"
assert_eq "…for the tax number and the customer's address" "$(P "('Anschrift Ihres Unternehmens' in d['message'], 'Steuernummer' in d['message'], 'Anschrift des Kunden' in d['message'])")" "(False, True, True)"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"taxId":"12/345/67890"}'
AS PUT "/api/v1/customers/$K?companyId=$C" '{"address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
issue "$I"
assert_eq "issued once both are there" "$STATUS" "200"

note "=== a recurring template that issues its invoices ==="
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Abo ohne Adresse\",\"type\":\"business\"}"; K2=$(json_field "$BODY" id)
AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"customerId\":\"$K2\",\"name\":\"Wartung\",\"interval\":\"monthly\",\"dayOfMonth\":1,\"startDate\":\"2026-09-01\",\"invoiceStatus\":\"sent\",\"sendEmail\":false,\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Monat\",\"unitPrice\":500,\"vatRate\":0.19}]}"
T=$(json_field "$BODY" id)
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "the run is refused (customer without address)" "$STATUS" "400"
assert_eq "…and creates no invoice" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$T'")" "0"
AS PUT "/api/v1/customers/$K2?companyId=$C" '{"address":{"street":"Weg 3","postalCode":"50667","city":"Köln","country":"DE"}}'
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "…and goes through once the address is there" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select count(*) from \"Invoice\" where \"recurringInvoiceId\"='$T' and status='sent'")" "1"

summary
