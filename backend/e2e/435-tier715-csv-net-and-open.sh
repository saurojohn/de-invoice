#!/bin/bash
# Tier 715 — the invoice list's CSV: the net after the discount, nothing open
# where nothing is owed
#
# „Netto“ was `subtotal`, the lines' sum before the invoice's discount.
# Measured: an invoice of 1 000 € less 10 % — „1000,00;171,00;1071,00“, a net
# that with its tax does not make the total. „Offen“ was total less payments
# for every row: a draft „offen 833,00“; a credit note and an invoice
# cancelled by its Storno said 0,00 — as if they were paid.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-435-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier715-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { # unitPrice extra-json [draft] → I, N
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"dueDate\":\"2099-12-31\"$2,\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber)
  [[ "${3:-}" == "draft" ]] || AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
inv 1000 ',"discountPercent":10'; DISC=$N
AS GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "fixture: 1 000 € less 10 %: 900 € net, 171 € tax, 1 071 € (stored subtotal 1 000)" \
  "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(float(d['subtotal']), float(d['totalVat']), float(d['total']))" "$BODY")" "1000.0 171.0 1071.0"
inv 700 '' draft; DRAFT=$N
inv 50 ''; STORNO=$N; SID=$I
AS POST "/api/v1/invoices/$SID/credit-note?companyId=$C" '{"amount":59.5,"reason":"Storno"}'
CN=$(json_field "$BODY" invoiceNumber)
[[ "$CN" == CN-* ]] && pass "fixture: a Storno credit note $CN" || fail "credit note: $BODY"

curl -sS -o "$WORK/inv.csv" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/export/csv?companyId=$C&dateFrom=$TODAY&dateTo=$TODAY"
col() { # number column → the cell (header names the columns)
  python3 - "$WORK/inv.csv" "$1" "$2" <<'PY'
import csv, sys
rows = list(csv.reader(open(sys.argv[1], encoding='utf-8-sig'), delimiter=';'))
head = rows[0]
row = next(r for r in rows[1:] if r[0] == sys.argv[2])
print(row[head.index(sys.argv[3])])
PY
}
assert_eq "the discounted invoice: net 900, tax 171, total 1 071 (was net 1000,00)" \
  "$(col "$DISC" Netto);$(col "$DISC" USt);$(col "$DISC" Gesamt)" "900,00;171,00;1071,00"
assert_eq "…open 1 071" "$(col "$DISC" Offen)" "1071,00"
assert_eq "the draft: nothing open (was 833,00)" "$(col "$DRAFT" Offen)" ""
assert_eq "the credit note: nothing open (was 0,00)" "$(col "$CN" Offen)" ""
assert_eq "the invoice cancelled by it: nothing open (was 0,00)" "$(col "$STORNO" Offen)" ""

summary
