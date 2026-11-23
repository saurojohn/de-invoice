#!/bin/bash
# Tier 945 — the dashboard's open payables and the year's result
#
# Open payables were every bill of status 'booked', paid or not, and never a
# 'deductible' one; the balance sheet counts the unpaid booked / deductible
# bills. The year's result left out the Restbuchwert of an asset sold or
# retired — a cost in the GuV, the EÜR and the BWA.
# Measured before (dated today): a bill paid on its day 238 €, one open 119 €,
# a 'deductible' one open 59,50 € → dashboard 357 €, balance sheet 178,50 €; a
# machine of 6 000 € bought on 1 January and retired today → GuV −6 000 €,
# dashboard −1 100 € (its AfA only).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-632-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
DE_TODAY="${TODAY:8:2}.${TODAY:5:2}.${TODAY:0:4}"

company() { # name gewinnermittlung
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier945-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "{\"rechtsform\":\"Einzelunternehmen\",\"besteuerungsart\":\"soll\",\"gewinnermittlung\":\"$2\"}"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }

note "=== open payables ==="
company Rechnungen euer
[[ -n "${C:-}" ]] && pass "fixture: a sole trader" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"Büro\",\"invoiceDate\":\"$TODAY\",\"paidAt\":\"$TODAY\",\"netAmount\":200,\"vatRate\":0.19,\"vatAmount\":38,\"grossAmount\":238}"
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"Miete\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
AS POST "/api/v1/expenses/import?companyId=$C" "{\"rows\":[{\"description\":\"Wartung\",\"invoiceDate\":\"$DE_TODAY\",\"invoiceNumber\":\"D-1\",\"supplierName\":\"$TAG Service GmbH\",\"netAmount\":\"50\",\"vatRate\":\"0.19\",\"vatAmount\":\"9.5\",\"grossAmount\":\"59.5\",\"status\":\"deductible\"}]}"
assert_eq "three bills: paid 238, open 119, open 'deductible' 59,50" "$STATUS/$(P "d['imported']")" "201/1"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
LUL=$(P "[l['amount'] for g in d['passiva'] for l in g['lines'] if 'Lieferungen' in l['label']][0]")
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "dashboard: 119 + 59,50 open, as the balance sheet (was 357 — the paid bill in, the deductible one out)" \
  "$(P "float(d['openPayables'])")/$LUL" "178.5/178.5"

note "=== the year's result ==="
company Anlage bilanz
AS POST "/api/v1/assets?companyId=$C" "{\"type\":\"Maschine\",\"bezeichnung\":\"Maschine\",\"anschaffungsDatum\":\"$Y-01-01\",\"anschaffungsKosten\":6000,\"nutzungsdauerMonate\":60}"
A=$(json_field "$BODY" id)
AS POST "/api/v1/assets/$A/dispose?companyId=$C" "{\"verkauftAm\":\"$TODAY\",\"verkaufsPreis\":0}"
assert_eq "a machine of 6 000 € bought on 1 January, retired today" "$STATUS" "201"
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
JUE=$(P "float(d['totals']['jahresueberschuss'])")
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "dashboard: its AfA and its Restbuchwert, as the GuV (was the AfA only)" "$(P "float(d['ytd']['net'])")/$JUE" "-6000.0/-6000.0"

summary
