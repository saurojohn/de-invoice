#!/bin/bash
# Tier 504 — the home office (Homeoffice-Pauschale / häusliches Arbeitszimmer)
#
# Since 2023 a sole trader / partner deducts either 6 € per home-office day
# (at most 210 days, § 4 Abs. 5 Nr. 6c EStG) or, for a home office that is
# the centre of the work, 1 260 € a year, a twelfth less per month without
# (Nr. 6b). Measured before: nothing marked it — PUT /home-office/:year 404,
# no line in the EÜR, Anlage S / G, no DATEV booking.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-290-$(date +%s%N | cut -c1-13)"

company() { # name rechtsform
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$2@example.test\",\"password\":\"Tier504-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "{\"rechtsform\":\"$2\"}"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company Beratung Einzelunternehmen
[[ -n "${C:-}" ]] && pass "fixture: a sole trader" || { fail "register"; summary; exit 1; }
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"beraterNr":"12345","mandantenNr":"42"}'

note "=== Tagespauschale ==="
AS PUT "/api/v1/home-office/2025?companyId=$C" '{"method":"tagespauschale","days":230}'
assert_eq "recorded (was 404): 230 days count as 210 × 6 € = 1 260 €" "$STATUS/$(P "float(d['amount'])")" "200/1260.0"
AS PUT "/api/v1/home-office/2025?companyId=$C" '{"method":"tagespauschale"}'
assert_eq "without the days: 400" "$STATUS" "400"
AS PUT "/api/v1/home-office/2025?companyId=$C" '{"method":"tagespauschale","days":120}'
assert_eq "120 days: 720 €" "$(P "float(d['amount'])")" "720.0"
ex() { # report line-key kz
  AS GET "/api/v1/accounting/$1?companyId=$C&year=2025"
  P "[float(l['amount']) for l in d['$2'] if l['kennziffer']=='$3']"
}
assert_eq "EÜR line 5410: 720 (was missing)" "$(ex euer ausgaben 5410)" "[720.0]"
assert_eq "Anlage S line 4645: 720" "$(ex anlage-s ausgaben 4645)" "[720.0]"
assert_eq "Anlage G line 2205: −720" "$(ex anlage-g betriebsausgaben 2205)" "[-720.0]"

note "=== Jahrespauschale ==="
AS PUT "/api/v1/home-office/2025?companyId=$C" '{"method":"jahrespauschale","months":9}'
assert_eq "9 months: 9/12 of 1 260 € = 945 €" "$(P "float(d['amount'])")" "945.0"
assert_eq "EÜR line 5410: 945" "$(ex euer ausgaben 5410)" "[945.0]"
curl -sS -o /tmp/t504.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=2025-01-01&endDate=2025-12-31"
assert_eq "DATEV: 4288 an 1890, 945,00 on 31.12." "$(python3 - /tmp/t504.csv <<'PY'
import csv, io, sys
rows = list(csv.reader(io.StringIO(open(sys.argv[1], 'rb').read().decode('cp1252')), delimiter=';', quotechar='"'))
cols = rows[1]
print([(d['Konto'], d['Gegenkonto (ohne BU-Schlüssel)'], d['Umsatz (ohne Soll/Haben-Kz)'], d['Soll/Haben-Kennzeichen'], d['Belegdatum'])
       for d in (dict(zip(cols, r)) for r in rows[2:] if r) if 'Homeoffice' in d['Buchungstext']])
PY
)" "[('4288', '1890', '945,00', 'S', '3112')]"

note "=== limits ==="
AS PUT "/api/v1/home-office/2022?companyId=$C" '{"method":"jahrespauschale","months":12}'
assert_eq "before 2023 (other rules): 400" "$STATUS" "400"
AS DELETE "/api/v1/home-office/2025?companyId=$C"
assert_eq "deleted: the line is 0 again" "$STATUS/$(ex euer ausgaben 5410)" "200/[0.0]"
company Holding GmbH
AS PUT "/api/v1/home-office/2025?companyId=$C" '{"method":"jahrespauschale","months":12}'
assert_eq "a GmbH: 400 (Werbungskosten of its managing director)" "$STATUS" "400"

summary
