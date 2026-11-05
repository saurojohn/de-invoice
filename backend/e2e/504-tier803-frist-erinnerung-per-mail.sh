#!/bin/bash
# Tier 803 — a reminder mail seven and two days before a filing deadline
#
# The dashboard named the deadlines (Tiers 801, 802); nothing told the owner
# who did not open it. Every morning at 07:00 the job `filing-deadline-
# reminders` mails the company's admins the open returns that are seven or
# two days away, each stage once; off on the UStVA page. POST
# /ustva/deadlines/remind runs it for one company at once.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-504-$(date +%s%N | cut -c1-13)"

# ── which rows, which stage ───────────────────────────────────────────────
RULES=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const r = (kind, daysLeft, status = 'open', month = 10) => ({ kind, year: 2026, month, quarter: null, status, daysLeft })
const show = (rows, sent = []) => JSON.stringify(f.dueReminders(rows, new Set(sent)).map((x) => [x.row.kind, x.row.daysLeft, x.stage, x.keys.join('+')]))
console.log([
  show([r('ustva', 8), r('ustva', 7, 'open', 9), r('ustva', 3, 'open', 8), r('ustva', 2, 'open', 7), r('ustva', 0, 'open', 6), r('ustva', -1, 'overdue', 5)]),
  show([r('ustva', 5)], ['ustva:2026:10:7']),
  show([r('ustva', 2)], ['ustva:2026:10:7']),
  show([r('ustva', 1)], ['ustva:2026:10:2', 'ustva:2026:10:7']),
  show([r('ustva', 3, 'filed'), r('dauerfrist', 3, 'option'), r('ustva', 3, 'running')]),
].join('|'))
" 2>&1 | tail -1)
IFS='|' read -r A B C D E <<<"$RULES"
assert_eq "7 days or less: the 7-day reminder; 2 or less: the 2-day one (which marks the 7-day one too); 8 days, past: none" "$A" \
  '[["ustva",7,7,"ustva:2026:9:7"],["ustva",3,7,"ustva:2026:8:7"],["ustva",2,2,"ustva:2026:7:2+ustva:2026:7:7"],["ustva",0,2,"ustva:2026:6:2+ustva:2026:6:7"]]'
assert_eq "the 7-day reminder sent: nothing more at 5 days" "$B" "[]"
assert_eq "…the 2-day one still comes" "$C" '[["ustva",2,2,"ustva:2026:10:2+ustva:2026:10:7"]]'
assert_eq "both sent: nothing on the last day" "$D" "[]"
assert_eq "filed, an option, the running period: never reminded of" "$E" "[]"

# ── the endpoint, for a fresh company, on today's date ─────────────────────
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier803-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111111
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body] [extra header]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-H "$4"} ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "the reminders are on unless switched off" "$(P "d['erinnerungMail']")" "True"
# what is due now, by the rows the dashboard shows
EXPECTED=$(P "[(x['kind'], x['year'], x['month'], x['quarter'], x['dueDate'], 2 if x['daysLeft'] <= 2 else 7) for x in d['deadlines'] if x['status'] in ('open', 'overdue') and 0 <= x['daysLeft'] <= 7]")

AS POST "/api/v1/ustva/deadlines/remind?companyId=$C" '{}' "x-readonly: 1"
assert_eq "read-only mode refuses the run" "$STATUS" "403"
AS POST "/api/v1/ustva/deadlines/remind?companyId=$C" '{}'
assert_eq "POST /ustva/deadlines/remind (was 404)" "$STATUS" "201"
assert_eq "it reminds of exactly the open rows seven days away or less: $EXPECTED" \
  "$(P "[(x['kind'], x['year'], x['month'], x['quarter'], x['dueDate'], x['stage']) for x in d['items']]")" "$EXPECTED"
if [[ "$EXPECTED" != "[]" ]]; then
  assert_eq "…sent to the company's admin" "$(P "(d['sent'], d['recipients'])")" "(True, 1)"
  assert_eq "the audit trail has the reminder" "$(q "select count(*) from \"AuditLog\" where \"companyId\"='$C' and action='filing_deadlines.reminder_sent'")" "1"
  assert_eq "the stages sent are kept with the company" \
    "$(q "select jsonb_array_length(settings->'fristErinnerungGesendet') > 0 from \"Company\" where id='$C'")" "t"
  AS POST "/api/v1/ustva/deadlines/remind?companyId=$C" '{}'
  assert_eq "a second run the same day sends nothing again" "$(P "(d['sent'], d.get('skipped'), d['items'])")" "(False, 'nothing-due', [])"
else
  assert_eq "nothing due within seven days: no mail" "$(P "(d['sent'], d.get('skipped'))")" "(False, 'nothing-due')"
fi

AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"fristErinnerungMail":false}'
assert_eq "switched off on the UStVA page" "$(P "d['erinnerungMail']")" "False"
q "update \"Company\" set settings = settings - 'fristErinnerungGesendet' where id='$C'" >/dev/null
AS POST "/api/v1/ustva/deadlines/remind?companyId=$C" '{}'
assert_eq "switched off: no mail, whatever is due" "$(P "(d['sent'], d.get('skipped'))")" "(False, 'disabled')"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"fristErinnerungMail":"nein"}'
assert_eq "a reminder flag that is no boolean is refused" "$STATUS" "400"

# the job is in the cron registry and keeps DISABLE_CRON
SRC="$SCRIPT_DIR/../src/modules"
assert_eq "the job is registered for the cron health page" "$(grep -c "name: 'filing-deadline-reminders', schedule: '0 7 \* \* \*'" "$SRC/admin/cron-health.service.ts")" "1"
assert_eq "…and honours DISABLE_CRON" "$(grep -c "DISABLE_CRON === '1'" "$SRC/reports/filing-deadline-mail.scheduler.ts")" "1"
assert_eq "…and skips closed companies" "$(grep -c "closedAt: null" "$SRC/reports/filing-deadline-mail.service.ts")" "1"

summary
