#!/bin/bash
# Tier 804 — the quarterly KSt and GewSt prepayments among the deadlines
#
# The prepayments of the Vorauszahlungsbescheide were entered on the
# accounting page (Tier 106, Tier 507) and used only in the annual returns;
# the dashboard and the reminder mails knew nothing of their due dates:
#   Körperschaftsteuer (+ Soli) 10.03., 10.06., 10.09., 10.12. (§ 31 KStG, § 37 EStG),
#   Gewerbesteuer 15.02., 15.05., 15.08., 15.11. (§ 19 GewStG),
# moved to the next working day (§ 108 Abs. 3 AO). Now GET /ustva/deadlines
# lists the next one of each with its amount, and the one before while it is
# unpaid — overdue for a company that books these taxes as expenses. An
# expense of the tax 45 days before to 30 days after the day pays it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-505-$(date +%s%N | cut -c1-13)"

# ── the rules ─────────────────────────────────────────────────────────────
RULES=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const d = (t, y, q) => f.prepaymentDeadline(t, y, q, 'NW')
const r = { kind: 'gewst', year: 2026, month: null, quarter: 4, status: 'open', daysLeft: 6 }
console.log([
  [d('kst', 2026, 4), d('kst', 2027, 1), d('kst', 2029, 2)].join(','),
  [d('gewst', 2026, 4), d('gewst', 2027, 1), d('gewst', 2026, 3)].join(','),
  ['Gewerbesteuer', 'GewSt-Vorauszahlung', 'Körperschaftsteuer', 'Solidaritätszuschlag', 'Einkommensteuer', 'Gewerbesteuer-Beratung', 'Gewerbesteuererstattung', 'Material']
    .map((c) => String(f.prepaymentTaxOf(c))).join(','),
  f.dueReminders([r], new Set()).map((x) => x.keys.join('+')).join(),
].join('|'))
" 2>&1 | tail -1)
IFS='|' read -r A B C D <<<"$RULES"
assert_eq "KSt: 10.12.2026 (Thu), 10.03.2027 (Wed), 10.06.2029 a Sunday → Monday 11.06." "$A" "2026-12-10,2027-03-10,2029-06-11"
assert_eq "GewSt: 15.11.2026 a Sunday → 16.11., 15.02.2027 (Mon), 15.08.2026 a Saturday → 17.08." "$B" "2026-11-16,2027-02-15,2026-08-17"
assert_eq "which expenses pay which prepayment" "$C" "gewst,gewst,kst,kst,null,null,null,null"
assert_eq "a prepayment is reminded of like a return" "$D" "gewst:2026:Q4:7"

# ── a fresh company, on today's date ───────────────────────────────────────
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier804-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
rows() { # the rows of one kind: (year, quarter, dueDate, status, amount)
  AS GET "/api/v1/ustva/deadlines?companyId=$C"
  P "[(x['year'], x['quarter'], x['dueDate'], x['status'], float(x['amount'])) for x in d['deadlines'] if x['kind'] == '$1']"
}

AS GET "/api/v1/ustva/deadlines?companyId=$C"
TODAY=$(P "d['today']"); Y=${TODAY:0:4}
assert_eq "nothing entered: no prepayment listed" "$(P "[x['kind'] for x in d['deadlines'] if x['kind'] in ('kst', 'gewst')]")" "[]"

