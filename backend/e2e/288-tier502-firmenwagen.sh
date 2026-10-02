#!/bin/bash
# Tier 502 — private use of a company car (1 % rule)
#
# A sole trader whose car is a business asset and also used privately
# withdraws 1 % of its gross list price per month (§ 6 Abs. 1 Nr. 4 EStG;
# electric: 0,25 % / 0,5 %), and owes VAT on 80 % of the 1 % value at 19 %
# (unentgeltliche Wertabgabe, § 3 Abs. 9a UStG — also for an electric car).
# Measured before: none of it existed — POST /company-cars 404, nothing in
# the UStVA, the EÜR, Anlage G, DATEV.
#
# Fixture: a sole trader; a car of 45 678 € (→ 45 600 €) from 15.03.2025,
# an electric car of 60 000 € at 0,25 % from 01.12.2025.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-288-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier502-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"beraterNr":"12345","mandantenNr":"42"}'

note "=== the cars ==="
AS POST "/api/v1/company-cars?companyId=$C" '{"name":"M-AB 123","listPrice":45678,"method":"one_percent","fromDate":"2025-03-15"}'
assert_eq "a car is recorded (was 404)" "$STATUS" "201"
AS POST "/api/v1/company-cars?companyId=$C" '{"name":"M-E 1","listPrice":60000,"method":"electric_025","fromDate":"2025-12-01"}'
assert_eq "an electric car too" "$STATUS" "201"
AS POST "/api/v1/company-cars?companyId=$C" '{"name":"X","listPrice":30000,"method":"one_percent","fromDate":"2025-05-01","untilDate":"2025-04-01"}'
assert_eq "an end before the start: 400" "$STATUS" "400"

note "=== UStVA: the Wertabgabe at 19 % ==="
r19() { P "[(float(r['net']), float(r['vat'])) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9] or [(0.0, 0.0)]"; }
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=2"
assert_eq "February (before the car): nothing" "$(r19)" "[(0.0, 0.0)]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=3"
assert_eq "March (from the 15th — the whole month): 80 % of 456 = 364,80, VAT 69,31" "$(r19)" "[(364.8, 69.31)]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=12"
assert_eq "December: + the electric car on the full 1 % (80 % of 600 = 480, VAT 91,20)" "$(r19)" "[(844.8, 160.51)]"

note "=== EÜR / Anlage G: the withdrawal ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
line() { P "[float(l['amount']) for l in d['einnahmen'] if l['kennziffer']=='$1']"; }
assert_eq "EÜR Private Kfz-Nutzung: 10 × 456 + 150 (0,25 % of 60 000) = 4 710" "$(line 4180)" "[4710.0]"
assert_eq "EÜR USt auf unentgeltliche Wertabgaben: 10 × 69,31 + 91,20 = 784,30" "$(line 4145)" "[784.3]"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2025"
assert_eq "Anlage G 2180: 4 710" "$(P "[float(l['amount']) for l in d['einnahmen'] if l['kennziffer']=='2180']")" "[4710.0]"

note "=== DATEV ==="
curl -sS -o /tmp/t502.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=2025-12-01&endDate=2025-12-31"
D() { python3 - /tmp/t502.csv "$1" <<'PY'
import csv, io, sys
raw = open(sys.argv[1], 'rb').read()
rows = list(csv.reader(io.StringIO(raw.decode('cp1252')), delimiter=';', quotechar='"'))
cols = rows[1]
data = [dict(zip(cols, r)) for r in rows[2:] if r]
def row(text):
    return sorted('%s|%s|%s|%s|%s' % (d['Konto'], d['Gegenkonto (ohne BU-Schlüssel)'], d['Umsatz (ohne Soll/Haben-Kz)'],
        d['Soll/Haben-Kennzeichen'], d['BU-Schlüssel']) for d in data if text in d['Buchungstext'])
print(eval(sys.argv[2]))
PY
}
assert_eq "the car: 1800 an 8921 (364,80 + 69,31, key 3) and 1800 an 8924 (91,20)" \
  "$(D "row('M-AB 123')")" "['1800|8921|434,11|S|3', '1800|8924|91,20|S|']"
assert_eq "the electric car: 1800 an 8921 (480 + 91,20) and 8924 back (150 − 480)" \
  "$(D "row('M-E 1')")" "['1800|8921|571,20|S|3', '1800|8924|330,00|H|']"

note "=== the running year: up to the current month only ==="
AS GET "/api/v1/company-cars/private-use?companyId=$C&year=$(date +%Y)"
assert_eq "the car's months this year: January to now (not the whole year in advance)" \
  "$(P "len([m for m in d['months'] if m['carName']=='M-AB 123'])")" "$((10#$(date +%m)))"

note "=== not for a Kapitalgesellschaft ==="
read -r U2 C2 < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-g@example.test\",\"password\":\"Tier502-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
resp=$(curl -sS -w "\n%{http_code}" -X POST "$API/api/v1/company-cars?companyId=$C2" -H "x-user-id: $U2" -H "x-company-id: $C2" -H "Content-Type: application/json" \
  -d '{"name":"GF","listPrice":50000,"method":"one_percent","fromDate":"2025-01-01"}')
assert_eq "a GmbH's car: 400 (payroll — geldwerter Vorteil)" "$(echo "$resp" | tail -n1)" "400"

summary
