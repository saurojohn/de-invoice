#!/bin/bash
# Tier 806 — the review of Tiers 801–805: reminders, prepayments, secret links
#
#  1. One admin's address refused sent the others the same reminder again
#     every morning (nothing was marked as sent): what was sent is now kept
#     per admin, and only the failed admin is tried again.
#  2. Two reminder runs at once (the 07:00 job and POST /ustva/deadlines/remind)
#     both sent: the stages are claimed under the settings lock first.
#  3. A deadline that moved (the Dauerfristverlängerung recorded) was not
#     reminded of for its new day: the key carries the due day.
#  4. Every KSt / GewSt expense 45 days before to 30 days after a due day paid
#     that day — a quarter paid late paid the next one, a back payment of a
#     year too. Payments now settle the oldest open prepayment first
#     (§ 225 Abs. 2 AO); „…-Nachzahlung" / „…-Erstattung" pay none.
#  5. An error during a calendar poll stored the working link in the error
#     events; the calendar, portal and /pay/ tokens are cut from what is logged.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-507-$(date +%s%N | cut -c1-13)"

# ── 4. the allocation of payments to prepayments ──────────────────────────
ALLOC=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const dues = [{ due: '2026-05-15', amount: 1000 }, { due: '2026-08-17', amount: 1000 }, { due: '2026-11-16', amount: 1000 }]
const show = (pays) => JSON.stringify([...f.allocatePrepayments(dues, pays).entries()].map(([d, v]) => d.slice(5) + '=' + v))
console.log([
  show([{ day: '2026-05-15', amount: 1000 }, { day: '2026-10-10', amount: 1000 }]),
  show([{ day: '2026-08-17', amount: 400 }, { day: '2026-08-07', amount: 600 }]),
  show([]),
  show([{ day: '2026-08-17', amount: 1000 }, { day: '2026-10-05', amount: 1000 }, { day: '2026-10-20', amount: -1000 }]),
  show([{ day: '2026-03-01', amount: 1000 }]),
  ['Gewerbesteuer-Nachzahlung 2025', 'Gewerbesteuer Abschlusszahlung', 'Körperschaftsteuer-Erstattung', 'Gewerbesteuer'].map((c) => String(f.prepaymentTaxOf(c))).join(','),
].join('|'))
" 2>&1 | tail -1)
IFS='|' read -r A1 A2 A3 A4 A5 A6 <<<"$ALLOC"
assert_eq "Q3 paid late (10.10., 54 days after its day) pays Q3, not Q4 (was: Q4 'paid', Q3 overdue)" "$A1" '["05-15=0","08-17=0","11-16=1000"]'
assert_eq "two parts of one quarter; the quarter before the first payment is not tracked" "$A2" '["05-15=null","08-17=0","11-16=1000"]'
assert_eq "no payment booked: nothing tracked" "$A3" '["05-15=null","08-17=null","11-16=null"]'
assert_eq "a refund takes back from the latest prepayment it can" "$A4" '["05-15=null","08-17=0","11-16=1000"]'
assert_eq "a payment more than 45 days before any day pays nothing yet" "$A5" '["05-15=1000","08-17=1000","11-16=1000"]'
assert_eq "back payments and refunds of a year are no prepayment" "$A6" "null,null,null,gewst"

# ── 3. the key carries the due day ────────────────────────────────────────
KEYS=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const r = (dueDate) => ({ kind: 'ustva', year: 2026, month: 10, quarter: null, status: 'open', daysLeft: 5, dueDate })
const sent = new Set(f.dueReminders([r('2026-11-10')], new Set()).flatMap((x) => x.keys))
console.log(JSON.stringify([[...sent], f.dueReminders([r('2026-11-10')], sent).length, f.dueReminders([r('2026-12-10')], sent).length]))
" 2>&1 | tail -1)
assert_eq "the key names the due day" "$(python3 -c "import json,sys;print(json.loads(sys.argv[1])[0])" "$KEYS")" "['ustva:2026:10:2026-11-10:7']"
assert_eq "…the same day: not again; the day moved a month: reminded again (was: never)" "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d[1], d[2])" "$KEYS")" "0 1"

# ── 1–3. the mail run, with a transport that refuses one admin ─────────────
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier806-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
PROBE=$(cd "$SCRIPT_DIR/.." && npx ts-node -T scripts/probe-deadline-mail.ts "$C" 2>/dev/null | tail -1)
J() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$PROBE" "$1"; }
assert_eq "the second admin's address refused: the first is mailed, the second counted as failed" \
  "$(J "(d['firstRun']['to'], d['firstRun']['recipients'], d['firstRun']['failed'])")" "(['first-admin'], 1, 1)"
