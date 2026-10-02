#!/bin/bash
# Tier 501 — the December UStVA deducts the Sondervorauszahlung (Kz 39)
#
# A monthly filer with Dauerfristverlängerung pays 1/11 of the previous
# year's Vorauszahlungen as Sondervorauszahlung (§ 47 UStDV) and deducts it
# in the December return (Kz 39, § 48 Abs. 4 UStDV). Measured before: the
# Sondervorauszahlung could be recorded (Tier 484, for the EÜR), but the
# December UStVA never deducted it — Kz 83 asked for it a second time, the
# ELSTER data had no Kz 39.
#
# Now December's Kz 83 is net of it, Kz 39 is in the Kennzahlen and the
# ELSTER data, the UStJA counts it in the Vorauszahlungssoll; other months
# and a quarterly return are unchanged.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-287-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier501-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
sale() { # date net
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
}
sale 2025-11-05 1000   # 190 € tax
sale 2025-12-05 1000   # 190 € tax
AS POST "/api/v1/ustva/payments?companyId=$C" '{"kind":"sondervorauszahlung","year":2025,"paidAt":"2025-02-10","amount":50}'
[[ "$STATUS" == 201 ]] && pass "fixture: Sondervorauszahlung 2025 of 50 € recorded" || fail "svz: $BODY"
kz() { P "[float(k['value']) for k in d.get('kennzahlen', []) if k['kz']=='$1'] or [0.0]"; }

note "=== December ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=12"
DEC="$BODY"
assert_eq "Kz 83 = 190 − 50 = 140 (was 190)" "$(P "float(d['differenzbetrag'])")" "140.0"
assert_eq "Kz 39 = 50 (was missing)" "$(kz 39)" "[50.0]"

note "=== other periods are unchanged ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=11"
assert_eq "November: 190, no Kz 39" "$(P "float(d['differenzbetrag'])")/$(kz 39)" "190.0/[0.0]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&quarter=4"
assert_eq "a quarterly return (no Sondervorauszahlung): 380" "$(P "float(d['differenzbetrag'])")" "380.0"

note "=== the December return is filed with it ==="
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='draft';print(json.dumps(d))" "$DEC")"
assert_eq "the filing is saved (the data carries the new field)" "$STATUS" "201"
F=$(json_field "$BODY" id)
XML=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/ustva/filings/$F/elster-xml?companyId=$C")
assert_eq "ELSTER: Kz 39 = 50,00" "$(echo "$XML" | grep -o 'B-Kz039=[^<"]*' | head -1)" "B-Kz039=+000000005000"

note "=== the UStJA counts it in the Vorauszahlungssoll ==="
AS GET "/api/v1/ustva/ustja?companyId=$C&year=2025"
assert_eq "Soll 190 + 140 + 50 = 380, Abschlusszahlung 0 — as before, with December now net of Kz 39" \
  "$(P "(float(d['totals']['vorauszahlungssoll']), float(d['totals']['abschlusszahlung']))")" "(380.0, 0.0)"

summary
