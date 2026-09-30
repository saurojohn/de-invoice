#!/bin/bash
# Tier 480 — a Kleinunternehmer charges no VAT
#
# Company.defaultVatMode 'kleinunternehmer' (§ 19 UStG). Measured before: a
# 1 000 € line at 19 % (what the invoice form sends) gave an invoice of
# 1 190 € with "USt 19 %: 190,00" and no § 19 note, and the UStVA declared
# 190 € — VAT shown on an invoice is owed (§ 14c Abs. 2 UStG). The PDF's
# § 19 note compared a Prisma Decimal with '0' / 0 and never appeared; by
# operator precedence it would have gone on any company's 0 % invoice.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-266-$(date +%s%N | cut -c1-13)"
company() { # name → "U C"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier480-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
pdf_text() { python3 - "$1" <<'PY'
import sys, re, zlib
raw = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', raw, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: continue
    for tj in re.finditer(rb'\[(.*?)\]\s*TJ', data, re.S):
        print(''.join(bytes.fromhex(h.decode()).decode('latin-1') for h in re.findall(rb'<([0-9a-fA-F]+)>', tj.group(1))))
PY
}
invoice() { # vatRate → invoice id (sent)
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; local k; k=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$k\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":1000,\"vatRate\":$1}]}"
  INVOICE_BODY="$BODY"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}

note "=== a Kleinunternehmer ==="
read -r U C < <(company ku)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer"}'
I=$(invoice 0.19)
AS GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "no VAT on the invoice: net / VAT / total (was 1000 / 190 / 1190)" \
  "$(P "'%g/%g/%g' % (float(d['subtotal']), float(d['totalVat']), float(d['total']))")" "1000/0/1000"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=9"
assert_eq "UStVA: no output tax (was 190)" "$(P "d['umsatzsteuer']")" "0"
curl -sS -o /tmp/t480-ku.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C&sign=false"
TXT=$(pdf_text /tmp/t480-ku.pdf)
assert_eq "PDF: the § 19 note (was missing)" "$(echo "$TXT" | grep -c "§19 UStG wird keine Umsatzsteuer")" "1"
assert_eq "PDF: no VAT line at all (was USt 19 %: 190,00)" "$(echo "$TXT" | grep -c "^USt ")" "0"

note "=== a regular company's 0 % invoice ==="
read -r U C < <(company std)
I=$(invoice 0)
curl -sS -o /tmp/t480-std.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C&sign=false"
assert_eq "no § 19 note — the company is no Kleinunternehmer" "$(pdf_text /tmp/t480-std.pdf | grep -c "§19 UStG")" "0"

summary
