#!/bin/bash
# Tier 482 — § 19 in the e-invoice of a Kleinunternehmer
#
# Tier 480 put a Kleinunternehmer's lines at 0 %. Measured before on such an
# invoice: the XRechnung said category E with TaxExemptionReason
# "Steuerbefreite Leistung" (BT-120) — no ground at all, as for any 0 %
# line; ZUGFeRD the same. The ground is § 19 UStG.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-268-$(date +%s%N | cut -c1-13)"
company() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier482-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
setup() { # vatMode vatRate → invoice id
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"defaultVatMode\":\"$1\",\"email\":\"rechnung@example.test\",\"taxId\":\"123/456/78901\",\"address\":{\"street\":\"Hauptstr. 1\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","contact":{"email":"k@example.test"},"address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'
  local k; k=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$k\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":1000,\"vatRate\":$2}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
reason() { python3 -c "import re;m=re.findall(r'<cbc:TaxExemptionReason>([^<]*)<', open('$1').read());print(' | '.join(m))"; }

note "=== a Kleinunternehmer ==="
read -r U C < <(company ku); I=$(setup kleinunternehmer 0.19)
curl -sS -o /tmp/t482-ku.xml -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/xrechnung?companyId=$C"
assert_eq "XRechnung BT-120 names § 19 (was Steuerbefreite Leistung)" "$(reason /tmp/t482-ku.xml)" "Kleinunternehmer gemäß § 19 UStG — keine Umsatzsteuer"
AS GET "/api/v1/invoices/$I/xrechnung/validate?companyId=$C"
assert_eq "…and it validates" "$(P "(d['valid'], [e['rule'] for e in d['errors']])")" "(True, [])"
curl -sS -o /tmp/t482-ku.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/zugferd?companyId=$C"
assert_eq "ZUGFeRD ExemptionReason names § 19" \
  "$(python3 - /tmp/t482-ku.pdf <<'PY'
import sys, re, zlib
raw = open(sys.argv[1], 'rb').read()
out = set()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', raw, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: data = m.group(1)
    for x in re.findall(rb'<ram:ExemptionReason>([^<]*)<', data): out.add(x.decode('utf-8'))
print(' | '.join(sorted(out)))
PY
)" "Kleinunternehmer gemäß § 19 UStG — keine Umsatzsteuer"

note "=== a regular company's 0 % invoice ==="
read -r U C < <(company std); I=$(setup standard 0)
curl -sS -o /tmp/t482-std.xml -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/xrechnung?companyId=$C"
assert_eq "unchanged: Steuerbefreite Leistung" "$(reason /tmp/t482-std.xml)" "Steuerbefreite Leistung"

summary
