#!/bin/bash
# Tier 838 — the counted difference of a Tagesabschluss is booked (the cash-book
# drill: Kasse Leder, an Einzelunternehmen with a till, October 2026, on the
# production images).
#
# A count 2,50 € below the book was only noted on the close: the next day began
# with the book's 1 132,50 €, not the 1 130 € in the till, so the next exact
# count (1 549 €) was refused as "Differenz −2,50" — on every later day again.
# The EÜR, GuV and DATEV never saw the Fehlbetrag. And the Kassenbuch export
# listed the newest entry first, without a balance, and at most 200 entries.
#
# Now the close books the difference — a Fehlbetrag as an Ausgabe (sonstiger
# betrieblicher Aufwand), an Überschuss as an Einnahme (sonstiger Ertrag), both
# without USt and outside the UStVA; reopening the day takes it back. The
# export is the whole book in order, with the running Kassenbestand.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-532-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier838-e2e\",\"companyName\":\"$TAG Laden\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: company" || { fail "register"; summary; exit 1; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
fixture_issuer "$C"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"ist"}'
assert_status 200 "fixture: an Einzelunternehmen, Ist-Versteuerung"
Q="companyId=$C"
E() { AS POST "/api/v1/cashbook/entries?$Q" "$1"; assert_status 201 "fixture: $2"; }
E '{"businessDate":"2026-10-01","type":"eroeffnung","description":"Anfangsbestand","amount":500}' "opening balance 500"
E '{"businessDate":"2026-10-01","type":"einnahme","description":"Tageslosung","amount":1190,"vatRate":0.19}' "takings 1 190 at 19 %"
E '{"businessDate":"2026-10-01","type":"einnahme","description":"Tageslosung Bücher","amount":107,"vatRate":0.07}' "takings 107 at 7 %"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-01","physicalCount":1797}'
assert_status 201 "01.10. closed, counted exactly"
E '{"businessDate":"2026-10-02","type":"ausgabe","description":"Büromaterial","amount":59.5,"vatRate":0.19}' "office supplies 59,50"
E '{"businessDate":"2026-10-02","type":"ausgabe","description":"Privatentnahme","amount":200}' "Privatentnahme 200"
E '{"businessDate":"2026-10-02","type":"umbuchung","description":"Geldtransit zur Bank","amount":1000}' "Geldtransit 1 000"
E '{"businessDate":"2026-10-02","type":"einnahme","description":"Tageslosung","amount":595,"vatRate":0.19}' "takings 595"

note "=== 1. a Fehlbetrag is booked with the close ==="
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-02","physicalCount":1130,"differenzNote":"nicht aufklärbar"}'
assert_status 201 "02.10. closed: 1 130 € counted, the book says 1 132,50 €"
assert_eq "the close: difference −2,50, Endbestand the counted 1 130 (was 1 132,50)" \
  "$(py "print('%.2f %.2f %.2f' % (float(d['differenz']), float(d['endbestand']), float(d['ausgabenSum'])))")" "-2.50 1130.00 262.00"
AS GET "/api/v1/cashbook/entries?$Q&from=2026-10-02&to=2026-10-02"
DIFF_ID=$(py "print([e['id'] for e in d['data'] if e.get('kind')=='kassendifferenz'][0])")
assert_eq "the Kassenbuch has the line (was: none)" \
  "$(py "print([(e['type'], '%.2f' % float(e['amount']), e['description'], e['notes']) for e in d['data'] if e.get('kind')=='kassendifferenz'])")" \
  "[('ausgabe', '2.50', 'Kassenfehlbetrag lt. Kassensturz', 'nicht aufklärbar')]"
AS GET "/api/v1/cashbook/day?$Q&date=2026-10-05"
assert_eq "05.10. begins with the counted 1 130 (was 1 132,50)" "$(py "print('%.2f' % d['anfang'])")" "1130.00"
E '{"businessDate":"2026-10-05","type":"einnahme","description":"Privateinlage","amount":300}' "Privateinlage 300"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-05","physicalCount":1430}'
assert_status 201 "05.10. counted exactly 1 430 — no phantom difference (was 400 \"Differenz −2,5\")"

