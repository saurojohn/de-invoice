#!/bin/bash
# Tier 920 — erhaltene Anzahlungen net of their VAT (Nettomethode)
#
# The Bilanz showed an advance received gross (a Proforma's payment, Tier 470;
# a Vorausrechnung paid before its supply, Tier 919) — while its VAT, declared
# when received, stood in the Umsatzsteuer owed as well: 1 190 € received were
# 1 380 € of debts. Since BilMoG the net method is the only one (the gross one
# with an active RAP for the VAT, § 250 Abs. 1 Satz 2 Nr. 2 HGB a. F., is gone);
# DATEV books it so too (1718 net, the tax split off by its key).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-608-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier920-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 608","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
# a Proforma of 1 000 + 190, paid today
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Anzahlung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
PI=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" "{\"amount\":1190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "the advance received" "$STATUS" "201"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$Y"
anz=$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4200'][0]")
ust=$(P "next(l['amount'] for s in d['passiva'] for l in s['lines'] if l['label']=='Sonstige Verbindlichkeiten')")
assert_eq "Erhaltene Anzahlungen 1 000 net (was 1 190)" "$anz" "1000"
assert_eq "…its 190 € VAT owed to the Finanzamt" "$ust" "190"
assert_eq "…together the 1 190 € received, not 1 380" "$(python3 -c "print(round($anz + $ust, 2))")" "1190"

summary
