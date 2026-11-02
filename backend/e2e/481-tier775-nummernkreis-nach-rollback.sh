#!/bin/bash
# Tier 775 — the year's number series after a run that was rolled back
#
# Found when spec 359 failed on 02.11.2026 and passed on 01.11.: from then on its
# second period lay in the next year.
#   - A run refused after it took its number rolled back the CREATE SEQUENCE of
#     that year, but the process remembered the sequence as created: every later
#     number of the company and year answered 500 until a restart. With the
#     first invoice of a new year, that is a January morning.
#   - A recurring invoice took the year of its period for its number, not of
#     its date: dated 02.11.2026, numbered INV-2027-000001.
# The period here lies years ahead, so neither depends on the day of the run.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="t775-$(date +%s)"
Y=$(python3 -c "import datetime,zoneinfo;print(datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).year)")
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier775-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['company']['id'])")
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
numbers() { q "select coalesce(string_agg(\"invoiceNumber\", ',' order by \"createdAt\"), '-') from \"Invoice\" where \"companyId\"='$C' and type='INV'"; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
K=$(json_field "$BODY" id)
START="$((Y + 4))-01-01"
AS POST "/api/v1/recurring-invoices?companyId=$C" '{"name":"'$TAG' Abo","customerId":"'$K'","interval":"monthly","startDate":"'$START'","items":[{"description":"Wartung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'
T=$(json_field "$BODY" id)

# the run record of its period exists already: the run takes its number, then is refused and rolled back
q "insert into \"RecurringRun\" (id, \"recurringInvoiceId\", \"companyId\", trigger, \"periodStart\", \"periodEnd\", status) select gen_random_uuid(), '$T', '$C', 'scheduled', \"nextRunAt\", \"nextRunAt\" + interval '1 month', 'success' from \"RecurringInvoice\" where id='$T'" >/dev/null
AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "the run is refused, nothing written" "$([[ "$STATUS" =~ ^4 ]] && echo refused || echo "$STATUS")/$(numbers)" "refused/-"
q "delete from \"RecurringRun\" where \"recurringInvoiceId\"='$T' and \"invoiceId\" is null" >/dev/null

AS POST "/api/v1/recurring-invoices/$T/run?companyId=$C" '{}'
assert_eq "the next run numbers its invoice (was 500)" "$([[ "$STATUS" =~ ^2 ]] && echo ok || echo "$STATUS")" "ok"
assert_eq "in the year of its date, not of its period $START" "$(numbers)" "INV-$Y-000001"
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$(date +%Y-%m-%d)'","items":[{"description":"x","quantity":1,"unit":"Stk","unitPrice":10,"vatRate":0.19}]}'
assert_eq "an invoice made by hand continues the same series" "$(numbers)" "INV-$Y-000001,INV-$Y-000002"
summary
