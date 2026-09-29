#!/bin/bash
# Tier 467 — the default Sachkonten are SKR03 accounts
#
# Measured before: `GET /accounting/accounts/seed` created 1000, 1200, 1400,
# "1600 Vorsteuer", "1800 Sonstige Vermögensgegenstände", "2000 Verbindlich-
# keiten", "2200 Umsatzsteuer", "2800 Erhaltene Anzahlungen", "4200 Umsatz-
# erlöse 19%", "4300 Umsatzerlöse 7%", "4400 Wareneinsatz", 4980, "6000
# Aufwendungen für Waren", "8000 Sonstige Erträge" — an invented numbering. A
# manual voucher Bank 119 an "Umsatzerlöse 19%" 100 / "Umsatzsteuer" 19 went to
# DATEV as 1200 an 4200 (SKR03: Raumkosten) and 1200 an 2200 (SKR03:
# Körperschaftsteuer).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-255-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier467-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
accounts() { AS GET "/api/v1/accounting/accounts?companyId=$C"; echo "$BODY" > /tmp/t467-acc.json; }
acc() { python3 -c "import json;d=json.load(open('/tmp/t467-acc.json'));d=d if isinstance(d,list) else d.get('data',d);print(*[a['$2'] for a in d if a['accountNumber']=='$1'])"; }

AS GET "/api/v1/accounting/accounts/seed?companyId=$C"
accounts
assert_eq "SKR03 numbers (was 1000 1200 1400 1600 1800 2000 2200 2800 4200 4300 4400 4980 6000 8000)" \
  "$(python3 -c "import json;d=json.load(open('/tmp/t467-acc.json'));d=d if isinstance(d,list) else d.get('data',d);print(' '.join(sorted(a['accountNumber'] for a in d)))")" \
  "1000 1200 1400 1571 1576 1600 1710 1771 1776 1800 1890 2700 3200 4900 4980 8200"
assert_eq "1600 is Verbindlichkeiten L+L (was Vorsteuer)" "$(acc 1600 name)" "Verbindlichkeiten aus Lieferungen und Leistungen"
assert_eq "1800 is Privatentnahmen (was Sonstige Vermögensgegenstände)" "$(acc 1800 name)" "Privatentnahmen allgemein"
assert_eq "Vorsteuer 19 % on 1576" "$(acc 1576 name)" "Abziehbare Vorsteuer 19 %"
AS GET "/api/v1/accounting/accounts/seed?companyId=$C"
accounts
assert_eq "seeding again adds nothing" \
  "$(python3 -c "import json;d=json.load(open('/tmp/t467-acc.json'));d=d if isinstance(d,list) else d.get('data',d);print(len(d))")" "16"

note "=== a manual voucher reaches DATEV on the right accounts ==="
AS POST "/api/v1/accounting/vouchers" '{"companyId":"'$C'","date":"2026-06-15","description":"Barverkauf lt. Beleg","referenceType":"Manual","lines":[{"accountId":"'"$(acc 1200 id)"'","debit":119,"credit":0},{"accountId":"'"$(acc 8200 id)"'","debit":0,"credit":100},{"accountId":"'"$(acc 1776 id)"'","debit":0,"credit":19}]}'
assert_eq "voucher Bank an Erlöse / Umsatzsteuer" "$STATUS" "201"
curl -sS -o /tmp/t467.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-06-01&endDate=2026-06-30"
assert_eq "DATEV: 1200 an 8200 Erlöse and 1776 USt 19 % (was 4200 Raumkosten, 2200 KSt)" \
  "$(datev_rows /tmp/t467.csv | awk -F'\t' '{print $3"/"$4"/"$5}' | sort | tr '\n' ' ')" "1200/1776/19.00 1200/8200/100.00 "

note "=== a line without an account ==="
AS POST "/api/v1/accounting/vouchers" '{"companyId":"'$C'","date":"2026-06-16","description":"Porto","referenceType":"Manual","lines":[{"accountId":"'"$(acc 1200 id)"'","debit":0,"credit":5},{"accountId":"","description":"Porto","debit":5,"credit":0}]}'
assert_eq "an empty accountId means none yet, like null (was 500 Related resource not found)" "$STATUS" "201"

summary
