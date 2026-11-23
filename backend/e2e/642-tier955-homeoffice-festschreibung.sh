#!/bin/bash
# Tier 955 — the home office and the closed books
#
# The home-office Pauschale is a cost of its year (EÜR Zeile 5410, Tier 504).
# After the books were closed to 31.12.2025 the 2025 Pauschale could be set,
# changed or deleted — the closed EÜR 2025 changed with it (230 days: 1 260 €).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-642-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier955-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
costs() { AS GET "/api/v1/accounting/euer?companyId=$C&year=$1"; P "float(d['totals']['ausgabenTotal'])"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"euer"}'
AS PUT "/api/v1/home-office/2025?companyId=$C" '{"method":"tagespauschale","days":100}'
assert_eq "2025: 100 home-office days" "$STATUS" "200"
BEFORE=$(costs 2025)
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2025-12-31"}'
assert_eq "the books closed to 31.12.2025" "$STATUS" "200"

AS PUT "/api/v1/home-office/2025?companyId=$C" '{"method":"tagespauschale","days":230}'
assert_eq "2025 changed to 230 days: refused (was 200)" "$STATUS/$(P "'Festschreibung' in str(d.get('message'))")" "400/True"
AS DELETE "/api/v1/home-office/2025?companyId=$C"
assert_eq "2025 deleted: refused (was 200)" "$STATUS" "400"
assert_eq "the closed EÜR 2025 unchanged" "$(costs 2025)" "$BEFORE"
AS PUT "/api/v1/home-office/2026?companyId=$C" '{"method":"tagespauschale","days":50}'
assert_eq "2026 (open): taken" "$STATUS" "200"

summary