# what the rules say is next and before, for this day
read -r NEXT PREV < <(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const y = $Y, today = '$TODAY'
const qs = [[y - 1, 4], [y, 1], [y, 2], [y, 3], [y, 4], [y + 1, 1]]
const dues = qs.map(([yy, q]) => [yy, q, f.prepaymentDeadline('gewst', yy, q, null)])
const i = dues.findIndex((d) => d[2] >= today)
console.log(dues[i].join(','), dues[i - 1].join(','))
" 2>&1 | tail -1)
IFS=, read -r NY NQ ND <<<"$NEXT"; IFS=, read -r PY PQ PD <<<"$PREV"

for y in $((Y - 1)) $Y $((Y + 1)); do
  AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$y,\"q1\":1000,\"q2\":1000,\"q3\":1000,\"q4\":1000}"
  AS PUT "/api/v1/accounting/kst1/vorauszahlungen?companyId=$C" "{\"year\":$y,\"q1\":2500.5,\"q2\":2500.5,\"q3\":2500.5,\"q4\":2500.5}"
done
assert_eq "fixture: the prepayments of three years entered" "$STATUS" "200"

assert_eq "GewSt: the next one, open, with the Bescheid's amount; the one before is not listed — nothing here books the tax" \
  "$(rows gewst)" "[($NY, $NQ, '$ND', 'open', 1000.0)]"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "KSt: the next one, with its amount (KSt + Soli)" "$(P "[(x['status'], x['amount'], x['noteCode']) for x in d['deadlines'] if x['kind'] == 'kst' and x['status'] == 'open']")" \
  "[('open', 2500.5, 'kst-paid-by-expense')]"
assert_eq "…on a 10th or the working day after" "$(P "all(x['dueDate'][8:] in ('10', '11', '12', '13') for x in d['deadlines'] if x['kind'] == 'kst')")" "True"

# part of the one before paid, as an expense: now it is overdue
exp() { # date amount category
  AS POST "/api/v1/expenses?companyId=$C" \
    "{\"description\":\"$3 $TAG\",\"invoiceDate\":\"$1\",\"category\":\"$3\",\"netAmount\":$2,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":$2}"
}
exp "$PD" 400 Gewerbesteuer
assert_eq "fixture: 400 € Gewerbesteuer on $PD" "$STATUS" "201"
assert_eq "the company books the tax: the one before, short of 1 000 €, is overdue" \
  "$(rows gewst)" "[($PY, $PQ, '$PD', 'overdue', 1000.0), ($NY, $NQ, '$ND', 'open', 1000.0)]"
PD10=$(python3 -c "import datetime as t;print(t.date.fromisoformat('$PD') - t.timedelta(days=10))")
exp "$PD10" 600 "GewSt-Vorauszahlung"
assert_eq "the rest paid ten days before the day: it is gone" "$(rows gewst)" "[($NY, $NQ, '$ND', 'open', 1000.0)]"

# the next one paid early, when it is close enough
LEFT=$(python3 -c "import datetime as t;print((t.date.fromisoformat('$ND') - t.date.fromisoformat('$TODAY')).days)")
if (( LEFT <= 45 )); then
  exp "$TODAY" 1000 Gewerbesteuer
  assert_eq "paid today, $LEFT days before: shown as paid until its day" "$(rows gewst)" "[($NY, $NQ, '$ND', 'filed', 1000.0)]"
else
  pass "(the next GewSt prepayment is $LEFT days away — paying it early is not testable today)"
fi
# an expense of another tax or a smaller one pays nothing of the KSt
exp "$TODAY" 2500.5 Einkommensteuer
assert_eq "an Einkommensteuer expense does not pay the KSt prepayment" "$(rows kst | python3 -c "import sys;print('open' in sys.stdin.read())")" "True"

# the reminder run reminds of a prepayment seven days or less away
AS GET "/api/v1/ustva/deadlines?companyId=$C"
EXPECTED=$(P "[(x['kind'], x['dueDate']) for x in d['deadlines'] if x['kind'] in ('kst', 'gewst') and x['status'] in ('open', 'overdue') and 0 <= x['daysLeft'] <= 7]")
AS POST "/api/v1/ustva/deadlines/remind?companyId=$C" '{}'
assert_eq "the reminder covers the prepayments due within seven days: $EXPECTED" \
  "$(P "[(x['kind'], x['dueDate']) for x in d['items'] if x['kind'] in ('kst', 'gewst')]")" "$EXPECTED"

# the mail names them
SRC="$SCRIPT_DIR/../src/modules/reports"
assert_eq "the mail names the KSt and GewSt prepayments" \
  "$(grep -c "kst: 'Körperschaftsteuer-Vorauszahlung', gewst: 'Gewerbesteuer-Vorauszahlung'" "$SRC/filing-deadline-mail.service.ts")" "1"

summary
