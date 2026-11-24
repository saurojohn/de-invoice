#!/bin/bash
# Tier 976 — the SEPA transfer file follows pain.001.001.09
#
# Measured: EndToEndId `E2E-<uuid>` of 40 characters (Max35Text),
# <ReqdExctnDt> without its <Dt>, <BIC> instead of <BICFI>, a creditor name of
# 104 characters (70 allowed) — the bank's schema check (DFÜ-Abkommen
# Anlage 3) refuses the whole file, while the bills were marked paid already.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-663-$(date +%s%N | cut -c1-13)"
EXEC=$(TZ=Europe/Berlin date -v+3d +%F 2>/dev/null || TZ=Europe/Berlin date -d '3 days' +%F)
D=$(TZ=Europe/Berlin date +%F)
LONG="$TAG Lieferant mit einem sehr langen Namen GmbH & Co. KG Niederlassung Süd Abteilung Einkauf"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier976-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc \
  "update \"Company\" set \"bankInfo\" = coalesce(\"bankInfo\", '{}'::jsonb) || '{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}'::jsonb where id='$C'" >/dev/null
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$LONG\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"10115\",\"country\":\"DE\"},\"bankInfo\":{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
SUP=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"L-1\",\"description\":\"Material\",\"invoiceDate\":\"$D\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
X=$(json_field "$BODY" id)
AS POST "/api/v1/payments/batches?companyId=$C" "{\"companyId\":\"$C\",\"expenseIds\":[\"$X\"],\"executionDate\":\"$EXEC\"}"
B=$(json_field "$BODY" id)
assert_eq "a SEPA batch for one bill" "$STATUS" "201"
AS GET "/api/v1/payments/batches/$B/xml?companyId=$C"
XML="$BODY"
assert_eq "EndToEndId at most 35 characters (was 40)" \
  "$(echo "$XML" | grep -oE '<EndToEndId>[^<]*' | sed 's/<EndToEndId>//' | awk '{print (length($0) <= 35) ? "ok" : "long:" length($0)}')" "ok"
assert_eq "ReqdExctnDt carries a <Dt> (was a bare date)" "$(echo "$XML" | grep -c "<ReqdExctnDt><Dt>$EXEC</Dt></ReqdExctnDt>")" "1"
assert_eq "BICFI for both banks, no BIC element (was <BIC>)" "$(echo "$XML" | grep -o '<BICFI>COBADEFFXXX</BICFI>' | wc -l | tr -d ' ')/$(echo "$XML" | grep -o '<BIC>' | wc -l | tr -d ' ')" "2/0"
assert_eq "names at most 70 characters (was 104)" \
  "$(python3 -c "import re,sys,html;print(sum(len(html.unescape(n)) > 70 for n in re.findall(r'<Nm>([^<]*)', sys.argv[1])))" "$XML")" "0"

summary
