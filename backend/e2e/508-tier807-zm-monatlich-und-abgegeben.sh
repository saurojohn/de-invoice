#!/bin/bash
# Tier 807 — the ZM monthly by § 18a Abs. 1 UStG; ZM and OSS marked as filed
#
#  1. Tier 801 looked at the last ended quarter only and kept the ZM
#     quarterly with a note. The ZM is monthly while the intra-EU supplies of
#     goods are over 50 000 € in the running quarter or in one of the four
#     before it; passed during a quarter, it is due by the 25th after that
#     month, for that month and the quarter's months already over. The row,
#     the reminders and the ZM card follow: a month, due the 25th after it.
#  2. Nothing recorded that a ZM or OSS return was filed: the dashboard and
#     the reminder mails called it due until its day. PUT
#     /ustva/deadlines/filed marks it (ustva.submit), the row turns „filed",
#     the reminders stop; the mark can be taken back. Audited.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-508-$(date +%s%N | cut -c1-13)"

# ── 1. the rule ───────────────────────────────────────────────────────────
RULES=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const z = (a, b) => JSON.stringify(f.zmMonthly(a, b))
console.log([
  z([0, 0, 60000, 0], [1000]),
  z([0, 0, 0, 0], [30000, 25000]),
  z([0, 0, 0, 50000], [50000]),
  z([0, 0, 0, 0], [51000, 0, 0]),
  f.filedKey('zm', { year: 2026, month: 10 }) + ',' + f.filedKey('oss', { year: 2026, quarter: 3 }),
  f.zmDeadline({ year: 2026, month: 10 }, null) + ',' + f.zmDeadline({ year: 2026, month: 12 }, 'NW'),
].join('|'))
" 2>&1 | tail -1)
IFS='|' read -r R1 R2 R3 R4 R5 R6 <<<"$RULES"
assert_eq "over 50 000 € in one of the four quarters before: monthly" "$R1" '{"monthly":true,"standing":true,"passedAt":null}'
assert_eq "passed in the second month of the quarter: monthly from that month" "$R2" '{"monthly":true,"standing":false,"passedAt":1}'
assert_eq "50 000 € exactly is not over: quarterly" "$R3" '{"monthly":false,"standing":false,"passedAt":null}'
assert_eq "passed in the first month" "$R4" '{"monthly":true,"standing":false,"passedAt":0}'
assert_eq "the key of a mark" "$R5" "zm:2026:M10,oss:2026:Q3"
assert_eq "a monthly ZM is due the 25th after the month (25.01.2027 a Monday)" "$R6" "2026-11-25,2027-01-25"

