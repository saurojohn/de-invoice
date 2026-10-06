#!/bin/bash
# Tier 493 — the Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG, BT-73/74)
#
# A recurring service or a project is supplied over a period. Measured
# before: an invoice could only carry one date — servicePeriodStart/End were
# rejected (400), a template's servicePeriod too, a recurring invoice for
# October's maintenance stated its issue date, and XRechnung's InvoicePeriod
# was one day.
#
# Now: an invoice takes a period (both dates or neither, start ≤ end) and
# states it on the PDF, in XRechnung (InvoicePeriod) and ZUGFeRD
# (BillingSpecifiedPeriod); a recurring template states the current or the
# previous interval.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-279-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier493-e2e\",\"companyName\":\"$TAG Service\"}" \
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
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"kunde@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"Berlin\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
pdf_text() { python3 - "$1" <<'PY'
import sys, re, zlib
raw = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', raw, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: data = m.group(1)
    for tj in re.finditer(rb'\[(.*?)\]\s*TJ', data, re.S):
        print(''.join(bytes.fromhex(h.decode()).decode('latin-1') for h in re.findall(rb'<([0-9a-fA-F]+)>', tj.group(1))))
    for x in re.findall(rb'<ram:BillingSpecifiedPeriod>(.*?)</ram:BillingSpecifiedPeriod>', data, re.S):
        print('XML ' + ' '.join(d.decode() for d in re.findall(rb'format="102">(\d+)<', x)))
PY
}
ITEMS='"items":[{"description":"Wartung","quantity":1,"unit":"Monat","unitPrice":500,"vatRate":0.19}]'

note "=== an invoice with a Leistungszeitraum ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-02\",\"servicePeriodStart\":\"2026-08-01\",\"servicePeriodEnd\":\"2026-08-31\",$ITEMS}"
INV=$(json_field "$BODY" id)
assert_eq "the period is stored (was a 400)" \
  "$(q "select to_char(\"servicePeriodStart\",'YYYY-MM-DD')||'/'||to_char(\"servicePeriodEnd\",'YYYY-MM-DD') from \"Invoice\" where id='$INV'" 2>/dev/null)" "2026-08-01/2026-08-31"
curl -sS -o /tmp/t493.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$INV/pdf?companyId=$C&sign=false"
TXT=$(pdf_text /tmp/t493.pdf)
assert_eq "PDF: Leistungszeitraum 01.08.2026 – 31.08.2026" \
  "$(echo "$TXT" | grep -c "^Leistungszeitraum:$")/$(echo "$TXT" | grep -c "^01.08.2026 ")/$(echo "$TXT" | grep -c "^31.08.2026$")" "1/1/1"
assert_eq "…instead of a Leistungsdatum" "$(echo "$TXT" | grep -c "^Leistungsdatum:$")" "0"
curl -sS -o /tmp/t493.xml -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$INV/xrechnung?companyId=$C"
assert_eq "XRechnung InvoicePeriod 2026-08-01 … 2026-08-31 (was the issue date twice)" \
  "$(python3 -c "import re;s=open('/tmp/t493.xml').read();m=re.search(r'<cac:InvoicePeriod>\s*<cbc:StartDate>([^<]+)</cbc:StartDate>\s*<cbc:EndDate>([^<]+)<',s);print(m.groups() if m else None)")" \
  "('2026-08-01', '2026-08-31')"
AS GET "/api/v1/invoices/$INV/xrechnung/validate?companyId=$C"
assert_eq "…and it validates" "$(P "(d.get('valid'), [e['rule'] for e in d.get('errors', [])])")" "(True, [])"
curl -sS -o /tmp/t493z.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$INV/zugferd?companyId=$C"
assert_eq "ZUGFeRD BillingSpecifiedPeriod 20260801 – 20260831" "$(pdf_text /tmp/t493z.pdf | grep '^XML ')" "XML 20260801 20260831"

note "=== both dates or neither, in order ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-02\",\"servicePeriodStart\":\"2026-08-01\",$ITEMS}"
assert_eq "only a start → 400" "$STATUS" "400"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-02\",\"servicePeriodStart\":\"2026-08-31\",\"servicePeriodEnd\":\"2026-08-01\",$ITEMS}"
assert_eq "start after end → 400" "$STATUS" "400"

note "=== a recurring template states its interval ==="
# Tier 535: a start in the past begins from today — these templates start in 2030,
# so that the first run is 01.10.2030 whenever the spec runs.
tpl() { # name mode
  AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"customerId\":\"$K\",\"name\":\"$1\",\"interval\":\"monthly\",\"dayOfMonth\":1,\"startDate\":\"2030-09-01\",\"servicePeriod\":\"$2\",$ITEMS}"
  json_field "$BODY" id
}
period_of_run() { # template
  AS POST "/api/v1/recurring-invoices/$1/run?companyId=$C" '{}'
  q "select coalesce(to_char(\"servicePeriodStart\",'YYYY-MM-DD')||'/'||to_char(\"servicePeriodEnd\",'YYYY-MM-DD'),'none') from \"Invoice\" where \"recurringInvoiceId\"='$1'"
}
TC=$(tpl "Wartung im Voraus" current)
assert_eq "the template keeps its mode" "$(q "select \"servicePeriod\" from \"RecurringInvoice\" where id='$TC'" 2>/dev/null)" "current"
AS GET "/api/v1/recurring-invoices/$TC/preview?companyId=$C"
assert_eq "preview: October (run on 01.10.)" "$(P "(d.get('servicePeriodStart') or '')[:10]+'/'+(d.get('servicePeriodEnd') or '')[:10]")" "2030-10-01/2030-10-31"
assert_eq "'current': the run of 01.10. bills 01.10.–31.10." "$(period_of_run "$TC")" "2030-10-01/2030-10-31"
TP=$(tpl "Support nachträglich" previous)
assert_eq "'previous': the run of 01.10. bills 01.09.–30.09." "$(period_of_run "$TP")" "2030-09-01/2030-09-30"
TN=$(tpl "Ohne Zeitraum" none)
assert_eq "'none': no period, as before" "$(period_of_run "$TN")" "none"
AS PUT "/api/v1/recurring-invoices/$TN?companyId=$C" '{"servicePeriod":"previous"}'
assert_eq "the mode is editable" "$(q "select \"servicePeriod\" from \"RecurringInvoice\" where id='$TN'" 2>/dev/null)" "previous"

summary
