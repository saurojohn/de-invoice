#!/bin/bash
# Tier 709 — what was invoiced, per month and per year, and what was sold
#
# The owner, 20.10.2026: „发票方面实现每个月和年度能看开出去的金额数据和数量销售功能“
# (per month and per year: the amounts invoiced, how many, and the quantities
# sold). The Umsatzbericht listed only months that had an invoice, put a net
# total above a table of gross amounts, counted a credit note as an invoice,
# and had no quantities.
# GET /reports/invoice-statistics?year=&month= — the twelve months, the years
# up to this one, and the articles sold (invoice-statistics.service.ts has
# the rules). Fixture, all by hand:
#   2025-05  INV 5 Std Beratung                       500,00 net
#   2026-01  INV 2 Stk Gürtel + 1 Std Beratung         200,00
#   2026-03  INV 10 Std Beratung, 10 % Rabatt          900,00
#   2026-03  INV 1 Stk Gürtel — storniert (CN today)    50,00
#   2026-06  INV 1 Pausch Consulting, 1 000 USD @ 1,1  909,09 €
#   2026-10  CN Storno −50,00, CN 119 € brutto −100,00
#   not counted: a draft (07), a quote (07), an invoice cancelled by its status (08)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-430-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier709-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/products?companyId=$C" "{\"name\":\"$TAG Gürtel\",\"basePrice\":50,\"vatRate\":0.19}"; PR=$(json_field "$BODY" id)
belt() { echo "{\"productId\":\"$PR\",\"description\":\"Gürtel\",\"quantity\":$1,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}"; }
hours() { echo "{\"description\":\"Beratung\",\"quantity\":$1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}"; }
issued() { # date extra items → INV
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\"$2,\"items\":[$3]}"; INV=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
}
issued 2025-05-05 '' "$(hours 5)"; PREV=$INV
issued 2026-01-15 '' "$(belt 2),$(hours 1)"; JAN=$INV
issued 2026-03-10 ',"discountPercent":10' "$(hours 10)"; MAR=$INV
issued 2026-03-20 '' "$(belt 1)"; STORNO=$INV
issued 2026-06-01 ',"currency":"USD","exchangeRate":1.1' "{\"description\":\"Consulting\",\"quantity\":1,\"unit\":\"Pausch\",\"unitPrice\":1000,\"vatRate\":0.19}"; USD=$INV
AS POST "/api/v1/invoices/$STORNO/credit-note?companyId=$C" '{"reason":"Storno"}'
AS POST "/api/v1/invoices/$MAR/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'
# (a credit note is dated the day it is made — pinned to 15.10.2026, so the checks hold in any year)
q "update \"Invoice\" set \"issueDate\"='2026-10-15' where \"companyId\"='$C' and type='CN'" >/dev/null
# not counted: a draft, a quote, an invoice cancelled by its status (data before Tier 694)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-07-01\",\"items\":[$(hours 7)]}"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"QU\",\"issueDate\":\"2026-07-02\",\"items\":[$(hours 30)]}"
issued 2026-08-01 '' "$(hours 3)"; q "update \"Invoice\" set status='cancelled' where id='$INV'" >/dev/null

note "=== 1. the year 2026 ==="
AS GET "/api/v1/reports/invoice-statistics?companyId=$C&year=2026"
assert_eq "200" "$STATUS" "200"
assert_eq "4 invoices (1 of them cancelled by its Storno), 2 credit notes — the draft, the quote and the cancelled one not" \
  "$(P "d['total']['invoiceCount'], d['total']['cancelledCount'], d['total']['creditNoteCount']")" "(4, 1, 2)"
assert_eq "net 2 059,09 − 150,00, VAT and gross in euros" "$(P "d['total']['net'], d['total']['vat'], d['total']['gross']")" "(1909.09, 362.73, 2271.82)"
assert_eq "all twelve months (was: only months with an invoice)" "$(P "[m['month'] for m in d['months']]")" "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]"
month() { P "[(m['invoiceCount'], m['creditNoteCount'], m['net']) for m in d['months'] if m['month']==$1][0]"; }
assert_eq "January" "$(month 1)" "(1, 0, 200)"
assert_eq "March: two invoices, one cancelled later — 900 + 50" "$(month 3)" "(2, 0, 950)"
assert_eq "June: the USD invoice in euros" "$(month 6)" "(1, 0, 909.09)"
assert_eq "July (a draft and a quote): nothing" "$(month 7)" "(0, 0, 0)"
assert_eq "August (cancelled by its status): nothing" "$(month 8)" "(0, 0, 0)"
assert_eq "October: the two credit notes, −50 − 100 (§ 17 UStG: in their own month)" "$(month 10)" "(0, 2, -150)"

note "=== 2. the years ==="
assert_eq "2025 and 2026, the change of the net" "$(P "[(y['year'], y['invoiceCount'], y['net'], y['netChangePct']) for y in d['years']]")" "[(2025, 1, 500, None), (2026, 4, 1909.09, 281.82)]"

note "=== 3. what was sold in 2026 ==="
rows() { P "[(r['name'].replace('$TAG ', ''), r['unit'], r['quantity'], r['net'], r['invoiceCount']) for r in d['products']['rows']]"; }
assert_eq "by article: 11 Std Beratung (900 after the discount + 100), the Consulting, 2 Gürtel — the cancelled one sold nothing" \
  "$(rows)" "[('Beratung', 'Std', 11, 1000, 2), ('Consulting', 'Pausch', 1, 909.09, 1), ('Gürtel', 'Stk', 2, 100, 1)]"
assert_eq "…the cancelled invoice and the credit notes as rows of their own; all add up to the net" \
  "$(P "d['products']['cancelledNet'], d['products']['creditNotesNet'], d['products']['net'], round(sum(r['net'] for r in d['products']['rows']) + d['products']['cancelledNet'] + d['products']['creditNotesNet'], 2)")" \
  "(50, -150, 1909.09, 1909.09)"
AS GET "/api/v1/reports/invoice-statistics?companyId=$C&year=2026&month=3"
assert_eq "March alone: 10 Std Beratung, the cancelled invoice +50" "$(rows)/$(P "d['products']['cancelledNet'], d['products']['creditNotesNet'], d['products']['net']")" "[('Beratung', 'Std', 10, 900, 1)]/(50, 0, 950)"

note "=== 4. the request ==="
AS GET "/api/v1/reports/invoice-statistics?companyId=$C&year=26"
assert_eq "a year that is none: 400" "$STATUS" "400"
AS GET "/api/v1/reports/invoice-statistics?companyId=$C&year=2026&month=13"
assert_eq "a month that is none: 400" "$STATUS" "400"
UA=$U; CA=$C
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-b@example.test\",\"password\":\"Tier709-e2e\",\"companyName\":\"$TAG B GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
AS GET "/api/v1/reports/invoice-statistics?companyId=$CA&year=2026"
assert_eq "another company asking for A's: refused" "$([[ "$STATUS" =~ ^40[34]$ ]] && echo refused || echo "$STATUS")" "refused"
AS GET "/api/v1/reports/invoice-statistics?companyId=$C&year=2026"
assert_eq "…its own: nothing" "$(P "d['total']['invoiceCount'], d['total']['net'], d['products']['rows']")" "(0, 0, [])"

summary
