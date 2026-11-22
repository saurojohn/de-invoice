#!/bin/bash
# Tier 916 — Anlage G of a balance-sheet sole trader by the year of the supply
#
# Tier 913 put a GmbH's revenue into the year of its supply (GuV, Bilanz —
# § 252 Abs. 1 Nr. 4 HGB). The Anlage G of a sole trader who keeps books
# (§ 5 EStG, the same rule) still read the issue date. Measured: a supply of
# 15.12. last year, invoiced this year — GuV and Bilanz last year 1 000 / a
# claim of 1 190, Anlage G last year 0 and this year 1 000.
# The Übergangsgewinn of a change to the Bilanz (Tier 915) counts such a
# supply among the receivables open at the change.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-604-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; LY=$((Y - 1))
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company() { # suffix method
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier916-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"rechtsform\":\"Einzelunternehmen\",\"gewinnermittlung\":\"$2\",\"besteuerungsart\":\"soll\"}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 604","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
  K=$(json_field "$BODY" id)
  # supplied on 15.12. last year, invoiced today (1 000 net), unpaid
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"deliveryDate\":\"$LY-12-15\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
}
einnahmen() { AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$1"; P "f\"{d['totals']['einnahmenTotal']:g}\""; }

note "=== a sole trader who keeps books ==="
company a bilanz
[[ -n "${C:-}" ]] && pass "fixture: a supply of 15.12.$LY invoiced today" || { fail "register"; summary; exit 1; }
AS GET "/api/v1/accounting/guv?companyId=$C&year=$LY"
assert_eq "GuV $LY: 1 000" "$(P "d['totals']['umsatzerloese']")" "1000"
assert_eq "Anlage G $LY: 1 000 too (was 0)" "$(einnahmen $LY)" "1000"
assert_eq "Anlage G $Y: 0 (was 1 000)" "$(einnahmen $Y)" "0"

note "=== a change from the EÜR to the Bilanz this year ==="
company b euer
AS PUT "/api/v1/companies/$C?companyId=$C" '{"gewinnermittlung":"bilanz"}'
assert_eq "the change from $Y" "$STATUS" "200"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
assert_eq "the supply of $LY is a receivable open at the change (was not)" "$(P "d['uebergang']['forderungen']")" "1190"
assert_eq "$Y: the Übergangsgewinn 1 190 − 190 VAT owed = 1 000, the supply counted once" "$(P "f\"{d['totals']['gewinnVorKorrektur']:g}\"")" "1000"

summary
