#!/bin/bash
# Tier 802 — the annual returns and the Sondervorauszahlung among the deadlines
#
# Tier 801 listed UStVA, ZM and OSS. Missing: the annual returns (USt, ESt /
# KSt, GewSt — 31 July of the following year, with a Steuerberater the end
# of February of the year after, § 149 Abs. 2 / 3 AO), and for a monthly
# filer with Dauerfristverlängerung the Sondervorauszahlung of 1/11 of the
# previous year's Vorauszahlungen by 10 February (§§ 47, 48 UStDV); without
# the extension, the day by which it can be applied for.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-503-$(date +%s%N | cut -c1-13)"

RULES=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
console.log([
  f.annualReturnDeadline(2025, false, null), f.annualReturnDeadline(2026, false, null),
  f.annualReturnDeadline(2024, true, null), f.annualReturnDeadline(2025, true, null), f.annualReturnDeadline(2026, true, null),
  f.sondervorauszahlungDeadline(2027, null), f.sondervorauszahlungDeadline(2029, null),
].join(' '))
" 2>&1 | tail -1)
read -r -a R <<<"$RULES"
assert_eq "annual returns 2025 without a Berater: 31.07.2026" "${R[0]}" "2026-07-31"
assert_eq "…2026: 31.07.2027 is a Saturday → 02.08.2027" "${R[1]}" "2027-08-02"
assert_eq "with a Berater: 2024 → 30.04.2026, 2025 → 28.02.2027 (Sunday) → 01.03.2027, 2026 → 29.02.2028" "${R[*]:2:3}" "2026-04-30 2027-03-01 2028-02-29"
assert_eq "Sondervorauszahlung 2027: 10.02.2027; 2029: 10.02. is a Saturday → 12.02.2029" "${R[*]:5:2}" "2027-02-10 2029-02-12"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier802-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111111
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
# today and what the rules say for it
EXP=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const f = require('./src/modules/reports/filing-deadlines')
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
const y = Number(today.slice(0, 4))
const annual = (b) => [y - 2, y - 1].filter((x) => f.annualReturnDeadline(x, b, null) >= today).map((x) => x + ':' + f.annualReturnDeadline(x, b, null)).join(',') || '-'
const target = today.slice(5) >= '12-01' ? y + 1 : y
const svzDue = f.sondervorauszahlungDeadline(target, null)
const svzWindow = svzDue >= today && today >= (target - 1) + '-12-01'
const q1 = f.ustvaDeadline({ year: y, quarter: 1 }, false, null)
const qWindow = q1 >= today && today >= y + '-03-01'
console.log([today, annual(false), annual(true), target, svzDue, svzWindow, q1, qWindow].join(' '))
" 2>&1 | tail -1)
read -r TODAY ANN_SELF ANN_BERATER TARGET SVZDUE SVZWIN Q1DUE QWIN <<<"$EXP"
[[ "$TODAY" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] && pass "fixture: today is $TODAY" || { fail "fixture: today ($EXP)"; summary; exit 1; }
annual_rows() { AS GET "/api/v1/ustva/deadlines?companyId=$C"; P "','.join('%d:%s' % (x['year'], x['dueDate']) for x in d['deadlines'] if x['kind']=='annual') or '-'"; }

# ── the annual returns ────────────────────────────────────────────────────
assert_eq "without a Berater: the annual returns whose deadline is ahead ($ANN_SELF)" "$(annual_rows)" "$ANN_SELF"
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"jahreserklaerungDurchBerater":true}'
assert_eq "PUT jahreserklaerungDurchBerater" "$(P "d['berater']")" "True"
assert_eq "with a Berater: the later deadlines ($ANN_BERATER)" "$(annual_rows)" "$ANN_BERATER"
if [[ "$ANN_BERATER" != "-" ]]; then
  AY=${ANN_BERATER%%:*}
  AS GET "/api/v1/ustva/deadlines?companyId=$C"
  assert_eq "the row says it is the Berater's deadline, open" "$(P "[(x['noteCode'], x['status']) for x in d['deadlines'] if x['kind']=='annual' and x['year']==$AY]")" "[('annual-berater', 'open')]"
  AS POST "/api/v1/ustva/payments?companyId=$C" "{\"kind\":\"ustja\",\"year\":$AY,\"paidAt\":\"$TODAY\",\"amount\":12.5}"
  assert_eq "fixture: the annual return's Abschlusszahlung recorded" "$STATUS" "201"
  AS GET "/api/v1/ustva/deadlines?companyId=$C"
  assert_eq "its Abschlusszahlung recorded: the return of $AY counts as filed" "$(P "[x['status'] for x in d['deadlines'] if x['kind']=='annual' and x['year']==$AY]")" "['filed']"
  AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer"}'
  AS GET "/api/v1/ustva/deadlines?companyId=$C"
  assert_eq "a Kleinunternehmer: ESt and GewSt, no annual VAT return since 2024" "$(P "[x['noteCode'] for x in d['deadlines'] if x['kind']=='annual' and x['year']==$AY]")" "['annual-ku']"
  AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":null}'