# ── fixtures ──────────────────────────────────────────────────────────────
reg() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier807-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(reg "$TAG")
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
TODAY=$(P "d['today']")
# the last ended month, its quarter's first day, a day in the quarter before
read -r LY LM QSTART PRIOR MDUE < <(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const m = f.lastEndedPeriod('$TODAY', 'monthly')
const q = f.periodContaining(f.isoDay(m.year, m.month - 1, 1), 'quarterly')
const p = f.previousPeriod(q)
console.log(m.year, m.month, f.isoDay(q.year, (q.quarter - 1) * 3, 2), f.isoDay(p.year, (p.quarter - 1) * 3, 2), f.zmDeadline(m, null))
" 2>&1 | tail -1)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG FR\",\"type\":\"business\",\"vatId\":\"FR12345678901\",\"address\":{\"street\":\"Rue 1\",\"postalCode\":\"1010\",\"city\":\"Paris\",\"country\":\"FR\"}}"
FR=$(json_field "$BODY" id)
inv() { # date net
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$FR\",\"issueDate\":\"$1\",\"euTransaction\":true,\"items\":[{\"description\":\"Leder\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0}]}"
  AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
}
inv "$PRIOR" 60000
assert_eq "fixture: 60 000 € intra-EU goods on $PRIOR, the quarter before" "$STATUS" "200"
LDAY=$(python3 -c "print('%d-%02d-03' % ($LY, $LM))")
inv "$LDAY" 1000
assert_eq "fixture: 1 000 € on $LDAY, the last ended month" "$STATUS" "200"

AS GET "/api/v1/ustva/deadlines?companyId=$C"
if [[ "$MDUE" < "$TODAY" ]]; then
  pass "(the ZM of $LM/$LY was due $MDUE — past; the monthly row is not testable today)"
else
  assert_eq "the ZM is monthly: the last ended month, due $MDUE (was: the quarter, with a note)" \
    "$(P "[(x['year'], x['month'], x['quarter'], x['dueDate'], x['status'], x['noteCode']) for x in d['deadlines'] if x['kind'] == 'zm']")" \
    "[($LY, $LM, None, '$MDUE', 'open', 'zm-monthly')]"
  assert_eq "…and the ZM card opens on that month" "$(P "d['defaults']['zm']")" "{'year': $LY, 'quarter': $(( (LM + 2) / 3 )), 'month': $LM}"
fi

# ── 2. marked as filed ────────────────────────────────────────────────────
AS PUT "/api/v1/ustva/deadlines/filed?companyId=$C" "{\"kind\":\"zm\",\"year\":$LY,\"month\":$LM,\"filed\":true}" "x-readonly: 1"
assert_eq "read-only mode refuses the mark" "$STATUS" "403"
AS PUT "/api/v1/ustva/deadlines/filed?companyId=$C" "{\"kind\":\"zm\",\"year\":$LY,\"month\":$LM,\"quarter\":1,\"filed\":true}"
assert_eq "a month and a quarter at once: 400" "$STATUS" "400"
AS PUT "/api/v1/ustva/deadlines/filed?companyId=$C" "{\"kind\":\"oss\",\"year\":$LY,\"month\":$LM,\"filed\":true}"
assert_eq "OSS by month: 400" "$STATUS" "400"
AS PUT "/api/v1/ustva/deadlines/filed?companyId=$C" "{\"kind\":\"zm\",\"year\":$LY,\"month\":$LM,\"filed\":\"ja\"}"
assert_eq "a mark that is no boolean: 400" "$STATUS" "400"
AS PUT "/api/v1/ustva/deadlines/filed?companyId=$C" "{\"kind\":\"zm\",\"year\":$LY,\"month\":$LM,\"filed\":true}"
assert_eq "PUT /ustva/deadlines/filed (was 404)" "$STATUS/$(P "(d['key'], d['filed'], d['changed'])")" "200/('zm:$LY:M$LM', True, True)"
assert_eq "…kept with the company" "$(q "select settings->'meldungenAbgegeben'->0->>'key' from \"Company\" where id='$C'")" "zm:$LY:M$LM"
AS PUT "/api/v1/ustva/deadlines/filed?companyId=$C" "{\"kind\":\"zm\",\"year\":$LY,\"month\":$LM,\"filed\":true}"
assert_eq "marked twice: no change" "$(P "d['changed']")/$(q "select jsonb_array_length(settings->'meldungenAbgegeben') from \"Company\" where id='$C'")" "False/1"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
if [[ ! "$MDUE" < "$TODAY" ]]; then
  assert_eq "the row is filed" "$(P "[x['status'] for x in d['deadlines'] if x['kind'] == 'zm']")" "['filed']"
  AS POST "/api/v1/ustva/deadlines/remind?companyId=$C" '{}'
  assert_eq "…and no reminder names it" "$(P "[x for x in d['items'] if x['kind'] == 'zm']")" "[]"
fi
AS PUT "/api/v1/ustva/deadlines/filed?companyId=$C" "{\"kind\":\"zm\",\"year\":$LY,\"month\":$LM,\"filed\":false}"
assert_eq "the mark taken back" "$(P "(d['filed'], d['changed'])")/$(q "select jsonb_array_length(settings->'meldungenAbgegeben') from \"Company\" where id='$C'")" "(False, True)/0"
if [[ ! "$MDUE" < "$TODAY" ]]; then
  AS GET "/api/v1/ustva/deadlines?companyId=$C"
  assert_eq "…the row is open again" "$(P "[x['status'] for x in d['deadlines'] if x['kind'] == 'zm']")" "['open']"
fi
assert_eq "both audited" "$(q "select string_agg(action, ',' order by action collate \"C\") from \"AuditLog\" where \"companyId\"='$C' and action like 'filing_deadlines.return_mark%'")" \
  "filing_deadlines.return_mark_removed,filing_deadlines.return_marked_filed"

# ── 1b. passed during the quarter: the month of passing reports the months before ──
read -r U2 C2 < <(reg "$TAG-b")
fixture_issuer "$C2" DE811111112
MPOS=$(( (LM - 1) % 3 ))
if (( MPOS == 0 )) || [[ "$MDUE" < "$TODAY" ]]; then
  pass "(the last ended month is the first of its quarter or its ZM is past — the passing within the quarter is not testable today)"
else
  U=$U2; C=$C2
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG FR\",\"type\":\"business\",\"vatId\":\"FR12345678901\",\"address\":{\"street\":\"Rue 1\",\"postalCode\":\"1010\",\"city\":\"Paris\",\"country\":\"FR\"}}"
  FR=$(json_field "$BODY" id)
  inv "$QSTART" 30000
  inv "$LDAY" 25000
  AS GET "/api/v1/ustva/deadlines?companyId=$C"
  assert_eq "55 000 € by $LM/$LY: monthly from this month, the ZM covers the quarter's months so far" \
    "$(P "[(x['month'], x['dueDate'], x['noteCode']) for x in d['deadlines'] if x['kind'] == 'zm']")" "[($LM, '$MDUE', 'zm-monthly-first')]"
fi

summary
