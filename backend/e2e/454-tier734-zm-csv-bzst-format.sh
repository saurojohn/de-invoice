#!/bin/bash
# Tier 734 — the ZM's CSV in the format the BZSt form imports
#
# The import of the Zusammenfassende Meldung (Mein ELSTER, BZSt form „ZM",
# help page „zmdo_import", CSV-Version 3.0 / Excel 3.2.1; the 2015 guide
# „CSV-Format der Import-Datei ZM" for the rules it kept):
#   #v3.0
#   #ve3.2.1
#   Umsatzsteuer-Identifikationsnummer (USt-IdNr.),Summe (Euro),Art der Leistung
#   FRWL247100014,12345678911,L
# — the version lines first (a file without them is refused), the USt-IdNr.
# with its country prefix in ONE column (version 2.0 joined them), the sum a
# whole number, L / D / S; UTF-8; no empty line; at most 1 500 lines; lines
# equal but for the amount refused; the USt-IdNr. mandatory, 7+ characters.
#
# Tier 491 wrote "Laenderkennzeichen;USt-IdNr;Betrag(EUR);Art der Leistung"
# and „FR;12345678901;1500;L" — no version line, four columns: refused, and
# read as version 3.0 the amount stood under „Art der Leistung". A line of a
# customer without a valid USt-IdNr. went into the file (refused there too),
# and a sale of 0,40 € became a line of 0.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-454-$(date +%s%N | cut -c1-13)"
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier734-e2e\",\"companyName\":\"$TAG Handel\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE811111111
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
customer() { # name vatId country
  local body="{\"name\":\"$TAG $1\",\"type\":\"business\",\"vatId\":\"$2\",\"address\":{\"street\":\"Rue 1\",\"postalCode\":\"1010\",\"city\":\"Stadt\",\"country\":\"$3\"}}"
  AS POST "/api/v1/customers?companyId=$C" "$body"; json_field "$BODY" id
}
inv() { # customer flagjson net date
  local body="{\"customerId\":\"$1\",\"issueDate\":\"$4\",$2\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$3,\"vatRate\":0}]}"
  AS POST "/api/v1/invoices?companyId=$C" "$body"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
FR=$(customer FR "FR12345678901" FR); GR=$(customer GR "EL123456789" GR)
AT=$(customer AT "ATU12345678" AT); ES=$(customer ES "ESX1234567X" ES)
inv "$FR" '"euTransaction":true,' 1500 2026-07-10 >/dev/null
inv "$FR" '"reverseCharge":true,' 250.60 2026-07-11 >/dev/null
inv "$GR" '"euTransaction":true,' 800 2026-08-05 >/dev/null
inv "$AT" '"euTransaction":true,' 300 2026-09-01 >/dev/null
inv "$ES" '"euTransaction":true,' 0.40 2026-09-02 >/dev/null
# a number the customer list holds from before Tier 490's check
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "update \"Customer\" set \"vatId\"='ATU1' where id='$AT'" >/dev/null

AS GET "/api/v1/ustva/zm?companyId=$C&year=2026&quarter=3"
assert_eq "the preview: every line, the malformed number marked, the 0,40 € line not there (was: a line of 0)" \
  "$(P "[(r['land']+r['ustIdNr'], r['art'], r['betrag'], r['meldefaehig']) for r in d['rows']]")" \
  "[('ATU1', 'L', 300, False), ('EL123456789', 'L', 800, True), ('FR12345678901', 'L', 1500, True), ('FR12345678901', 'S', 251, True)]"
assert_eq "…and says why ATU1 is not in the file" "$(P "sum('ATU1' in h and 'nicht in der CSV' in h for h in d['hinweise'])")" "1"
assert_eq "…the disclaimer names the import format" "$(P "'CSV-Version 3.0' in d['disclaimer']")" "True"

curl -sS -o /tmp/t454.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/ustva/zm.csv?companyId=$C&year=2026&quarter=3"
CSV=$(python3 - /tmp/t454.csv <<'PY'
import re, sys
raw = open(sys.argv[1], 'rb').read()
print('ascii' if all(b < 128 for b in raw) else 'not ascii')
print('crlf' if raw.endswith(b'\r\n') and raw.count(b'\n') == raw.count(b'\r\n') else 'other line ends')
lines = raw.decode('utf-8').split('\r\n')[:-1]
print('no empty line' if all(l != '' for l in lines) else 'an empty line')
print(lines[0]); print(lines[1]); print(lines[2])
data = lines[3:]
print('|'.join(data))
ok = [bool(re.fullmatch(r'[A-Z]{2}[A-Z0-9+*]{5,12},-?\d{1,11},[LDS]', l)) for l in data]
print('every line: USt-IdNr. with prefix, a whole number, L/D/S' if all(ok) and data else 'a line out of format')
keys = [l.split(',')[0] + l.split(',')[2] for l in data]
print('no two lines equal but for the amount' if len(keys) == len(set(keys)) else 'duplicate lines')
PY
)
line() { sed -n "${1}p" <<<"$CSV"; }
assert_eq "the version line first (was: none — refused)" "$(line 4)" "#v3.0"
assert_eq "…the Excel version line" "$(line 5)" "#ve3.2.1"
assert_eq "the header line of version 3.0 (was: Laenderkennzeichen;USt-IdNr;Betrag(EUR);Art der Leistung)" "$(line 6)" \
  "Umsatzsteuer-Identifikationsnummer (USt-IdNr.),Summe (Euro),Art der Leistung"
assert_eq "three columns, the prefix in the number, comma, whole euros; the GR customer as EL; ATU1 left out (was: AT;U1;300;L)" "$(line 7)" \
  "EL123456789,800,L|FR12345678901,1500,L|FR12345678901,251,S"
assert_eq "…every line in the import's format" "$(line 8)" "every line: USt-IdNr. with prefix, a whole number, L/D/S"
assert_eq "…none twice" "$(line 9)" "no two lines equal but for the amount"
assert_eq "plain characters, CRLF, no empty line" "$(line 1)/$(line 2)/$(line 3)" "ascii/crlf/no empty line"

AS GET "/api/v1/ustva/zm?companyId=$C&year=2026&quarter=2"
assert_eq "a quarter without such sales: no lines" "$(P "len(d['rows'])")" "0"
curl -sS -o /tmp/t454e.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/ustva/zm.csv?companyId=$C&year=2026&quarter=2"
assert_eq "…its file: the version and header lines only" "$(tr -d '\r' < /tmp/t454e.csv | wc -l | tr -d ' ')" "3"

summary
