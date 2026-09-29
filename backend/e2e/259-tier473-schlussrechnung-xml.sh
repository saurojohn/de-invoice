#!/bin/bash
# Tier 473 — the final invoice in XRechnung / ZUGFeRD
#
# Tier 472's final invoice deducts the advance on its PDF. Measured before on
# the same invoice (1 190, fully prepaid): the XRechnung said PayableAmount
# 1190.00 with no PrepaidAmount (BT-113) — an e-invoice asking for money
# already paid — and GET …/zugferd rendered its PDF without the deduction
# (only GET …/pdf attached it). The invoice API did not name the Proforma.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-259-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier473-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","address":{"street":"Hauptstr. 1","postalCode":"10115","city":"Berlin","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Testbank"}}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"kunde@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"2026-03-02\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
PI=$(json_field "$BODY" id); PIN=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$PI/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-03-05","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$PI/final-invoice?companyId=$C" '{"issueDate":"2026-03-20"}'; INV=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: a final invoice, fully prepaid" "$STATUS" "200"

AS GET "/api/v1/invoices/$INV?companyId=$C"
assert_eq "the invoice names its Proforma (was: nothing)" "$(P "(d.get('advanceInvoice') or {}).get('invoiceNumber')")" "$PIN"

note "=== XRechnung ==="
curl -sS -o /tmp/t473.xml -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$INV/xrechnung?companyId=$C"
amt() { python3 -c "import re,sys;m=re.search(r'<cbc:$1 [^>]*>([^<]+)<', open('/tmp/t473.xml').read());print(m.group(1) if m else '-')"; }
assert_eq "TaxInclusiveAmount: the whole delivery" "$(amt TaxInclusiveAmount)" "1190.00"
assert_eq "PrepaidAmount BT-113 (was missing)" "$(amt PrepaidAmount)" "1190.00"
assert_eq "PayableAmount 0.00 (was 1190.00)" "$(amt PayableAmount)" "0.00"
AS GET "/api/v1/invoices/$INV/xrechnung/validate?companyId=$C"
assert_eq "…and it validates" "$(P "(d.get('valid'), [e['rule'] for e in d.get('errors', [])])")" "(True, [])"

note "=== ZUGFeRD ==="
curl -sS -o /tmp/t473.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$INV/zugferd?companyId=$C"
python3 - /tmp/t473.pdf > /tmp/t473.txt <<'PY'
import sys, re, zlib
raw = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', raw, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: data = m.group(1)
    for tj in re.finditer(rb'\[(.*?)\]\s*TJ', data, re.S):
        print(''.join(bytes.fromhex(h.decode()).decode('latin-1') for h in re.findall(rb'<([0-9a-fA-F]+)>', tj.group(1))))
    for x in re.findall(rb'<ram:(TotalPrepaidAmount|DuePayableAmount)>([^<]+)<', data):
        print('XML %s=%s' % (x[0].decode(), x[1].decode()))
PY
assert_eq "the embedded CII: TotalPrepaidAmount 1190.00, DuePayableAmount 0.00" \
  "$(grep '^XML ' /tmp/t473.txt | sort | tr '\n' ' ')" "XML DuePayableAmount=0.00 XML TotalPrepaidAmount=1190.00 "
assert_eq "the visual PDF states the deduction (was not on this path)" "$(grep -c '^Zahlbetrag:' /tmp/t473.txt)" "1"

summary
