#!/bin/bash
# Tier 513 — a recurring invoice follows the company's VAT treatment
#
# Tier 480 / 487: an invoice of a Kleinunternehmer (§ 19 UStG) carries no
# VAT, and one under the company's default "reverse charge" (§ 13b) is
# flagged and at 0 %. That was done in InvoiceService.create — the recurring
# run builds its invoices itself. Measured before: a Kleinunternehmer's
# template with a 19 % line produced an invoice of 100 € + 19 € VAT (a tax
# shown without being owed, § 14c UStG), and a reverse-charge company's
# recurring invoice was a plain 19 % invoice without the flag.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-298-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

company() { # suffix vatMode
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier513-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"defaultVatMode\":\"$2\"}"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
run_template() { # [customer-extra-json] → the generated invoice's "total/totalVat/item rate/reverseCharge"
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"${1:-},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
  local k; k=$(json_field "$BODY" id)
  AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"customerId\":\"$k\",\"name\":\"Wartung\",\"interval\":\"monthly\",\"dayOfMonth\":1,\"startDate\":\"2026-08-01\",\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Monat\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local t; t=$(json_field "$BODY" id)
  AS POST "/api/v1/recurring-invoices/$t/run?companyId=$C" '{}'
  RUN_STATUS=$STATUS
  q "select i.total::numeric(12,2)||'/'||i.\"totalVat\"::numeric(12,2)||'/'||(select max(\"vatRate\")::numeric(5,2) from \"InvoiceItem\" where \"invoiceId\"=i.id)||'/'||i.\"reverseCharge\" from \"Invoice\" i where i.\"recurringInvoiceId\"='$t'"
}

note "=== a Kleinunternehmer ==="
company ku kleinunternehmer
[[ -n "${C:-}" ]] && pass "fixture: a Kleinunternehmer" || { fail "register"; summary; exit 1; }
assert_eq "the recurring invoice: 100 €, no VAT (was 119 € with 19 € VAT)" "$(run_template)" "100.00/0.00/0.00/false"

note "=== a company whose default is reverse charge ==="
company rc reverseCharge
assert_eq "…: 100 €, 0 %, flagged § 13b (was a plain 19 % invoice)" "$(run_template)" "100.00/0.00/0.00/true"

note "=== a company whose default is igL ==="
company igl igL
run_template >/dev/null
assert_eq "a customer without a foreign EU USt-IdNr.: the run is refused" "$RUN_STATUS" "400"
OUT=$(run_template ',"vatId":"FR40303265045"')
assert_eq "to a French USt-IdNr.: 100 €, 0 %" "$OUT" "100.00/0.00/0.00/false"
assert_eq "…flagged as innergemeinschaftliche Lieferung" \
  "$(q "select \"euTransaction\" from \"Invoice\" where \"companyId\"='$C' and \"recurringInvoiceId\" is not null")" "t"

note "=== a regular company is unchanged ==="
company std standard
assert_eq "119 € with 19 € VAT" "$(run_template)" "119.00/19.00/0.19/false"

summary
