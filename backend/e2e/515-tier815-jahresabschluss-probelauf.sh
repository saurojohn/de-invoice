#!/bin/bash
# Tier 815 — the year-end dry run: a GmbH's past year, closed
#
# A fresh GmbH with a year of business (the year before today, so its books
# can be closed): invoices at 19 % (one open at the year's end), 7 %, an
# intra-EU supply, a cash sale, rent, material, a bill left unpaid, bank fees,
# a laptop bought on 0400 and in the asset register with its AfA booked, GewSt
# and KSt prepayments paid. What the reports must agree on, and what the
# closing (Festschreibung, Tier 609) must keep.
#
# Found in the dry run (06./07.11.2026) and fixed:
#   - the laptop's purchase on 0400 stood in the GuV, EÜR and BWA as 1 500 €
#     of costs and again as its AfA — the profit 1 500 € too low;
#   - the Bilanz's tax provision was the year's taxes less the GewSt amounts
#     *entered* — the KSt prepayments paid (booked as expenses) stayed in it;
#   - the prepayments of a closed year could still be changed (they change
#     its provision).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-515-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier815-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111115
[[ -n "${C:-}" ]] && pass "fixture: a fresh GmbH" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
NOK=0; ok() { [[ "$STATUS" =~ ^20 ]] || { NOK=$((NOK + 1)); echo "  fixture step failed: $1 $STATUS $(echo "$BODY" | cut -c1-160)"; }; }
AS GET "/api/v1/ustva/deadlines?companyId=$C"; Y=$(( ${BODY:0:0}$(P "d['today'][:4]") - 1 ))

AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'; ok rechtsform
AS POST "/api/v1/accounting/accounts/seed?companyId=$C"; ok seed
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"; ok customer
K=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG FR\",\"type\":\"business\",\"vatId\":\"FR12345678901\",\"address\":{\"street\":\"Rue 1\",\"postalCode\":\"75001\",\"city\":\"Paris\",\"country\":\"FR\"}}"; ok customer-fr
FR=$(json_field "$BODY" id)
inv() { # customer date net rate [eu] → id
  local eu=""; [[ -n "${5:-}" ]] && eu=",\"euTransaction\":true"
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$2\"$eu,\"items\":[{\"description\":\"Leder\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$3,\"vatRate\":$4}]}"; ok "invoice $2"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'; ok "send $2"
  echo "$id"
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"bank_transfer\"}"; ok "pay $3"; }
expense() { # date net vat category account [paid]
  local paid=""; [[ "${6:-}" == paid ]] && paid=",\"paidAt\":\"$1\""
  local rate; rate=$(python3 -c "print(round($3/$2,2) if $2 else 0)")
  AS POST "/api/v1/expenses?companyId=$C" "{\"description\":\"$4 $1\",\"invoiceDate\":\"$1\",\"netAmount\":$2,\"vatRate\":$rate,\"vatAmount\":$3,\"grossAmount\":$(python3 -c "print($2+$3)"),\"category\":\"$4\",\"accountNumber\":\"$5\"$paid}"; ok "expense $4 $1"
}
for m in 03 06 09 12; do
  I=$(inv "$K" "$Y-$m-05" 1000 0.19)
  [[ $m != 12 ]] && pay "$I" 1190 "$Y-$m-20"
  expense "$Y-$m-01" 1000 190 Miete 4210 paid
  expense "$Y-$m-28" 10 0 Bankgebühren 4970 paid
done
I=$(inv "$K" "$Y-06-10" 2000 0.07); pay "$I" 2140 "$Y-06-25"
I=$(inv "$FR" "$Y-09-10" 5000 0 eu); pay "$I" 5000 "$Y-09-30"
expense "$Y-04-15" 3000 570 Material 3400 paid
expense "$Y-12-10" 500 95 Bürobedarf 4930
# the laptop: bought on 0400, and in the asset register — 1 500 € over 36 months from March: 416,67 €
expense "$Y-03-15" 1500 285 Betriebsausstattung 0400 paid
AS POST "/api/v1/assets?companyId=$C" "{\"type\":\"Betriebsausstattung\",\"bezeichnung\":\"Laptop\",\"anschaffungsDatum\":\"$Y-03-15\",\"anschaffungsKosten\":1500,\"nutzungsdauerMonate\":36}"; ok asset
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$Y"; ok afa
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$Y-02-01\",\"type\":\"einnahme\",\"description\":\"Barverkauf\",\"amount\":238,\"vatRate\":0.19}"; ok cash
# prepayments: GewSt entered and paid 4 × 100 €, KSt paid 4 × 100 € (booked, not entered)
AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$Y,\"q1\":100,\"q2\":100,\"q3\":100,\"q4\":100}"; ok gewst-settings
for d in 02-15 05-15 08-15 11-15; do expense "$Y-$d" 100 0 Gewerbesteuer 4320 paid; done
for d in 03-10 06-10 09-10 12-10; do expense "$Y-$d" 100 0 Körperschaftsteuer 2200 paid; done
assert_eq "fixture: the year $Y booked" "$NOK" "0"
# revenue 4 000 + 2 000 + 5 000 + 200 = 11 200; costs 4 000 + 40 + 3 000 + 500 = 7 540; AfA 416,67 → 3 243,33
EXPECTED_RESULT=3243.33