assert_eq "…only the first admin's stage is kept" "$(J "d['keysAfterFirst']")" "1"
assert_eq "the next run mails only the second admin (was: both, again, every morning)" "$(J "d['secondRun']['to']")" "['second-admin']"
assert_eq "…and then nothing is left" "$(J "d['thirdRun']['skipped']")" "nothing-due"
assert_eq "two runs at once: each admin mailed once (was: twice)" "$(J "(d['concurrent']['mails'], d['concurrent']['sentRuns'])")" "(2, 1)"
assert_eq "the deadline moved a month: both admins reminded for the new day" "$(J "d['moved']['to']")" "['first-admin', 'second-admin']"

# ── 4. on the dashboard: a quarter paid late is that quarter's ─────────────
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS GET "/api/v1/ustva/deadlines?companyId=$C"
TODAY=$(P "d['today']"); Y=${TODAY:0:4}
read -r NEXT PREV < <(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const y = $Y, today = '$TODAY'
const qs = [[y - 1, 1], [y - 1, 2], [y - 1, 3], [y - 1, 4], [y, 1], [y, 2], [y, 3], [y, 4], [y + 1, 1]]
const dues = qs.map(([yy, q]) => [yy, q, f.prepaymentDeadline('gewst', yy, q, null)])
const i = dues.findIndex((d) => d[2] >= today)
console.log(dues[i].join(','), dues[i - 1].join(','))
" 2>&1 | tail -1)
IFS=, read -r NY NQ ND <<<"$NEXT"; IFS=, read -r PY PQ PD <<<"$PREV"
for y in $((Y - 1)) $Y $((Y + 1)); do
  AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$y,\"q1\":1000,\"q2\":1000,\"q3\":1000,\"q4\":1000}"
done
# the quarter before paid late: the latest day that is still more than 30 days after it, up to today
LATE=$(python3 -c "import datetime as t;d=t.date.fromisoformat('$PD')+t.timedelta(days=31);n=t.date.fromisoformat('$TODAY');print(min(d,n))")
exp() { AS POST "/api/v1/expenses?companyId=$C" "{\"description\":\"$3 $TAG\",\"invoiceDate\":\"$1\",\"category\":\"$3\",\"netAmount\":$2,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":$2}"; }
exp "$PD" 1 Gewerbesteuer
exp "$LATE" 999 Gewerbesteuer
assert_eq "fixture: the quarter before paid, 1 € on its day and 999 € on $LATE" "$STATUS" "201"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "the late payment settles that quarter; the next one stays open" \
  "$(P "[(x['year'], x['quarter'], x['status']) for x in d['deadlines'] if x['kind'] == 'gewst']")" "[($NY, $NQ, 'open')]"
exp "$TODAY" 1000 "Gewerbesteuer-Nachzahlung $((Y - 1))"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "a back payment of a year pays no prepayment" \
  "$(P "[(x['year'], x['quarter'], x['status']) for x in d['deadlines'] if x['kind'] == 'gewst']")" "[($NY, $NQ, 'open')]"

# ── 5. no working secret link in a stored error ────────────────────────────
TOK="tok${TAG//-/}abcdefghijklmnopqrstuvwxyz0123"
MSG="e2e-507 $TAG at /api/v1/calendar/$TOK.ics"
BODY507="{\"message\":\"$MSG\",\"url\":\"https://x.test/pay/$TOK?ref=1\"}"
curl -sS -o /dev/null -X POST "$API/api/v1/system/errors" -H "Content-Type: application/json" -d "$BODY507"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
ROW=$(q "select message || ' | ' || coalesce(url, '') from \"ErrorEvent\" where message like 'e2e-507 $TAG%'")
assert_eq "a reported error keeps its text, the calendar token cut" "${ROW%% | *}" "e2e-507 $TAG at /api/v1/calendar/[redacted]"
assert_eq "…and the /pay/ token of its page" "${ROW##* | }" "https://x.test/pay/[redacted]?ref=1"
assert_eq "the token is nowhere in the stored events" "$(q "select count(*) from \"ErrorEvent\" where message like '%$TOK%' or url like '%$TOK%' or context::text like '%$TOK%'")" "0"
RED=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const r = require('./src/common/redact-url')
console.log([r.redactUrl('/api/v1/portal/7f3a/mark-paid'), r.redactUrl('/api/v1/customer-portal/invoice/5'), r.redactUrl('/x?token=abc&y=2'), JSON.stringify(r.redactParams({ token: 'x', id: 1 }))].join('|'))
" 2>&1 | tail -1)
assert_eq "portal tokens, query tokens and route params cut; other routes untouched" "$RED" \
  '/api/v1/portal/[redacted]/mark-paid|/api/v1/customer-portal/invoice/5|/x?token=[redacted]&y=2|{"token":"[redacted]","id":1}'
SRC="$SCRIPT_DIR/../src/modules/system"
assert_eq "the exception filter logs the URL redacted" "$(grep -c "redactUrl(req.originalUrl)" "$SRC/system.filter.ts")" "4"

summary
