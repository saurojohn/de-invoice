#!/bin/bash
# Tier 665 — Anlage SO: what is entered stays; nothing is counted that is not
# known; nothing is invented.
#
# Before:
#   - A row whose sale was in another year, or had no sale date yet, was
#     saved ("Gespeichert") and then left out of the answer. The form showed
#     it no longer, and its next save deleted it.
#   - A row without an acquisition date counted as sold after its period:
#     tax-free. A sale before its acquisition counted as taxable.
#   - "Aus Ausgaben übernehmen" made a SALE of every expense: sold on the day
#     of the expense for its amount, "acquired" a month earlier for the same
#     amount. The page's checkboxes chose nothing — every expense was taken —
#     and only the categories "crypto" and "brokerage", in exactly this
#     spelling, were found (the page names „Krypto“).
#   - The form's save dropped where a row came from, so the same expense was
#     offered and taken again.
#   - A security whose name contains a crypto word ("Bitcoin ETF") could not
#     be entered as a security: it was read as crypto every time.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-395-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier665-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
SQL() { docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -At -c "$1"; }
Y=2026
tx() { echo "{\"type\":\"$1\",\"description\":\"$2\",\"acquisitionDate\":\"$3\",\"acquisitionCost\":$4,\"saleDate\":\"$5\",\"salePrice\":$6}"; }
put() { AS PUT "/api/v1/accounting/anlage-so/settings?companyId=$C" "{\"year\":$Y,\"transactions\":[$1],\"wiederkehrendeBezuege\":0,\"werbungskosten\":0}"; }
v1() { AS GET "/api/v1/accounting/anlage-so?companyId=$C&year=$Y"; }
v2() { AS GET "/api/v1/accounting/anlage-so/v2?companyId=$C&year=$Y"; }
# what the form does: load, and save what it was given
roundtrip() {
  v1
  local rows
  rows=$(echo "$BODY" | python3 -c "
import sys,json
keep=('type','description','acquisitionDate','acquisitionCost','saleDate','salePrice','metadata')
print(','.join(json.dumps({k:r[k] for k in keep if k in r}) for r in json.load(sys.stdin)['rows']))")
  put "$rows"
}

note "=== 1. the rules themselves ==="
cat > "$SCRIPT_DIR/../.tier665-probe.ts" <<'TS'
import { problemOf, kindOf, splitRows } from './src/modules/accounting/anlage-so-rules'
const t = (acquisitionDate: string, saleDate: string) => ({ acquisitionDate, saleDate })
const out: Array<[string, unknown]> = [
  ['complete', problemOf(t('2026-01-10', '2026-06-10'), 2026)],
  ['sameDay', problemOf(t('2026-06-10', '2026-06-10'), 2026)],
  ['noSale', problemOf(t('2026-01-10', ''), 2026)],
  ['otherYear', problemOf(t('2024-11-01', '2025-03-01'), 2026)],
  ['noAcquisition', problemOf(t('', '2026-05-01'), 2026)],
  ['saleFirst', problemOf(t('2026-08-01', '2026-03-01'), 2026)],
  ['etfChosen', kindOf({ type: 'wertpapier', description: 'Bitcoin ETF', v: 2 })],
  ['etfFromBefore', kindOf({ type: 'wertpapier', description: 'Bitcoin ETF' })],
  ['split', (() => {
    const s = splitRows([
      { type: 'krypto', description: 'a', acquisitionDate: '2026-01-10', acquisitionCost: 1, saleDate: '2026-06-10', salePrice: 2 },
      { type: 'krypto', description: 'b', acquisitionDate: '2026-01-10', acquisitionCost: 1, saleDate: '', salePrice: 0 },
      null, 'x',
    ], 2026)
    return `${s.rows.length}/${s.counted.length}/${s.rows.map((r) => r.status || r.problem).join(',')}`
  })()],
]
for (const [k, v] of out) console.log(`${k}=${v}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier665-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "a complete sale of the year" "$(P complete)" "null"
assert_eq "bought and sold on one day" "$(P sameDay)" "null"
assert_eq "no sale date" "$(P noSale)" "saleDate"
assert_eq "sold in another year" "$(P otherYear)" "otherYear"
assert_eq "no acquisition date" "$(P noAcquisition)" "acquisitionDate"
assert_eq "sold before it was acquired" "$(P saleFirst)" "saleBeforeAcquisition"
assert_eq "a security chosen as one stays one, whatever its name" "$(P etfChosen)" "wertpapier"
assert_eq "… a row from before is read by its name" "$(P etfFromBefore)" "krypto"
assert_eq "every stored row is listed, the complete ones counted" "$(P split)" "2/1/steuerpflichtig,saleDate"

note "=== 2. what is entered stays ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier665-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }

put "$(tx krypto 'BTC' 2026-01-10 1000 2026-06-10 5000),$(tx krypto 'ETH im Vorjahr verkauft' 2024-11-01 1000 2025-03-01 4000),$(tx sonstige 'Gold, noch nicht verkauft' 2026-02-01 2000 '' 0),$(tx krypto 'SOL ohne Anschaffungsdatum' '' 0 2026-05-01 3000),$(tx krypto 'ADA Verkauf vor Kauf' 2026-08-01 1000 2026-03-01 2500)"
assert_eq "five rows saved" "$STATUS|$(field "len(d['transactions'])")" "200|5"
v1
assert_eq "all five come back (were: three — two had gone)" "$(field "len(d['rows'])")" "5"
assert_eq "… each with what it counts as, or why it does not" \
  "$(field "','.join(r['status'] or r['problem'] for r in d['rows'])")" "steuerpflichtig,otherYear,saleDate,acquisitionDate,saleBeforeAcquisition"
assert_eq "one is counted, four are not" "$(field "(d['vg']['count'], d['vg']['countNotCounted'])")" "(1, 4)"
assert_eq "the taxable gain is the one complete sale's (was 5 500: the sale before its acquisition counted)" \
  "$(field "(d['vg']['taxableGain'], d['totals']['vgTotal'], d['vg']['inSpekulationsfrist'])")" "(4000, 4000, 1)"
v2
assert_eq "the adviser's package: the same, and nothing tax-free without an acquisition date (was 1)" \
  "$(field "(d['vg']['count'], d['vg']['countNotCounted'], d['vg']['vgTotal'], d['vg']['outOfFristCount'], len(d['rows']))")" "(1, 4, 4000, 0, 5)"

roundtrip
assert_eq "the form saves what it was given" "$STATUS" "200"
v1; assert_eq "… and the five rows are still there (were: one)" "$(field "len(d['rows'])")" "5"

curl -sS -o "$TMP/so.pdf" "$API/api/v1/accounting/anlage-so.pdf?companyId=$C&year=$Y" -H "x-user-id: $U" -H "x-company-id: $C"
pdf_contains "nicht angesetzt: Ver" "$TMP/so.pdf" && pdf_contains "Anlage SO 2025" "$TMP/so.pdf" \
  && pass "the PDF lists the rows that are not counted, with the reason" || fail "the PDF does not name the rows that are not counted"

put "$(tx wertpapier 'Bitcoin ETF' 2026-01-10 1000 2026-07-10 6000)"
v1; assert_eq "a „Bitcoin ETF“ entered as a security is one (was read as crypto: 5 000 € taxable)" \
  "$(field "(d['rows'][0]['type'], d['rows'][0]['status'], d['vg']['countKap'], d['totals']['vgTotal'])")" "('wertpapier', 'kap', 1, 0)"
roundtrip; v1
assert_eq "… and stays one through the form's save" "$(field "d['rows'][0]['type']")" "wertpapier"

put '{"type":"krypto","description":"","acquisitionDate":"","acquisitionCost":0,"saleDate":"","salePrice":0}'
v1; assert_eq "a row with nothing in it is not kept" "$STATUS|$(field "len(d['rows'])")" "200|0"

note "=== 3. from the expenses: the acquisition, and only what was chosen ==="
exp() { # number description date gross category
  SQL "INSERT INTO \"Expense\" (id, \"companyId\", \"invoiceNumber\", description, \"invoiceDate\", \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\", category, \"isIntraEU\", \"isReverseCharge\", status, \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid(), '$C', '$1', '$2', '$3 00:00:00+00', $4, 0, 0, $4, '$5', false, false, 'booked', NOW(), NOW()) RETURNING id" | head -1
}
E1=$(exp T665-1 'BTC Kauf' 2026-03-15 5000 Krypto)
E2=$(exp T665-2 'ETH Kauf' 2025-06-10 3000 crypto)
E3=$(exp T665-3 'Fonds Kauf' 2026-09-20 8000 Wertpapiere)
E4=$(exp T665-4 'Druckerpapier' 2026-04-01 40 Büromaterial)
E5=$(exp T665-5 'BTC Kauf im Folgejahr' 2027-01-05 900 Krypto)
[[ -n "$E1" && -n "$E5" ]] && pass "fixture: five expenses" || { fail "expenses"; summary; exit 1; }

AS GET "/api/v1/accounting/anlage-so/importable-expenses?companyId=$C&year=$Y"
assert_eq "offered: „Krypto“, „crypto“ of the year before, „Wertpapiere“ — not the paper, not next year's (were: none, the spelling was not „crypto“)" \
  "$(field "sorted(i['invoiceNumber'] for i in d['items'])")" "['T665-1', 'T665-2', 'T665-3']"

AS POST "/api/v1/accounting/anlage-so/import-from-expenses?companyId=$C&year=$Y" "{\"ids\":[\"$E1\"]}"
assert_eq "one chosen, one taken (were: all)" "$STATUS|$(field "(d['importedCount'], d['skippedCount'], len(d['transactions']))")" "201|(1, 0, 1)"
v1
assert_eq "the expense is the acquisition: its date, its amount; no sale (was: sold that day for 5 000, „acquired“ 15.02.)" \
  "$(field "(d['rows'][0]['type'], d['rows'][0]['acquisitionDate'], d['rows'][0]['acquisitionCost'], d['rows'][0]['saleDate'], d['rows'][0]['salePrice'])")" "('krypto', '2026-03-15', 5000, '', 0)"
assert_eq "… not counted until its sale is entered" "$(field "(d['rows'][0]['problem'], d['vg']['count'], d['vg']['countNotCounted'])")" "('saleDate', 0, 1)"

AS POST "/api/v1/accounting/anlage-so/import-from-expenses?companyId=$C&year=$Y" "{\"ids\":[\"$E1\",\"$E4\",\"$E5\"]}"
assert_eq "the same again, the paper and next year's purchase: nothing taken" "$(field "(d['importedCount'], d['skippedCount'], len(d['transactions']))")" "(0, 1, 1)"

# the user enters the sale and saves the form
v1
ROW=$(echo "$BODY" | python3 -c "
import sys,json
r=json.load(sys.stdin)['rows'][0]
r={k:r[k] for k in ('type','description','acquisitionDate','acquisitionCost','saleDate','salePrice','metadata')}
r['saleDate']='2026-11-02'; r['salePrice']=9000
print(json.dumps(r))")
put "$ROW"
assert_eq "the sale entered and saved" "$STATUS" "200"
v1; assert_eq "… 4 000 € gain within the year" "$(field "(d['rows'][0]['status'], d['totals']['vgTotal'])")" "('steuerpflichtig', 4000)"
AS GET "/api/v1/accounting/anlage-so/importable-expenses?companyId=$C&year=$Y"
assert_eq "the expense is still known as taken (the form's save forgot it)" \
  "$(field "[i['alreadyImported'] for i in d['items'] if i['invoiceNumber'] == 'T665-1']")" "[True]"

AS POST "/api/v1/accounting/anlage-so/import-from-expenses?companyId=$C&year=$Y" "{}"
assert_eq "without a choice: the two others; the first is not taken twice" "$(field "(d['importedCount'], d['skippedCount'], len(d['transactions']))")" "(2, 1, 3)"
v1; assert_eq "the fund is a security, bought 20.09.; the ETH was bought the year before" \
  "$(field "sorted((r['type'], r['acquisitionDate'], r['problem']) for r in d['rows'] if r['problem'])")" "[('krypto', '2025-06-10', 'saleDate'), ('wertpapier', '2026-09-20', 'saleDate')]"

# taken into this year's list — not offered as new in the next
AS GET "/api/v1/accounting/anlage-so/importable-expenses?companyId=$C&year=2027"
assert_eq "next year: the purchase of January 2027 is new, the three are known as taken" \
  "$(field "sorted((i['invoiceNumber'], i['alreadyImported']) for i in d['items'])")" "[('T665-1', True), ('T665-2', True), ('T665-3', True), ('T665-5', False)]"

AS POST "/api/v1/accounting/anlage-so/import-from-expenses?companyId=$C&year=$Y" '{"ids":"alle"}'
assert_eq "a choice that is no list is refused" "$STATUS" "400"

note "=== 4. the CSV: a sale of another year ==="
CSV='type,description,acquisitionDate,acquisitionCost,saleDate,salePrice
krypto,DOT dieses Jahr,10.01.2026,"1000,00",10.04.2026,"1500,00"
krypto,DOT Vorjahr,10.01.2025,"1000,00",10.04.2025,"1500,00"'
BODYJSON=$(python3 -c "import json,sys; print(json.dumps({'companyId':sys.argv[1],'year':2026,'csv':sys.argv[2],'previewOnly':True}))" "$C" "$CSV")
AS POST "/api/v1/accounting/anlage-so/import-csv" "$BODYJSON"
assert_eq "the preview: one row fits, the other is named as last year's" \
  "$(field "(d['okCount'], [p['ok'] for p in d['preview']], any('Anlage SO 2025' in w for w in d['preview'][1]['warnings']))")" "(1, [True, False], True)"
BODYJSON=$(python3 -c "import json,sys; print(json.dumps({'companyId':sys.argv[1],'year':2026,'csv':sys.argv[2],'previewOnly':False}))" "$C" "$CSV")
AS POST "/api/v1/accounting/anlage-so/import-csv" "$BODYJSON"
assert_eq "the import takes the one (was: both — the other counted nowhere)" "$(field "d['importedCount']")" "1"

note "=== 5. on the page ==="
FE="$SCRIPT_DIR/../../frontend"
SEC="$FE/src/app/dashboard/accounting/AnlageSOSection.tsx"
grep -q 'rowsFromTransactions(result.rows' "$SEC" && pass "the form loads every stored row" || fail "the form loads the counted rows only"
grep -q 'ids ? { ids } : {}' "$SEC" && pass "the form sends the expenses chosen" || fail "the form sends no choice"
grep -q 'metadata: r.metadata' "$SEC" && pass "the form keeps where a row came from" || fail "the form drops a row's origin"
for lang in de en zh; do
  python3 - "$FE/messages/$lang.json" <<'PY' && pass "the texts of the new column: $lang" || fail "texts missing: $lang"
import json,sys
a=json.load(open(sys.argv[1],encoding='utf-8'))['anlageSo']
need=['status','statusTaxable','statusFree','statusKap','statusUnsaved','problemSaleDate','problemAcquisitionDate','problemOtherYear','problemSaleBeforeAcquisition','notCounted']
sys.exit(0 if all(a.get(k) for k in need) and '{year}' in a['problemOtherYear'] and '{n}' in a['notCounted'] else 1)
PY
done

summary
