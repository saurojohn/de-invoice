#!/bin/bash
# Tier 695 — a credit note states what it corrects
#
# Measured on the Storno credit note of Tier 694, for a June invoice over
# 10 Std consulting, supplied 28.05.2026, credited 19.10.2026:
#   - the lines said "10,00 Stück" — the full credit note wrote every unit
#     as Stück;
#   - no Leistungsdatum on the PDF, and XRechnung / ZUGFeRD stated the credit
#     note's own day as the period of the service (InvoicePeriod 19.10.);
#   - "Bezug zu Rechnung: INV-…" without the invoice's date;
#   - the company's account under "Zahlungsinformationen", as if the
#     customer were to pay.
# Now the credit note takes the invoice's units and its Leistungsdatum (or
# -zeitraum; the issue date when none was recorded, as the invoice states
# it), names the invoice's date, and shows the account as "Bankverbindung".
# The returns still take the credit note in its own month (§ 17 UStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-419-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}; MONTH=$((10#${TODAY:5:2}))
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier695-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
q "update \"Company\" set \"bankInfo\"='{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"bankName\":\"Bank\"}'::jsonb where id='$C'" >/dev/null
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
ust() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; echo "$BODY" | python3 -c "import sys,json;print('%g' % json.load(sys.stdin)['umsatzsteuer'])"; }
day() { q "select to_char(\"$2\",'YYYY-MM-DD') from \"Invoice\" where id='$1'"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
issued() { # extra-json → INV
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-06-01\"$1,\"items\":[{\"description\":\"Beratung\",\"quantity\":10,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  INV=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
}
credit() { AS POST "/api/v1/invoices/$1/credit-note?companyId=$C" "$2"; CN=$(json_field "$BODY" id); }
OCT_BEFORE=$(ust "$YEAR" "$MONTH")

note "=== 1. the Storno credit note of an invoice supplied on 28.05. ==="
issued ',"deliveryDate":"2026-05-28"'; A=$INV
credit "$A" '{"reason":"Storno"}'; CN_A=$CN
assert_eq "the Storno credit note" "$STATUS" "201"
assert_eq "its lines keep the unit (was Stück)" "$(q "select string_agg(unit, ',') from \"InvoiceItem\" where \"invoiceId\"='$CN_A'")" "Std"
assert_eq "its Leistungsdatum is the invoice's (was none)" "$(day "$CN_A" deliveryDate)" "2026-05-28"
curl -sS "$API/api/v1/invoices/$CN_A/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$WORK/a.pdf"
T=$(pdf_text "$WORK/a.pdf")
L=$(pdf_text "$WORK/a.pdf" --lines)
assert_eq "the PDF: 10,00 Std" "$(grep -c '10,00 Std' <<<"$T")" "1"
assert_eq "the PDF: Leistungsdatum 28.05.2026" "$(grep -c 'Leistungsdatum:' <<<"$L")/$(grep -cx '28.05.2026' <<<"$L")" "1/1"
assert_eq "the PDF: the invoice by number and date" "$(grep -c 'Bezug zu Rechnung:' <<<"$L")/$(grep -c 'Rechnung vom:' <<<"$L")/$(grep -cx '01.06.2026' <<<"$L")" "1/1/1"
assert_eq "the PDF: the account as Bankverbindung, no Zahlungsinformationen" "$(grep -c 'Bankverbindung:' <<<"$L")/$(grep -c 'Zahlungsinformationen' <<<"$L")" "1/0"
curl -sS "$API/api/v1/invoices/$CN_A/xrechnung?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$WORK/a.xml"
assert_eq "XRechnung: the period of the service is 28.05. (was the credit note's day)" \
  "$(python3 -c "import re,sys;x=open(sys.argv[1]).read();m=re.search(r'<cac:InvoicePeriod>\s*<cbc:StartDate>([^<]+)</cbc:StartDate>\s*<cbc:EndDate>([^<]+)<',x);print(m and m.group(1)+'/'+m.group(2))" "$WORK/a.xml")" "2026-05-28/2026-05-28"
assert_eq "the correction stays in the month of the credit note (§ 17 UStG)" "$(ust 2026 6)/$(python3 -c "print('%g' % ($OCT_BEFORE - $(ust "$YEAR" "$MONTH")))")" "190/190"
curl -sS "$API/api/v1/invoices/$A/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$WORK/inv.pdf"
assert_eq "the invoice itself still asks to be paid (Zahlungsinformationen)" "$(pdf_text "$WORK/inv.pdf" --lines | grep -c 'Zahlungsinformationen:')" "1"

note "=== 2. no Leistungsdatum recorded: the invoice's date, as the invoice states it ==="
issued ''; B=$INV
credit "$B" '{"amount":119,"reason":"Preisnachlass"}'
assert_eq "a partial credit note too: Leistungsdatum 01.06.2026" "$STATUS/$(day "$CN" deliveryDate)" "201/2026-06-01"

note "=== 3. a Leistungszeitraum ==="
issued ',"servicePeriodStart":"2026-05-01","servicePeriodEnd":"2026-05-31"'; P=$INV
credit "$P" '{"reason":"Storno"}'
assert_eq "the credit note takes the period" "$STATUS/$(day "$CN" servicePeriodStart)/$(day "$CN" servicePeriodEnd)/$(day "$CN" deliveryDate)" "201/2026-05-01/2026-05-31/"
curl -sS "$API/api/v1/invoices/$CN/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$WORK/p.pdf"
assert_eq "the PDF: Leistungszeitraum 01.05.2026 – 31.05.2026" "$(pdf_text "$WORK/p.pdf" --lines | grep -c -e 'Leistungszeitraum:' -e '^01.05.2026 –$' -e '^31.05.2026$')" "3"

summary
