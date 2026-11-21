#!/bin/bash
# Tier 907 — the KSt rate of the year
#
# § 23 Abs. 1 KStG as amended by the Gesetz für ein steuerliches
# Investitionssofortprogramm (BGBl. 2025): 15 % until 2027, then one point
# less a year — 14 % for 2028 … 10 % from 2032. Measured: KSt 1 computed 15 %
# for every year (kst1.service), its PDF and its note said 15 %, and the page
# labelled the block „Körperschaftsteuer (15 %)“.
#
# A year to come has no invoices yet (an issue date in the future is
# refused), so the spec issues the invoice today and moves its date in the
# test database.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-595-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier907-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
T() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(d['totals'].get(sys.argv[2]))" "$BODY" "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 595","type":"business","address":{"street":"Weg 1","postalCode":"10115","city":"Berlin","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100050,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: a GmbH with 100 050 € net, issued" "$STATUS" "200"

kst() { AS GET "/api/v1/accounting/kst1?companyId=$C&year=$1"; echo "$(T kstProzent) $(T kst)"; }
assert_eq "$Y: 15 %, 15 007 €" "$(kst "$Y")" "15 15007"

# move year: the invoice's dates into another year (test database)
move() { q "update \"Invoice\" set \"issueDate\"='$1-03-01', \"dueDate\"='$1-03-15', \"deliveryDate\"=null where id='$I'" >/dev/null; }
move 2028
assert_eq "2028: 14 %, 14 007 € (was 15 %, 15 007 €)" "$(kst 2028)" "14 14007"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=2028"   # (kst runs in a subshell)
python3 -c "import sys,json;sys.exit(0 if 'KSt 14% + Soli' in json.loads(sys.argv[1])['disclaimer'] else 1)" "$BODY" \
  && pass "…the note says 14 %" || fail "note: $(python3 -c "import sys,json;print(json.loads(sys.argv[1])['disclaimer'][:200])" "$BODY")"
curl -sS -o "/tmp/t907.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/kst1.pdf?companyId=$C&year=2028"
python3 - "/tmp/t907.pdf" <<'PY' && pass "…the PDF says „Steuersatz: 14 %“" || fail "PDF rate"
import sys, re, zlib
raw = open(sys.argv[1], 'rb').read()
text = b''
for m in re.finditer(rb'stream\r?\n(.*?)endstream', raw, re.S):
    try: text += zlib.decompress(m.group(1))
    except Exception: pass
hexes = b''.join(bytes.fromhex(h.decode()) for h in re.findall(rb'<([0-9a-fA-F]+)>', text))
sys.exit(0 if b'Steuersatz: 14' in text + hexes else 1)
PY
rm -f /tmp/t907.pdf
move 2031
assert_eq "2031: 11 %, 11 005 € (rounded down)" "$(kst 2031)" "11 11005"
move 2032
assert_eq "2032: 10 %, 10 005 €" "$(kst 2032)" "10 10005"
move 2027
assert_eq "2027: still 15 %" "$(kst 2027)" "15 15007"

summary
