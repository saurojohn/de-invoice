#!/bin/bash
# Tier 967 — the DATEV preview and AfA not booked
#
# The Buchungsstapel carries the AfA only once „AfA buchen“ booked it; GuV,
# balance sheet and EÜR take the computed AfA. Measured: a laptop of 3 000 €
# in the register, AfA not booked — DATEV's result 2 400 €, the GuV
# 1 483,33 €; the preview said nothing. It warns now.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-654-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier967-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a sole trader with a balance sheet" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","gewinnermittlung":"bilanz"}'
AS POST "/api/v1/assets?companyId=$C" '{"type":"Betriebsausstattung","bezeichnung":"Laptop","anschaffungsDatum":"2025-01-01","anschaffungsKosten":3000,"nutzungsdauerMonate":36}'
afa() { AS GET "/api/v1/reports/datev-preview?companyId=$C&startDate=$1&endDate=$2"; P "[i['message'].split(' — ')[0] for i in d['issues'] if i['message'].startswith('AfA')]"; }
assert_eq "the 2025 preview: AfA not booked, 1 000 € (was no word)" "$(afa 2025-01-01 2025-12-31)" "['AfA 2025 nicht gebucht: 1000,00 €']"
assert_eq "…a preview of March 2025 does not end the year: no warning" "$(afa 2025-03-01 2025-03-31)" "[]"
AS POST "/api/v1/assets/book-afa?companyId=$C&year=2025"
assert_eq "„AfA buchen“ 2025" "${STATUS:0:2}" "20"
assert_eq "…the warning is gone" "$(afa 2025-01-01 2025-12-31)" "[]"

summary