fi
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"jahreserklaerungDurchBerater":"vielleicht"}'
assert_eq "a Berater flag that is no boolean is refused" "$STATUS" "400"
assert_eq "the audit row carries the old value of the Berater flag too" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select \"oldData\"->>'jahreserklaerungDurchBerater' is null, \"newData\"->>'jahreserklaerungDurchBerater' from \"AuditLog\" where \"companyId\"='$C' and action='company.ustva_settings.updated' order by \"createdAt\" limit 1")" "t|true"

# ── the Sondervorauszahlung, and the Dauerfrist application ──────────────
# a sale of the year the Sondervorauszahlung is reckoned on: 1 100 € + 209 € USt → 1/11 = 19 €
CUS=$(AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Weg 1\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"}}"; json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$CUS\",\"issueDate\":\"$((TARGET - 1))-03-02\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1100,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: a sale of 1 100 € on $((TARGET - 1))-03-02" "$STATUS" "200"
svz() { AS GET "/api/v1/ustva/deadlines?companyId=$C"; P "[(x['kind'], x['year'], x['dueDate'], x['status'], None if x.get('amount') is None else float(x['amount'])) for x in d['deadlines'] if x['kind'] in ('svz', 'dauerfrist')]"; }

AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":"monthly","dauerfristverlaengerung":true}'
if [[ "$SVZWIN" == true ]]; then
  assert_eq "monthly with Dauerfrist: the Sondervorauszahlung $TARGET, due $SVZDUE, 1/11 of 209 €" "$(svz)" "[('svz', $TARGET, '$SVZDUE', 'open', 19.0)]"
  AS POST "/api/v1/ustva/payments?companyId=$C" "{\"kind\":\"sondervorauszahlung\",\"year\":$TARGET,\"paidAt\":\"$TODAY\",\"amount\":19}"
  assert_eq "…paid and recorded: filed" "$(svz)" "[('svz', $TARGET, '$SVZDUE', 'filed', 19.0)]"
else
  assert_eq "monthly with Dauerfrist, outside December–10 February: no Sondervorauszahlung row" "$(svz)" "[]"
fi
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"dauerfristverlaengerung":false}'
if [[ "$SVZWIN" == true ]]; then
  assert_eq "monthly without Dauerfrist: it can be applied for by $SVZDUE" "$(svz)" "[('dauerfrist', $TARGET, '$SVZDUE', 'option', None)]"
else
  assert_eq "monthly without Dauerfrist, outside the window: nothing" "$(svz)" "[]"
fi
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"ustvaRhythmus":"quarterly"}'
if [[ "$QWIN" == true ]]; then
  assert_eq "quarterly without Dauerfrist: it can be applied for by the Q1 deadline $Q1DUE" "$(svz)" "[('dauerfrist', ${TODAY:0:4}, '$Q1DUE', 'option', None)]"
else
  assert_eq "quarterly without Dauerfrist, outside March–Q1 deadline: nothing" "$(svz)" "[]"
fi
AS PUT "/api/v1/ustva/filing-settings?companyId=$C" '{"dauerfristverlaengerung":true}'
assert_eq "quarterly with Dauerfrist: no Sondervorauszahlung, ever" "$(svz)" "[]"

summary