note "=== the reports agree ==="
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "GuV: revenue 11 200, the result before taxes 3 243,33 (the laptop by its AfA only — was 1 743,33, its 1 500 € a cost as well)" \
  "$(P "(d['totals']['umsatzerloese'], d['totals']['betriebsergebnis'])")" "(11200, $EXPECTED_RESULT)"
TAXES=$(P "[l['amount'] for l in d['tax']['lines'] if l['position'] == '14'][0]"); NET=$(P "d['totals']['jahresueberschuss']")
AS GET "/api/v1/reports/bwa?companyId=$C&year=$Y&month=12"
assert_eq "BWA, the year: the same result before taxes, nothing for the laptop's purchase" \
  "$(P "round(sum(l['ytd'] for l in d['lines'] if l['bucket'] == '1000') - sum(l['ytd'] for l in d['lines'] if l['bucket'] not in ('1000', '5000')), 2)")" "$EXPECTED_RESULT"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "EÜR: no 1 500 € of „sonstige Aufwendungen\" for the laptop — its AfA, and its Vorsteuer among the 1 615 € paid" \
  "$(P "sorted((l['kennziffer'], l['amount']) for l in d['ausgaben'] if l['kennziffer'] in ('4600', '5850'))")" "[('4600', 416.67), ('5850', 1615)]"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=$Y"
assert_eq "KSt 1: from the result before taxes; the prepayments paid, KSt and GewSt (was: the GewSt entered only)" \
  "$(P "(d['jahresueberschuss'], d['totals']['zuZahlen'], d['totals']['vorauszahlungen'])")" "($EXPECTED_RESULT, $TAXES, 800)"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
assert_eq "Bilanz: the provision is the taxes less the 800 € paid (was: less the 400 € entered); 2400 is the GuV's net income; balanced" \
  "$(P "([l['amount'] for s in d['passiva'] for l in s['lines'] if l['position'] == '3100'][0], [l['amount'] for s in d['passiva'] for l in s['lines'] if l['position'] == '2400'][0], d['balanceCheck']['balanced'])")" \
  "($(python3 -c "print(round($TAXES - 800, 2))"), $NET, True)"
assert_eq "…the laptop at 1 083,33, the receivable 1 190, the payable 595" \
  "$(P "[(l['position'], l['amount']) for side in ('aktiva', 'passiva') for s in d[side] for l in s['lines'] if l['position'] in ('0400', '1500', '4000')]")" \
  "[('0400', 1083.33), ('1500', 1190), ('4000', 595)]"
BIL="$BODY"
AS GET "/api/v1/accounting/ebilanz?companyId=$C&year=$Y"
assert_eq "E-Bilanz: the Bilanz's sums and the GuV's net income" \
  "$(P "[p['value'] for p in d['positions'] if p['source'] in ('bilanz.aktiva.summe', 'bilanz.passiva.summe', 'guv.jahresueberschuss')]")" \
  "$(python3 -c "import sys,json;b=json.loads(sys.argv[1]);print([b['totals']['aktiva'], b['totals']['passiva'], $NET])" "$BIL")"
