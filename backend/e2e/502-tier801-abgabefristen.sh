#!/bin/bash
# Tier 801 — the filing deadlines of UStVA, ZM and OSS, and the period the
# three reports open on
#
# The UStVA page opened on the whole current year, the ZM and OSS on the
# quarter still running; in January the December return was two clicks
# away, and nothing said when a return was due. GET /ustva/deadlines now
# lists the returns due next — § 18 Abs. 1 UStG (10th, a month later with
# Dauerfristverlängerung), § 18a (25th), § 18j (end of the following month,
# unshifted), § 108 Abs. 3 AO (weekend / holiday → next working day) — and
# the period each page opens on. PUT /ustva/filing-settings states the
# rhythm and the Dauerfristverlängerung; until then they come from the books.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-502-$(date +%s%N | cut -c1-13)"

# ── the rules themselves, on fixed days ────────────────────────────────────
RULES=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const out = [
  f.easterSunday(2026), f.easterSunday(2027), f.easterSunday(2030), f.easterSunday(2035),
  f.ustvaDeadline({ year: 2026, month: 12 }, false, null),
  f.ustvaDeadline({ year: 2026, month: 12 }, true, null),
  f.ustvaDeadline({ year: 2026, quarter: 4 }, false, 'BY'),
  f.ustvaDeadline({ year: 2026, quarter: 4 }, true, 'BY'),
  f.ustvaDeadline({ year: 2026, month: 9 }, false, null),
  f.ustvaDeadline({ year: 2030, month: 5 }, false, null),
  f.zmDeadline({ year: 2026, quarter: 4 }, null),
  f.ossDeadline({ year: 2026, quarter: 4 }),
  f.shiftToWorkingDay('2026-06-04', 'BY'), f.shiftToWorkingDay('2026-06-04', null), f.shiftToWorkingDay('2026-06-04', 'NI'),
  f.shiftToWorkingDay('2026-11-18', 'SN'), f.shiftToWorkingDay('2026-11-18', 'BY'),
  f.shiftToWorkingDay('2028-10-31', 'NI') + '/' + f.shiftToWorkingDay('2028-10-31', 'BY'),
  JSON.stringify(f.lastEndedPeriod('2027-01-05', 'monthly')), JSON.stringify(f.lastEndedPeriod('2027-01-05', 'quarterly')),
  f.periodName({ year: 2026, month: 12 }), f.periodName({ year: 2026, quarter: 4 }),
]
console.log(out.join(' '))
" 2>&1 | tail -1)
read -r -a R <<<"$RULES"
assert_eq "Easter 2026 / 2027 / 2030 / 2035 (computed, no table that ends in 2030)" "${R[*]:0:4}" "2026-04-05 2027-03-28 2030-04-21 2035-03-25"
assert_eq "UStVA December 2026: 10.01.2027 is a Sunday → Monday 11.01.2027" "${R[4]}" "2027-01-11"
assert_eq "…with Dauerfristverlängerung a month later: 10.02.2027" "${R[5]}" "2027-02-10"
assert_eq "UStVA Q4 2026 (Bavaria): 11.01.2027, with Dauerfrist 10.02.2027" "${R[6]} ${R[7]}" "2027-01-11 2027-02-10"
assert_eq "UStVA September 2026: 10.10. is a Saturday → 12.10.2026" "${R[8]}" "2026-10-12"
assert_eq "UStVA May 2030: 10.06.2030 is Pfingstmontag → 11.06.2030" "${R[9]}" "2030-06-11"
assert_eq "ZM Q4 2026: 25.01.2027" "${R[10]}" "2027-01-25"
assert_eq "OSS Q4 2026: 31.01.2027 — a Sunday, not shifted" "${R[11]}" "2027-01-31"
assert_eq "Fronleichnam 2026 is a holiday in Bavaria, not nationwide, not in Lower Saxony" "${R[12]} ${R[13]} ${R[14]}" "2026-06-05 2026-06-04 2026-06-04"
assert_eq "Buß- und Bettag 2026 (18.11.) in Saxony only" "${R[15]} ${R[16]}" "2026-11-19 2026-11-18"
assert_eq "Reformationstag (Tuesday 31.10.2028): a holiday in Lower Saxony, not in Bavaria" "${R[17]}" "2028-11-01/2028-10-31"
assert_eq "in January the last ended month is December, the last ended quarter Q4" "${R[18]} ${R[19]}" '{"year":2026,"month":12} {"year":2026,"quarter":4}'
assert_eq "period names" "${R[*]:20:5}" "Dezember 2026 4. Quartal 2026"

