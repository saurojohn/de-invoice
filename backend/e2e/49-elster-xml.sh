#!/usr/bin/env bash
# e2e 49: the UStVA's ELSTER XML — its structure
#
# GET /api/v1/ustva/filings/:id/elster-xml. Tier 734 made it the declaration
# as ELSTER's data delivery carries it (elster.service.ts): <Anmeldungssteuern>
# in the namespace …/elsteranmeldung/ustva/v<year>, version="<year>",
# Erstellungsdatum, DatenLieferant, Steuerfall / Umsatzsteuervoranmeldung
# with Jahr, Zeitraum, Steuernummer and the Kennzahlen as elements in the
# order of their numbers. The values are spec 455's (and 206's).
#
# This spec had asserted a <Datenlieferung> root and "B 1234…" values, and
# skipped every check of the elements — the generator wrote none (Tier 371).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-49-$(date +%s%N | cut -c1-13)"
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier734-e2e\",\"companyName\":\"$TAG GmbH\"}"
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
AS PUT "/api/v1/companies/$C?companyId=$C" '{"taxId":"181/815/08155","bundesland":"BY"}'
assert_eq "fixture: Steuernummer and Land" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"2026-02-10\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?companyId=$C" "$INV"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&quarter=1"
SAVE=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$BODY")
AS POST "/api/v1/ustva/filings?companyId=$C" "$SAVE"
assert_eq "fixture: a filing of Q1" "$STATUS" "201"
FID=$(json_field "$BODY" id)

curl -sS -D /tmp/t49_hdr.txt -o /tmp/t49.xml -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/ustva/filings/$FID/elster-xml?companyId=$C"
assert_eq "Content-Type is application/xml" "$(grep -i '^content-type' /tmp/t49_hdr.txt | awk '{print $2}' | tr -d '\r;')" "application/xml"
SHAPE=$(python3 - /tmp/t49.xml <<'PY'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
ns = '{http://finkonsens.de/elster/elsteranmeldung/ustva/v2026}'
print(root.tag, root.get('version'))
print(' '.join(c.tag.replace(ns, '') for c in root))
u = root.find(f'{ns}Steuerfall/{ns}Umsatzsteuervoranmeldung')
tags = [c.tag.replace(ns, '') for c in u]
print(' '.join(tags[:3]))
kz = [int(t[2:]) for t in tags[3:]]
print('Kennzahlen in the order of their numbers' if kz == sorted(kz) and all(t.startswith('Kz') for t in tags[3:]) else 'out of order: ' + ' '.join(tags))
print(' '.join(f"{c.tag.replace(ns, '')}={c.text}" for c in u))
PY
)
L() { sed -n "${1}p" <<<"$SHAPE"; }
assert_eq "root <Anmeldungssteuern>, the year's namespace and version (was <Datenlieferung>)" "$(L 1)" \
  "{http://finkonsens.de/elster/elsteranmeldung/ustva/v2026}Anmeldungssteuern 2026"
assert_eq "its parts" "$(L 2)" "Erstellungsdatum DatenLieferant Steuerfall"
assert_eq "the declaration begins with Jahr, Zeitraum, Steuernummer" "$(L 3)" "Jahr Zeitraum Steuernummer"
assert_eq "…then the Kennzahlen as elements, ordered (was B-Kz text lines)" "$(L 4)" "Kennzahlen in the order of their numbers"
assert_eq "Q1 is Zeitraum 41; Bayern's 181/815/08155 is 9181081508155; Kz 81 in whole euros, Kz 83 with cents" "$(L 5)" \
  "Jahr=2026 Zeitraum=41 Steuernummer=9181081508155 Kz81=1000 Kz83=190.00"
assert_eq "Erstellungsdatum as YYYYMMDD" "$(grep -oE '<Erstellungsdatum>[0-9]{8}</Erstellungsdatum>' /tmp/t49.xml | wc -l | tr -d ' ')" "1"
assert_eq "the supplier: the company's name, street, PLZ, Ort" \
  "$(grep -oE '<(Name|Strasse|PLZ|Ort)>[^<]*' /tmp/t49.xml | sed 's/<//' | tr '\n' '|')" "Name>$TAG GmbH|Strasse>Teststr. 1|PLZ>10115|Ort>Berlin|"

summary
