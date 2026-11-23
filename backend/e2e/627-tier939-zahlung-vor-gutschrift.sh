#!/bin/bash
# Tier 939 — a payment dated before a credit note, entered after it
#
# Ist-Versteuerung: an invoice of 1 190 €, a credit note of 595 € (today), then
# the bank payment of 1 190 € dated a week ago, entered afterwards (a late
# statement). The payments were walked by date: the bank payment took the
# whole invoice, the credit note's settlement nothing — and its 595 € became
# the customer's credit as well. Measured: Kz 81 1 000 / 190 for the invoice,
# and with the credit applied to the next invoice 1 500 / 285; EÜR 1 785 €
# received for 1 190 €. A credit note lowers the invoice whatever its date.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-627-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
WEEK=$(python3 -c "import datetime as d;t=d.date.fromisoformat('$TODAY');w=t-d.timedelta(days=7);print(w.isoformat() if w.month==t.month else t.replace(day=1).isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier939-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a GmbH (Ist)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"rechtsform\":\"GmbH\",\"besteuerungsart\":\"ist\",\"besteuerungsartAb\":\"$Y-01-01\"}"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 627","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
K=$(json_field "$BODY" id)
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"; I=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; }
kz() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"; P "(lambda k: f\"{k.get('81',0)}/{k.get('83',0)}\")({x['kz']:x['value'] for x in d['kennzahlen'] if x.get('value')})"; }
received() { AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"; P "d['totals']['einnahmenTotal']"; }

inv "$WEEK" 1000; A=$I
AS POST "/api/v1/invoices/$A/credit-note?companyId=$C" '{"amount":595,"reason":"Teilgutschrift"}'
assert_eq "a credit note of 595 € today" "$STATUS" "201"
AS POST "/api/v1/invoices/$A/payments?companyId=$C" "{\"amount\":1190,\"paymentDate\":\"$WEEK\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "the payment of 1 190 € dated $WEEK, entered now" "$STATUS" "201"
assert_eq "UStVA: the invoice's 500 / 95 (was 1 000 / 190)" "$(kz)" "500/95"
inv "$TODAY" 500; B=$I
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$B\",\"amount\":595}"
assert_eq "the 595 € overpaid applied to the next invoice" "$STATUS" "201"
assert_eq "UStVA: 1 000 / 190 for the 1 190 € received (was 1 500 / 285)" "$(kz)" "1000/190"
assert_eq "EÜR: 1 190 € received (was 1 785)" "$(received)" "1190"

summary
