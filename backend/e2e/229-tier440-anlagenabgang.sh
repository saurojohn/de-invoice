#!/bin/bash
# Tier 440 — an asset that is sold or scrapped leaves with its book value
#
# Measured before, two machines (6 000 € each, 60 months, bought January 2025,
# AfA 2025 booked), both sold on 5 June 2026 (book value 4 200 € each):
#   - the sale booked nothing: GuV 2026 showed the AfA and no Restbuchwert,
#     the balance sheet lost the machines — 8 400 € gone without an expense
#   - machine B, with its AfA 2026 booked in full (1 200 €) before the sale,
#     could still be sold and kept 1 200 € of AfA for six months (600 €)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-229-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier440-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
machine() {
  AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"'$1'","anschaffungsDatum":"2025-01-10","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
  json_field "$BODY" id
}
sell() { AS POST "/api/v1/assets/$1/dispose?companyId=$C" '{"verkauftAm":"2026-06-05","verkaufsPreis":3000}'; }

A=$(machine Fräse); B=$(machine Presse)
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2025"
assert_eq "AfA 2025: 2 x 1200" "$(py 'print(d["totalAnnualAfA"])')" "2400"

note "=== A: sold, then AfA 2026 booked ==="
sell "$A"
assert_eq "A sold" "$STATUS" "201"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2026"
assert_eq "AfA 2026: A 600 (to June) + B 1200" "$(py 'print(d["totalAnnualAfA"])')" "1800"

note "=== B: AfA 2026 booked in full, then sold ==="
sell "$B"
assert_eq "refused: 1200 booked, 600 due (was 201)" "$STATUS" "400"
echo "$BODY" | grep -q "Stornieren Sie zuerst die AfA 2026" && pass "the message says what to do" || fail "message: $BODY"

note "=== 2026 with A gone: AfA 1800 + Restbuchwert 4200 (6000 - 1200 - 600) ==="
AS GET "/api/v1/accounting/guv?companyId=$C&year=2026"
assert_eq "GuV 8 sonstige Aufwendungen: the Restbuchwert (was 0)" "$(py 'print([l["amount"] for l in d["cost"]["lines"] if l["position"]=="8"][0])')" "4200"
assert_eq "GuV Jahresüberschuss (was -1800)" "$(py 'print(d["totals"]["jahresueberschuss"])')" "-6000"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 4610 Restbuchwert (was: no line)" "$(py 'print([l["amount"] for l in d["ausgaben"] if l["kennziffer"]=="4610"][0])')" "4200"
assert_eq "EÜR Gewinn" "$(py 'print(d["totals"]["gewinn"])')" "-6000"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2026"
assert_eq "Anlage S Gewinn" "$(py 'print(d["totals"]["gewinn"])')" "-6000"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2026"
assert_eq "Anlage G Gewinn" "$(py 'print(d["totals"]["gewinnVorKorrektur"])')" "-6000"
AS GET "/api/v1/reports/bwa?companyId=$C&year=2026&month=12"
assert_eq "BWA Jahresergebnis" "$(py 'print(d["totals"]["jahresergebnisYtd"])')" "-6000"
AS GET "/api/v1/reports/pnl?companyId=$C&year=2026"
assert_eq "P&L expenses" "$(py 'print(round(d["ytd"]["materialExpenses"]+d["ytd"]["otherExpenses"],2))')" "6000"
curl -sS -o /tmp/t440.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-01-01&endDate=2026-12-31"
assert_eq "DATEV: Anlagenabgang 2310 an 0210 Maschinen, 4200 S, 05.06." \
  "$(datev_rows /tmp/t440.csv | awk -F'\t' '$1 ~ /^ABG-/ {print $3":"$4":"$5":"$6":"$9}')" "2310:0210:4200.00:S:0506"
assert_eq "DATEV 2026: 0210 credited with the AfA (1800) and the Restbuchwert (4200)" \
  "$(datev_balance /tmp/t440.csv 0210)" "-6000.00"

note "=== B the right way: storno AfA 2026, sell, book again ==="
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=2026"
sell "$B"
assert_eq "B sold after the storno" "$STATUS" "201"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2026"
assert_eq "AfA 2026 rebooked: 600 + 600" "$(py 'print(d["totalAnnualAfA"])')" "1200"
AS GET "/api/v1/accounting/guv?companyId=$C&year=2026"
assert_eq "GuV: AfA 1200 + Restbuchwert 2 x 4200" "$(py 'print(d["totals"]["jahresueberschuss"])')" "-9600"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2026"
assert_eq "Bilanz: no fixed assets left" "$(py 'print(d["aktiva"][0]["subtotal"])')" "0"

summary
