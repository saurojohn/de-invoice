#!/bin/bash
# Tier 553 — "today" is the German calendar day, on any server clock
#
# Production runs with TZ=Europe/Berlin. A dozen places took today from the
# server clock and wrote it as an ISO string: local midnight is 22:00 / 23:00
# UTC of the day before. Measured on a server in Germany:
#   GET /recurring-invoices/from-invoice/:id → startDate = yesterday
#   GET /reports/datev-preview (no dates)    → startDate = <year-1>-12-31
#   GET /reports/datev-export  (no dates)    → file EXTF_Buchungsstapel_<year-1>-12-31_…
# and `new Date().toISOString()` (invoice default issue date, ELSTER
# Eingangsdatum, SEPA creation date, file stamps) is yesterday between 00:00
# and 02:00. All of them now use common/business-date.
# (On a UTC server — CI — the first three were right by accident; the spec
# shows its teeth where the server's zone is Germany's.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TODAY=$(TZ=Europe/Berlin date +%Y-%m-%d); YEAR=${TODAY:0:4}
H=(-H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" -H "Content-Type: application/json")

R=$(curl -sS "$API/api/v1/customers?companyId=$COMPANY_ID" "${H[@]}" -X POST -d "{\"name\":\"e2e-337 $(date +%s)\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"Muenchen\",\"country\":\"DE\"}}")
K=$(json_field "$R" id)
R=$(curl -sS "$API/api/v1/invoices?companyId=$COMPANY_ID" "${H[@]}" -X POST -d "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}")
I=$(json_field "$R" id)
[[ -n "$I" ]] && pass "fixture: an invoice" || fail "fixture: ${R:0:200}"

R=$(curl -sS "$API/api/v1/recurring-invoices/from-invoice/$I?companyId=$COMPANY_ID" "${H[@]}")
assert_eq "a template from the invoice starts today (was yesterday)" "$(json_field "$R" startDate)" "$TODAY"
assert_eq "…on today's day of the month" "$(json_field "$R" dayOfMonth)" "$(python3 -c "print(min(int('${TODAY:8:2}'),28))")"

R=$(curl -sS "$API/api/v1/reports/datev-preview?companyId=$COMPANY_ID" "${H[@]}")
assert_eq "DATEV preview without dates: from 1 January (was 31 December)" "$(json_field "$R" header.startDate)" "$YEAR-01-01"
CD=$(curl -sS -D - -o /dev/null "$API/api/v1/reports/datev-export?companyId=$COMPANY_ID" "${H[@]}" | tr -d '\r' | grep -i "^content-disposition" || true)
assert_eq "DATEV export without dates: the file is named for 1 January" "$(grep -o "Buchungsstapel_[0-9-]*" <<<"$CD")" "Buchungsstapel_$YEAR-01-01"

curl -sS -o /dev/null -X DELETE "$API/api/v1/invoices/$I?companyId=$COMPANY_ID" "${H[@]}"
summary