# ── the endpoint, for a fresh company, on today's date ─────────────────────
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier801-e2e\",\"companyName\":\"$TAG Handel\"}" \
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
# Today, the periods around it and their deadlines — by the same rules, checked above
EXP=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
const m0 = f.periodContaining(today, 'monthly'), m1 = f.previousPeriod(m0), m2 = f.previousPeriod(m1), m3 = f.previousPeriod(m2)
const q0 = f.periodContaining(today, 'quarterly'), q1 = f.previousPeriod(q0)
console.log([today, m0.year, m0.month, f.ustvaDeadline(m0, false, null), q0.year, q0.quarter, f.ustvaDeadline(q0, true, null),
  m1.year, m1.month, f.ustvaDeadline(m1, false, null), m2.year, m2.month, m3.year, m3.month,
  q1.year, q1.quarter, f.zmDeadline(q1, null), f.ossDeadline(q1)].join(' '))
" 2>&1 | tail -1)
read -r TODAY M0Y M0 M0DUE Q0Y Q0 Q0DUE_DF M1Y M1 M1DUE M2Y M2 M3Y M3 Q1Y Q1 ZMDUE OSSDUE <<<"$EXP"
[[ "$TODAY" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] && pass "fixture: today is $TODAY" || { fail "fixture: today ($EXP)"; summary; exit 1; }

AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "GET /ustva/deadlines (was 404)" "$STATUS" "200"
assert_eq "nothing stated, nothing filed: monthly, no Dauerfrist — and it says it assumed so" \
  "$(P "(d['rhythm'], d['rhythmSource'], d['dauerfrist'], d['dauerfristSource'])")" "('monthly', 'default', False, 'default')"
assert_eq "the running month is listed with its deadline" \
  "$(P "[(x['year'], x['month'], x['dueDate']) for x in d['deadlines'] if x['kind']=='ustva' and x['status']=='running']")" "[($M0Y, $M0, '$M0DUE')]"
assert_eq "no return filed here yet: a past deadline is not called overdue (it was filed elsewhere)" \
  "$(P "[x for x in d['deadlines'] if x['status']=='overdue']")" "[]"
assert_eq "ZM and OSS open on the last ended quarter" "$(P "(d['defaults']['zm'], d['defaults']['oss'])")" \
  "({'year': $Q1Y, 'quarter': $Q1}, {'year': $Q1Y, 'quarter': $Q1})"
assert_eq "no ZM and no OSS sales: neither is listed" "$(P "[x['kind'] for x in d['deadlines'] if x['kind'] in ('zm', 'oss')]")" "[]"

# ── stated: quarterly with Dauerfristverlängerung ─────────────────────────
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":"quarterly","dauerfristverlaengerung":true}'
assert_eq "PUT /ustva/filing-settings" "$(P "(d['rhythm'], d['rhythmSource'], d['dauerfrist'], d['dauerfristSource'])")" "('quarterly', 'setting', True, 'setting')"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "the running quarter, a month later" \
  "$(P "[(x['year'], x['quarter'], x['dueDate']) for x in d['deadlines'] if x['kind']=='ustva' and x['status']=='running']")" "[($Q0Y, $Q0, '$Q0DUE_DF')]"
assert_eq "the UStVA page opens on a quarter" "$(P "d['defaults']['ustva']['month'] is None and d['defaults']['ustva']['quarter'] in (1,2,3,4)")" "True"
assert_eq "the change is in the audit trail, with the old values" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select action, \"oldData\" ? 'ustvaRhythmus', \"oldData\"->>'ustvaRhythmus' is null, \"oldData\" ? 'dauerfristverlaengerung', \"oldData\"->>'dauerfristverlaengerung' is null from \"AuditLog\" where \"companyId\"='$C' and action='company.ustva_settings.updated'")" \
  'company.ustva_settings.updated|t|t|t|t'

AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":"weekly"}'
assert_eq "an unknown rhythm is refused" "$STATUS" "400"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"dauerfristverlaengerung":"vielleicht"}'
assert_eq "a Dauerfrist that is no boolean is refused" "$STATUS" "400"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":"monthly"}' "x-readonly: 1"
assert_eq "read-only mode refuses the change" "$STATUS" "403"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":null,"dauerfristverlaengerung":null}'
assert_eq "null clears both — taken from the books again" "$(P "(d['rhythmSource'], d['dauerfristSource'])")" "('default', 'default')"

