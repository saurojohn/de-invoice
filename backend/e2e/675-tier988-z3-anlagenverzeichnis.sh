#!/bin/bash
# Tier 988 — the Z3 data set carries the Anlagenverzeichnis
#
# A laptop bought for 3 000 € (36 months) gave the EÜR 1 000 € AfA for the
# year; the GoBD export's Datenüberlassung listed ten tables and no file of
# the archive named the laptop — the AfA claimed could not be traced (§ 147
# Abs. 6 AO, GoBD Rz. 158 ff.; the register: § 4 Abs. 3 Satz 5 EStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-675-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
Y=$(TZ=Europe/Berlin date +%Y)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier988-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/assets?companyId=$C" "{\"type\":\"Maschine\",\"bezeichnung\":\"Laptop $TAG\",\"anschaffungsDatum\":\"$Y-01-01\",\"anschaffungsKosten\":3000,\"nutzungsdauerMonate\":36}"
assert_eq "fixture: a laptop, 3 000 €, 36 months, from 01.01." "$STATUS" "201"
curl -sS -o "$W/g.zip" "$API/api/v1/gobd-export?companyId=$C&year=$Y" -H "x-user-id: $U" -H "x-company-id: $C"
mkdir "$W/g" && (cd "$W/g" && unzip -q ../g.zip)
assert_eq "the Datenüberlassung has an Anlagen table (was: none, no file named the laptop)" \
  "$(python3 - "$W/g/datenueberlassung" "Laptop $TAG" <<'PY'
import sys, csv, os, xml.etree.ElementTree as ET
d, name = sys.argv[1], sys.argv[2]
idx = open(d + '/index.xml', encoding='utf-8').read()
idx = idx[idx.index('<DataSet>'):]
t = [t for t in ET.fromstring(idx).iter('Table') if t.findtext('Name') == 'Anlagen']
if not t: print('no table'); sys.exit()
t = t[0]
names = [e.findtext('Name') for e in t.find('VariableLength') if e.tag in ('VariablePrimaryKey', 'VariableColumn')]
rows = list(csv.reader(open(os.path.join(d, t.findtext('URL')), encoding='utf-8', newline=''), delimiter=';', quotechar='"'))
r = [dict(zip(names, x)) for x in rows if name in x]
if not r: print('no row'); sys.exit()
r = r[0]
print(r.get('Anschaffungskosten'), r.get('Nutzungsdauer_Monate'), r.get('AfA_Zeitraum'), r.get('Buchwert'))
PY
)" "3000,00 36 1000,00 2000,00"
assert_eq "…and in the manifest" "$(python3 -c "import json,sys;print(any(f['path']=='datenueberlassung/anlagen.csv' for f in json.load(open(sys.argv[1]))['files']))" "$W/g/manifest.json")" "True"

summary
