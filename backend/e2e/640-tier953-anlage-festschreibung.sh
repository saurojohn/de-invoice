#!/bin/bash
# Tier 953 — the fixed assets and the closed books
#
# The AfA of an asset from its year of purchase on, and its Restbuchwert on
# the day it leaves, are in those years' EÜR / GuV. Only the AfA bookings met
# the closing. Measured (books closed to 31.12.2025, a machine of 6 000 €
# bought 01.03.2025 — EÜR 2025 costs 1 000 €): its purchase price doubled →
# 2 000 €; a drill bought 01.06.2025 entered → 2 583,33 €; the drill disposed
# of on 15.12.2025 → 5 000 € — all after the closing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-640-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier953-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a sole trader (EÜR)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
costs() { AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"; P "float(d['totals']['ausgabenTotal'])"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"euer"}'
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Fräse","anschaffungsDatum":"2025-03-01","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
A=$(json_field "$BODY" id)
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Säge","anschaffungsDatum":"2026-02-01","anschaffungsKosten":1200,"nutzungsdauerMonate":36}'
OPEN=$(json_field "$BODY" id)
assert_eq "EÜR 2025: the machine's AfA, 10 months" "$(costs)" "1000.0"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2025-12-31"}'
assert_eq "the books closed to 31.12.2025" "$STATUS" "200"

AS PATCH "/api/v1/assets/$A?companyId=$C" '{"anschaffungsKosten":12000}'
assert_eq "its purchase price: refused (was taken — AfA 2025 doubled)" "$STATUS/$(P "'Festschreibung' in str(d.get('message'))")" "400/True"
AS PATCH "/api/v1/assets/$A?companyId=$C" '{"bezeichnung":"CNC-Fräse","notiz":"Halle 2"}'
assert_eq "…its name and note are free" "$STATUS" "200"
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Bohrer","anschaffungsDatum":"2025-06-01","anschaffungsKosten":3000,"nutzungsdauerMonate":36}'
assert_eq "an asset bought in 2025 entered now: refused" "$STATUS" "400"
AS POST "/api/v1/assets/$A/dispose?companyId=$C" '{"verkauftAm":"2025-12-15","verkaufsPreis":0}'
assert_eq "disposed of on 15.12.2025: refused" "$STATUS" "400"
assert_eq "the closed EÜR 2025 unchanged" "$(costs)" "1000.0"

AS PATCH "/api/v1/assets/$OPEN?companyId=$C" '{"anschaffungsKosten":1500}'
assert_eq "an asset of the open year changes as before" "$STATUS" "200"

summary
