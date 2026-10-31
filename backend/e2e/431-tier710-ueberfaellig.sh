#!/bin/bash
# Tier 710 — an invoice past its due date is „überfällig“
#
# The invoice list's chip „Überfällig“, the dashboard's „Überfällige
# Rechnungen“, the customer report's overdue column read the status
# `overdue` — and nothing set it but a user picking it by hand. Measured:
# unpaid invoices of 2025 and January all „Versendet“, the dashboard said 0.
# Now a nightly job (00:05 German time) marks an issued invoice whose due
# date has passed and on which money is open; one held by an installment plan
# is left alone. (Run here through its test-only route — DISABLE_CRON keeps
# the job off in the suite.) And the dashboard's „Rechnungen“ count no
# credit note any more.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-431-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
FUTURE=$(python3 -c "import datetime,zoneinfo;print((datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date()+datetime.timedelta(days=20)).isoformat())")
company() { # → U C K
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier710-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C" DE123456789
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
  K=$(json_field "$BODY" id)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
inv() { # issueDate dueDate [status] → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"dueDate\":\"$2\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  [[ "${3:-sent}" == "draft" ]] || AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"2026-08-20\",\"paymentMethod\":\"bank_transfer\"}"; }
status_of() { q "select status from \"Invoice\" where id='$1'"; }

company b; UB=$U; CB=$C
inv 2026-08-01 2026-08-15; OTHER=$I
company a
[[ -n "${C:-}" && -n "${K:-}" ]] && pass "fixture: two companies" || { fail "register"; summary; exit 1; }
inv 2026-08-01 2026-08-15; PAST=$I
inv "$TODAY" "$TODAY"; DUE_TODAY=$I
inv 2026-08-01 2026-08-15; PAID=$I; pay "$PAID" 1190
inv 2026-08-01 2026-08-15; PART=$I; pay "$PART" 500
inv 2026-08-01 2026-08-15; PLAN=$I
AS POST "/api/v1/installment-plans/from-invoice?companyId=$C" "{\"invoiceId\":\"$PLAN\",\"installmentCount\":3,\"firstDueDate\":\"$FUTURE\",\"createdById\":\"$U\"}"
assert_eq "fixture: an installment plan" "$STATUS" "201"
inv 2026-08-01 2026-08-15 draft; DRAFT=$I
AS POST "/api/v1/invoices/$PAST/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'
assert_eq "fixture: all of them 'sent' (paid: 'paid', the draft a draft)" \
  "$(status_of "$PAST")/$(status_of "$DUE_TODAY")/$(status_of "$PAID")/$(status_of "$PART")/$(status_of "$PLAN")/$(status_of "$DRAFT")" "sent/sent/paid/sent/sent/draft"

note "=== 1. the night ==="
AS POST "/api/v1/invoice-status/_test/mark-overdue?companyId=$C" '{}'
assert_eq "the job: 2 marked" "$STATUS/$(P "d['marked']")" "201/2"
assert_eq "past due and open: überfällig (was: Versendet for good)" "$(status_of "$PAST")" "overdue"
assert_eq "…part paid, the rest open: überfällig" "$(status_of "$PART")" "overdue"
assert_eq "due today: not yet" "$(status_of "$DUE_TODAY")" "sent"
assert_eq "paid: bezahlt" "$(status_of "$PAID")" "paid"
assert_eq "held by its installment plan: Versendet (the Raten are its due dates)" "$(status_of "$PLAN")" "sent"
assert_eq "a draft: a draft" "$(status_of "$DRAFT")" "draft"
assert_eq "another company's invoice: not touched by this company's run" "$(status_of "$OTHER")" "sent"
AS POST "/api/v1/invoice-status/_test/mark-overdue?companyId=$C" '{}'
assert_eq "a second run: nothing more" "$(P "d['marked']")" "0"

note "=== 2. what reads it ==="
AS GET "/api/v1/invoices?companyId=$C&status=overdue&pageSize=50"
assert_eq "the list's „Überfällig“: the two" "$(P "sorted(r['id'] for r in d['data']) == sorted(['$PAST', '$PART'])")" "True"
pay "$PART" 690
assert_eq "the rest paid: bezahlt" "$(status_of "$PART")" "paid"
# It counts this year's: in another year than the fixtures' they move along.
q "update \"Invoice\" set \"issueDate\"='$(date +%Y)-01-01' where \"companyId\"='$C' and \"issueDate\" < '$(date +%Y)-01-01'" >/dev/null
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "the dashboard counts the 5 issued invoices, not the credit note (was 6)" "$(P "d['ytd']['countInvoices']")" "5"

note "=== 3. the job's registration ==="
SRC="$SCRIPT_DIR/../src/modules/invoice/overdue-status.scheduler.ts"
assert_eq "nightly at 00:05 German time, off with DISABLE_CRON, in the cron health list" \
  "$(grep -c "@Cron('5 0 \* \* \*'" "$SRC")/$(grep -c "DISABLE_CRON === '1'" "$SRC")/$(grep -c "invoice-overdue-status" "$SCRIPT_DIR/../src/modules/admin/cron-health.service.ts")" "1/1/1"

summary