customer() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"$4\",${2:+\"vatId\":\"$2\",}\"address\":{\"street\":\"Rue 1\",\"postalCode\":\"1010\",\"city\":\"Stadt\",\"country\":\"$3\"}}"; json_field "$BODY" id; }
QSTART=$(python3 -c "print('%d-%02d-02' % ($Q1Y, ($Q1 - 1) * 3 + 1))")
FR=$(customer FR "FR12345678901" FR business)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$FR\",\"issueDate\":\"$QSTART\",\"euTransaction\":true,\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an innergemeinschaftliche Lieferung on $QSTART (before the returns lock the period)" "$STATUS" "200"

# ── from the books: the returns saved here ───────────────────────────────
file_month() { # year month — the return as computed, submitted
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"
  local uv; uv=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
  AS POST "/api/v1/ustva/filings?companyId=$C" "$uv"
}
file_month "$M3Y" "$M3"
[[ "$STATUS" =~ ^20[01]$ ]] && pass "fixture: the return of $M3/$M3Y submitted" || fail "fixture: filing ($STATUS $BODY)"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
assert_eq "a monthly return saved: the rhythm is monthly, from the filings" "$(P "(d['rhythm'], d['rhythmSource'])")" "('monthly', 'filings')"
assert_eq "after the first return filed here, a missing one is overdue: $M2/$M2Y — and the page opens on it" \
  "$(P "([(x['year'], x['month']) for x in d['deadlines'] if x['status']=='overdue'][:1], (d['defaults']['ustva']['year'], d['defaults']['ustva']['month']))")" \
  "([($M2Y, $M2)], ($M2Y, $M2))"
file_month "$M2Y" "$M2"; file_month "$M1Y" "$M1"
AS GET "/api/v1/ustva/deadlines?companyId=$C"
if [[ "$M1DUE" < "$TODAY" ]]; then
  assert_eq "all filed, last month's deadline passed: only the running month is left" "$(P "[(x['month'], x['status']) for x in d['deadlines'] if x['kind']=='ustva']")" "[($M0, 'running')]"
else
  assert_eq "all filed: last month's return is shown as filed until its deadline $M1DUE" "$(P "[(x['month'], x['status']) for x in d['deadlines'] if x['kind']=='ustva']")" "[($M1, 'filed'), ($M0, 'running')]"
fi

# ── ZM and OSS: listed while their deadline is ahead ─────────────────────
AS PUT "/api/v1/companies/$C?companyId=$C" '{"ossVerfahren":true}'
AS GET "/api/v1/ustva/deadlines?companyId=$C"
if [[ "$ZMDUE" < "$TODAY" ]]; then
  assert_eq "ZM Q$Q1/$Q1Y was due $ZMDUE — past, not listed" "$(P "[x for x in d['deadlines'] if x['kind']=='zm']")" "[]"
else
  assert_eq "ZM Q$Q1/$Q1Y listed, due $ZMDUE" "$(P "[(x['quarter'], x['dueDate'], x['status']) for x in d['deadlines'] if x['kind']=='zm']")" "[($Q1, '$ZMDUE', 'open')]"
fi
if [[ "$OSSDUE" < "$TODAY" ]]; then
  assert_eq "OSS Q$Q1/$Q1Y was due $OSSDUE — past, not listed" "$(P "[x for x in d['deadlines'] if x['kind']=='oss']")" "[]"
else
  assert_eq "in the OSS scheme: the quarter's return is listed, a nil return too, due $OSSDUE" \
    "$(P "[(x['quarter'], x['dueDate'], x['noteCode'], 'Nullmeldung' in (x['note'] or '')) for x in d['deadlines'] if x['kind']=='oss']")" "[($Q1, '$OSSDUE', 'oss-nil', True)]"
fi
assert_eq "the list is sorted by due date" "$(P "[x['dueDate'] for x in d['deadlines']] == sorted(x['dueDate'] for x in d['deadlines'])")" "True"

# another company's deadlines are not served
read -r U2 C2 < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-b@example.test\",\"password\":\"Tier801-e2e\",\"companyName\":\"$TAG Andere\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "x-user-id: $U2" -H "x-company-id: $C2" "$API/api/v1/ustva/deadlines?companyId=$C")
assert_eq "another company's deadlines: refused" "$CODE" "403"

summary
