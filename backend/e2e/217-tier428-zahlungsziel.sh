#!/bin/bash
# Tier 428 — the Zahlungsziel decides the due date, and a monthly contract
# is billed every month
#
# Measured before, with a company default of 30 days:
#   a customer on 14 days, invoice issued 01.09.  → due 01.10. (30 days).
#     The invoice form's own "Zahlungsziel" select changed nothing either:
#     the DTO accepted `paymentTerms` and the service dropped it (there is no
#     such column), and the customer's own term was never read.
#   a recurring template                          → due = issue + 30, always
#   a monthly template starting 31.01. on the 31st → first run 28.03.:
#     `setMonth(+1)` on 31 January is 3 March, so February was skipped, and
#     the day was then clamped to 28 for good (the cap was 28, not the
#     month's length). The run dates were also stored at the server's local
#     midnight, so in Berlin the date in the database was the day before the
#     one the user picked — now they are UTC dates.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-217-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier428-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
day() { python3 -c "import sys;print(sys.argv[1][:10] if sys.argv[1] and sys.argv[1]!='None' else '-')" "$1"; }

AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultPaymentDays":30}'
cust() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\",\"paymentTerms\":$2}"; json_field "$BODY" id; }
K14=$(cust Net14 14); K0=$(cust Sofort 0)
inv() { # customerId extra → dueDate
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-09-01\"$2,\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  day "$(P "d.get('dueDate')")"
}

note "=== 1. the customer's Zahlungsziel ==="
assert_eq "14 days → 15.09. (was 01.10., the company default)" "$(inv "$K14" "")" "2026-09-15"
assert_eq "0 days → due on the issue day (was 01.10.)" "$(inv "$K0" "")" "2026-09-01"
assert_eq "the invoice's own term wins over the customer's (was ignored)" "$(inv "$K14" ',"paymentTerms":7')" "2026-09-08"
assert_eq "an explicit due date still wins" "$(inv "$K14" ',"dueDate":"2026-12-24"')" "2026-12-24"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Default\",\"type\":\"business\"}"; KD=$(json_field "$BODY" id)
assert_eq "a customer without an own term keeps the company default of 30" "$(inv "$KD" "")" "2026-10-01"

note "=== 2. a monthly contract on the 31st ==="
tpl() { AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"customerId\":\"$1\",\"name\":\"$2\",\"interval\":\"$3\",\"dayOfMonth\":$4,\"startDate\":\"$5\",\"items\":[{\"description\":\"Miete\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"; json_field "$BODY" id; }
T=$(tpl "$K14" "Miete" monthly 31 "2026-01-31")
next() { q "select to_char(\"nextRunAt\", 'YYYY-MM-DD') from \"RecurringInvoice\" where id='$T'"; }
assert_eq "first run 28.02. — February, its last day (was 28.03.)" "$(next)" "2026-02-28"
for i in 1 2 3; do AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'; done
assert_eq "…then 31.03., 30.04., 31.05. — the 31st wherever the month has one (was 28.04., 28.05., 28.06.)" \
  "$(q "select string_agg(to_char(\"periodStart\", 'YYYY-MM-DD'), ' ' order by \"periodStart\") from \"RecurringRun\" where \"recurringInvoiceId\"='$T'")/$(next)" \
  "2026-02-28 2026-03-31 2026-04-30/2026-05-31"

note "=== 3. a recurring invoice follows the customer's Zahlungsziel ==="
assert_eq "issued today, due 14 days later (was 30)" \
  "$(q "select to_char(\"dueDate\" - \"issueDate\", 'DD') from \"Invoice\" where \"companyId\"='$C' and \"invoiceNumber\" in (select \"invoiceNumber\" from \"Invoice\" i join \"RecurringInvoice\" r on i.\"recurringInvoiceId\"=r.id where r.id='$T') limit 1")" "14"
AS GET "/api/v1/recurring-invoices/$T/preview?companyId=$C"
assert_eq "the preview says the same" \
  "$(python3 -c "
import sys,json,datetime
d=json.loads(sys.argv[1])
i=datetime.datetime.fromisoformat(d['issueDate'].replace('Z','+00:00'))
u=datetime.datetime.fromisoformat(d['dueDate'].replace('Z','+00:00'))
print((u-i).days)" "$BODY")" "14"

summary; exit $?
