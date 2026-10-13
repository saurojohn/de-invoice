#!/bin/bash
# Tier 682 — the review an adviser would make of the open questions.
#
#   1. OSS sales in the UStVA. They are not taxable here — the place of supply
#      is in the other member state — and would be if made here: Kennzahl 45
#      („Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)“), the
#      base only. They stood in no Kennzahl.
#   2. OSS in another currency. § 16 Abs. 6 Satz 4 UStG: converted at the
#      ECB's rate of the quarter's last day. The report added foreign amounts
#      to euros as they stood.
#   3. Taxes on income as expenses. Körperschaftsteuer, Solidaritätszuschlag
#      (§ 10 Nr. 2 KStG), Gewerbesteuer (§ 4 Abs. 5b EStG) and Einkommensteuer
#      (§ 12 Nr. 3 EStG) are no Betriebsausgaben. Entered as expenses they
#      lowered the profit and the income to be taxed, with nothing added back.
#   4. Gifts. § 4 Abs. 5 Satz 1 Nr. 1 EStG: 50 € a recipient from 2024, 35 €
#      before. 50 € applied to every year.
#   5. The fee for the first reminder. A reminder's cost is damage caused by
#      the default (§§ 280 Abs. 2, 286 BGB); the reminder that only puts the
#      customer in default is not. The default fee for it was 5 €, for a
#      "reform of § 288 BGB" that does not exist.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-406-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier682-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
customer() { # name type country → prints id
  local resp; resp=$(curl -sS -X POST "$API/api/v1/customers?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"name":"'"$1"'","type":"'$2'","address":{"street":"Weg 1","postalCode":"1000","city":"Ort","country":"'$3'"}}')
  json_field "$resp" id
}
invoice() { # customer date net rate [extra] → I, issued
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$1'","issueDate":"'$2'","dueDate":"2099-12-31","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":'$3',"vatRate":'$4'}]'"${5:+,$5}"'}'
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
kz45() { field "[k['value'] for k in d['kennzahlen'] if k['kz'] == '45'][0]"; }
# a day in the quarter before this one, and that quarter (German calendar)
read -r Y M Q EARLY Y0 M0 Q0 TODAY < <(TZ=Europe/Berlin python3 -c "
import datetime
t=datetime.date.today(); q=(t.month-1)//3+1
e=datetime.date(t.year,3*(q-1)+1,1)-datetime.timedelta(days=20)
print(t.year,t.month,q,e.isoformat(),e.year,e.month,(e.month-1)//3+1,t.isoformat())")

note "=== 1. the rules ==="
cat > "$SCRIPT_DIR/../.tier682-probe.ts" <<'TS'
import { isIncomeTax as t, notAnExpense, expenseCost } from './src/modules/accounting/expense-cost'
import { giftLimitFor, nonDeductibleGifts } from './src/modules/accounting/gifts'
const yes = ['Körperschaftsteuer', 'Körperschaftsteuer-Vorauszahlung Q2', 'KSt', 'Gewerbesteuer', 'GewSt-Vorauszahlung', 'Solidaritätszuschlag', 'Einkommensteuer']
const no = ['Umsatzsteuer', 'Lohnsteuer', 'Kfz-Steuer', 'Grundsteuer', 'Steuerberatung', 'Gewerbesteuer-Beratung', 'Büromaterial', '', 'Estrich', 'Solidarbeitrag']
console.log(`yes=${yes.filter((x) => !t(x)).join('|') || 'all'}`)
console.log(`no=${no.filter((x) => t(x)).join('|') || 'none'}`)
console.log(`cost=${expenseCost({ netAmount: 5000, grossAmount: 5000, category: 'Gewerbesteuer' }, false)}/${!!notAnExpense('Gewerbesteuer')}/${notAnExpense('Grundsteuer')}`)
const gift = (id: string, date: string, net: number) => ({ id, invoiceDate: new Date(date), netAmount: net, grossAmount: net * 1.19, giftRecipient: 'Frau Muster' })
console.log(`gifts=${giftLimitFor(2023)}/${giftLimitFor(2024)}/${[...nonDeductibleGifts([gift('a', '2023-05-01', 40)], false)].length}/${[...nonDeductibleGifts([gift('b', '2024-05-01', 40)], false)].length}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier682-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "taxes on income: KSt, Soli, GewSt, ESt and their prepayments" "$(P yes)" "all"
assert_eq "not meant: VAT, wage tax, car tax, Grundsteuer, the adviser's fee" "$(P no)" "none"
assert_eq "such an expense costs nothing, and is named as none" "$(P cost)" "0/true/null"
assert_eq "gifts: 35 € up to 2023, 50 € from 2024 — a gift of 40 € is over the limit in 2023 (was within), within it in 2024" "$(P gifts)" "35/50/1/0"

note "=== 2. taxes on income are not taken as expenses ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier682-e2e\",\"companyName\":\"$TAG Handel GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE811907980
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Finanzamt","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'; SUP=$(field "d['id']")
body() { echo "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"$1\",\"description\":\"$2\",\"invoiceDate\":\"$EARLY\",\"paidAt\":\"$EARLY\",\"category\":\"$2\",\"netAmount\":$3,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":$3,\"confirmDuplicate\":true}"; }
AS POST "/api/v1/expenses?companyId=$C" "$(body S-1 Gewerbesteuer 5000)"
assert_eq "Gewerbesteuer as an expense: refused (was taken, and lowered the income to be taxed)" "$STATUS" "400"
echo "$BODY" | grep -q "§ 10 Nr. 2 KStG" && echo "$BODY" | grep -q "KSt 1" && pass "… with the rule, and where prepayments are entered" || fail "the refusal does not explain itself"
AS POST "/api/v1/expenses?companyId=$C" "$(body S-2 Körperschaftsteuer 6000)"
assert_eq "Körperschaftsteuer: refused" "$STATUS" "400"
AS POST "/api/v1/expenses?companyId=$C" "$(body S-3 Steuerberatung 800)"
assert_eq "the adviser's fee is an expense" "$STATUS" "201"
AS POST "/api/v1/expenses?companyId=$C" "$(body S-4 Grundsteuer 300)"
assert_eq "so is the Grundsteuer" "$STATUS" "201"
# a row from before
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c "INSERT INTO \"Expense\" (id, \"companyId\", \"invoiceNumber\", description, \"invoiceDate\", \"paidAt\", \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\", category, \"isIntraEU\", \"isReverseCharge\", status, \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid(), '$C', 'ALT-1', 'Gewerbesteuer', '$EARLY', '$EARLY', 5000, 0, 0, 5000, 'Gewerbesteuer', false, false, 'booked', NOW(), NOW())" >/dev/null
AS GET "/api/v1/accounting/kst1?companyId=$C&year=$Y0"
assert_eq "KSt 1: a tax entered as an expense before does not lower the result — −1 100 € (was −6 100 €)" "$(field "d['totals']['jahresueberschuss']")" "-1100"

note "=== 3. OSS sales: Kennzahl 45, and euros at the quarter's last rate ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"ossVerfahren":true}'
FR=$(customer "Marie Dupont" individual FR); SE=$(customer "Sven Svensson" individual SE); CHC=$(customer "Urs Meier" individual CH)
invoice "$FR" "$EARLY" 100 0.20
invoice "$SE" "$EARLY" 1085 0.25 '"currency":"USD"'
invoice "$CHC" "$EARLY" 400 0
[[ -n "$I" ]] && pass "fixture: a sale to France in euros, one to Sweden in dollars, an export to Switzerland" || fail "fixture: $BODY"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y0&month=$M0"
assert_eq "UStVA: Kz 45 has the two OSS sales' net — 100 + 1 000 (was 0: they stood in no Kennzahl); the Swiss sale is an export, Kz 43" \
  "$STATUS $(kz45) $(field "[k['value'] for k in d['kennzahlen'] if k['kz'] == '43'][0]")" "200 1100 400"
assert_eq "… their tax is not in the return" "$(field "(d['ossSales']['net'], d['ossSales']['vat'], d['umsatzsteuer'])")" "(1100, 270, 0)"
AS GET "/api/v1/reports/oss?companyId=$C&year=$Y0&quarter=$Q0"
assert_eq "OSS report: Sweden 1 000 € / 250 € — 1 085 USD at the ECB's rate of the quarter's last day (was 1 085 / 271,25)" \
  "$(field "[(c['country'], c['netAmount'], c['vatAmount']) for c in d['countries']]")" "[('SE', 1000, 250), ('FR', 100, 20)]"
assert_eq "… and the rate is named, as final" "$(field "[(w['currency'], w['rate'], w['vorlaeufig'], w['invoiceCount']) for w in d['waehrungen']]")" "[('USD', 1.085, False, 1)]"
invoice "$SE" "$TODAY" 2170 0.25 '"currency":"USD"'
AS GET "/api/v1/reports/oss?companyId=$C&year=$Y&quarter=$Q"
assert_eq "a sale of the running quarter: at the invoice's rate until the quarter ends, and marked so" \
  "$(field "([(c['country'], c['netAmount']) for c in d['countries']], [(w['currency'], w['rate'], w['vorlaeufig']) for w in d['waehrungen']])")" "([('SE', 2000)], [('USD', None, True)])"

note "=== 4. the first reminder costs nothing by default ==="
AS GET "/api/v1/reminders/mahnungen/fees-config?companyId=$C"
assert_eq "0 € / 5 € / 10 € (the first was 5 €)" "$STATUS $(field "(d['mahngebuehr']['first'], d['mahngebuehr']['second'], d['mahngebuehr']['final'], d['verzugszinsPct'])")" "200 (0, 5, 10, 9)"
AS PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"verzugszinsPct":9,"mahngebuehr":{"first":2.5,"second":5,"final":10}}'
AS GET "/api/v1/reminders/mahnungen/fees-config?companyId=$C"
assert_eq "a company that may charge one can set it" "$(field "d['mahngebuehr']['first']")" "2.5"
grep -q "BGBl. I 2022 Nr. 51)\" that" "$SCRIPT_DIR/../src/modules/reminder/reminder.service.ts" && ! grep -q "lets the creditor charge a Mahngebühr$" "$SCRIPT_DIR/../src/modules/reminder/reminder.service.ts" \
  && pass "the code no longer rests the default on a reform of § 288 BGB that does not exist" || fail "the comment still cites the reform as a fact"

note "=== 5. on the pages ==="
FE="$SCRIPT_DIR/../../frontend"
for lang in de en zh; do
  python3 - "$FE/messages/$lang.json" <<'PY' && pass "the texts: $lang" || fail "texts old: $lang"
import json,sys
m=json.load(open(sys.argv[1],encoding='utf-8'))
ok = 'Kz 45' in m['ustva']['ossNote'] and 'Kz 45' in m['settings']['ossVerfahrenHelp'] and '16' in m['invoice']['exchangeRateHint'] and ('Gestattung' in m['invoice']['exchangeRateHint'] or 'permission' in m['invoice']['exchangeRateHint'] or '许可' in m['invoice']['exchangeRateHint']) and '§288 BGB)' not in m['mahnung']['feesSubtitle']
sys.exit(0 if ok else 1)
PY
done

summary