VAT=$(for m in 1 2 3 4 5 6 7 8 9 10 11 12; do curl -sS "$API/api/v1/ustva/compute?companyId=$C&year=$Y&month=$m" -H "x-user-id: $U" -H "x-company-id: $C"; echo; done | python3 -c "
import sys,json
u=v=0
for line in sys.stdin:
    if line.strip(): d=json.loads(line); u+=d['umsatzsteuer']; v+=d['vorsteuerSum']
print('%.2f %.2f' % (u, v))")
AS GET "/api/v1/ustva/ustja?companyId=$C&year=$Y"
assert_eq "UStJA = the twelve UStVA: USt 938, Vorsteuer 1 710 (the laptop's 285 among it)" "$VAT/$(P "'%.2f %.2f' % (d['totals']['umsatzsteuer'], d['totals']['vorsteuer'])")" "938.00 1710.00/938.00 1710.00"
AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=$Y"
assert_eq "the Abstimmung: the laptop has its asset — no purchase without one" "$(P "d['assetPurchases']")" "[]"
curl -sS -o "$TMP/datev.csv" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "DATEV: revenue gross on 8400 / 8300 / 8125, the laptop on 0400 less its AfA, its AfA on 4830" \
  "$(datev_balance "$TMP/datev.csv" 8400) $(datev_balance "$TMP/datev.csv" 8300) $(datev_balance "$TMP/datev.csv" 8125) $(datev_balance "$TMP/datev.csv" 0400) $(datev_balance "$TMP/datev.csv" 4830)" \
  "-4998.00 -2140.00 -5000.00 1368.33 416.67"

note "=== an expense on an Anlagekonto with no asset is listed ==="
expense "$Y-05-02" 900 171 Betriebsausstattung 0400 paid
AS GET "/api/v1/accounting/abstimmung?companyId=$C&year=$Y"
assert_eq "a printer on 0400 with no asset: listed (its cost is in no report)" "$(P "[(a['date'], a['accountNumber'], a['net']) for a in d['assetPurchases']]")" "[('$Y-05-02', '0400', 900)]"

note "=== the year closed ==="
AS PUT "/api/v1/accounting/books-closing?companyId=$C" "{\"closedUntil\":\"$Y-12-31\"}"
assert_eq "the books closed up to 31.12.$Y" "$STATUS" "200"
DEC=$(q "select id from \"Invoice\" where \"companyId\"='$C' and status='sent' order by \"issueDate\" desc limit 1")
AS POST "/api/v1/expenses?companyId=$C" "{\"description\":\"spät\",\"invoiceDate\":\"$Y-12-20\",\"netAmount\":10,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":10,\"category\":\"Bürobedarf\"}"
assert_eq "an expense dated in the closed year: refused" "$STATUS" "400"
AS POST "/api/v1/invoices/$DEC/payments?companyId=$C" "{\"amount\":1,\"paymentDate\":\"$Y-12-31\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "a payment dated in it: refused" "$STATUS" "400"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$Y-12-30\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1,\"vatRate\":0.19}]}"
D=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$D/status?companyId=$C" '{"status":"sent"}'
assert_eq "an invoice of the closed year: a draft can be written, not issued" "$STATUS" "400"
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=$Y"
assert_eq "the year's AfA: not reversed" "$STATUS" "400"
AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$Y,\"q1\":200,\"q2\":100,\"q3\":100,\"q4\":100}"
assert_eq "its GewSt prepayments: not changed (was 200 — they move its provision)" "$STATUS/$(P "'abgeschlossen' in d.get('message', '')")" "400/True"
AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$Y,\"q1\":100,\"q2\":100,\"q3\":100,\"q4\":100,\"hebesatz\":400}"
assert_eq "…saved unchanged (the page saves the Hebesatz with the year shown): accepted" "$STATUS" "200"
AS PUT "/api/v1/accounting/kst1/vorauszahlungen?companyId=$C" "{\"year\":$Y,\"q1\":50,\"q2\":0,\"q3\":0,\"q4\":0}"
assert_eq "its KSt prepayments: not changed" "$STATUS" "400"
AS POST "/api/v1/invoices/$DEC/payments?companyId=$C" "{\"amount\":1190,\"paymentDate\":\"$((Y + 1))-01-15\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "the December invoice paid in the new year: booked" "$STATUS" "201"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
assert_eq "…and the closed year's Bilanz as it was (the receivable stays, the provision too)" \
  "$(P "[(l['position'], l['amount']) for side in ('aktiva', 'passiva') for s in d[side] for l in s['lines'] if l['position'] in ('1500', '3100')]")" \
  "[('1500', 1190), ('3100', $(python3 -c "print(round($TAXES - 800, 2))"))]"
for r in "accounting/ebilanz.xml?companyId=$C&year=$Y" "accounting/berater-packager?companyId=$C&year=$Y" "reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"; do
  CODE=$(curl -sS -o "$TMP/out" -w "%{http_code}" "$API/api/v1/$r" -H "x-user-id: $U" -H "x-company-id: $C")
  assert_eq "the closed year still exports: ${r%%\?*}" "$CODE/$([[ $(wc -c < "$TMP/out") -gt 1000 ]] && echo data)" "200/data"
done

summary