note "=== 2. an Überschuss too ==="
E '{"businessDate":"2026-10-06","type":"einnahme","description":"Tageslosung","amount":119,"vatRate":0.19}' "takings 119"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-06","physicalCount":1550.2,"differenzNote":"Wechselgeld zu wenig herausgegeben?"}'
assert_status 201 "06.10. closed: 1,20 € more than the book"
AS GET "/api/v1/cashbook/balance?$Q"
assert_eq "the Kassenbestand is the counted 1 550,20 (was 1 551,50)" "$(py "print('%.2f' % d['balance'])")" "1550.20"

note "=== 3. the reports ==="
AS GET "/api/v1/ustva/compute?$Q&year=2026&month=10"
assert_eq "UStVA 10/2026: USt 190 + 7 + 95 + 19, Vorsteuer 9,50 — neither difference in it" \
  "$(py "print('%.2f %.2f' % (d['umsatzsteuer'], d['vorsteuerSum']))")" "311.00 9.50"
AS GET "/api/v1/accounting/euer?$Q&year=2026"
assert_eq "EÜR: sonstige Betriebseinnahmen 1,20, Betriebsausgaben 50 + 2,50 + Vorsteuer 9,50 (were 0 / 59,50)" \
  "$(py "
k=sum(l['amount'] for l in d['einnahmen'] if l['kennziffer']=='4190')
print('%.2f %.2f %.2f' % (k, d['totals']['ausgabenTotal'], d['totals']['gewinn']))")" "1.20 62.00 1950.20"
AS GET "/api/v1/reports/datev-preview?$Q&startDate=2026-10-01&endDate=2026-10-31"
KONTEN='a=dict((x["konto"], x["soll"] - x["haben"]) for x in d["byAccount"]); print("%.2f %.2f %.2f %.2f %s" % (a["1000"], a.get("4900", 0), a.get("2700", 0), a.get("1800", 0), d["balanceDelta"]))'
assert_eq "DATEV: Kasse 1000 moves by the counted 1 050,20 (500 is the opening); 4900 +2,50 · 2700 −1,20; no Privatentnahme beyond the 200" \
  "$(py "$KONTEN")" "1050.20 2.50 -1.20 200.00 0"

note "=== 4. the difference belongs to the close ==="
AS POST "/api/v1/cashbook/entries/$DIFF_ID/reverse?$Q" '{"reason":"weg damit"}'
assert_status 400 "it is not reversed on its own"
AS DELETE "/api/v1/cashbook/entries/$DIFF_ID?$Q"
assert_status 400 "nor deleted"
AS POST "/api/v1/cashbook/reopen-day?$Q" '{"date":"2026-10-06"}'
assert_status 201 "06.10. reopened"
AS GET "/api/v1/cashbook/balance?$Q"
assert_eq "the Überschuss went with the close: the book's 1 549 again" "$(py "print('%.2f' % d['balance'])")" "1549.00"
AS POST "/api/v1/cashbook/close-day?$Q" '{"date":"2026-10-06","physicalCount":1549}'
assert_status 201 "06.10. closed again, counted exactly"

note "=== 5. the export: the whole book, in order, with the balance ==="
for i in $(seq 1 205); do
  curl -sS -o /dev/null -X POST "$API/api/v1/cashbook/entries?$Q" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"businessDate":"2026-10-07","type":"einnahme","description":"Privateinlage '$i'","amount":1}'
done
TMP=$(mktemp -d)
curl -sS -o "$TMP/k.csv" "$API/api/v1/cashbook/export?$Q&from=2026-10-01&to=2026-10-31" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "216 lines: the header and 215 entries (was 201: 200 at most); the first the opening balance, the last row's Bestand 1 754" \
  "$(python3 -c "
import csv,sys
r=list(csv.reader(open('$TMP/k.csv',encoding='utf-8-sig'),delimiter=';'))
print(len(r), r[1][1], r[-1][-1], r[0][-1])")" "216 Eröffnung 1754,00 Bestand EUR"
assert_eq "the Fehlbetrag's row: the counted 1 130 after it" \
  "$(python3 -c "
import csv
r=list(csv.reader(open('$TMP/k.csv',encoding='utf-8-sig'),delimiter=';'))
print([x[-1] for x in r if x[2]=='Kassenfehlbetrag lt. Kassensturz'])")" "['1130,00']"
rm -rf "$TMP"
summary
