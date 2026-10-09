#!/bin/bash
# Tier 606 — a boolean in a request is a boolean, or the words for one
#
# The ValidationPipe converts implicitly, and for a property typed boolean
# that is Boolean(value): the STRING "false" — any non-empty string, any
# number but 0 — arrived as true. Measured: {"taxExempt":"false"} stored a
# tax-exempt customer, {"creditNote":"false"} a credit note with negative
# amounts, {"isReverseCharge":"vielleicht"} a § 13b expense. `StrictBoolean`
# (common/strict-boolean.ts) reads the value as it was sent; it is on every
# @IsBoolean() property, and this spec keeps it there.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-362-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

note "=== 1. every boolean property reads its value strictly (static) ==="
REPORT=$(python3 - "$SCRIPT_DIR/../src" <<'PY'
import os, re, sys
n = 0; bad = []
for dp, dn, fn in os.walk(sys.argv[1]):
    for f in fn:
        if not f.endswith('.ts') or f == 'strict-boolean.ts': continue
        p = os.path.join(dp, f); s = open(p, encoding='utf-8').read()
        for m in re.finditer(r'@IsBoolean\(\)', s):
            n += 1
            if not re.search(r'@StrictBoolean\(\)\s*$', s[max(0, m.start() - 60):m.start()]):
                bad.append('%s:%d' % (os.path.relpath(p, sys.argv[1]), s.count('\n', 0, m.start()) + 1))
print(n); print(','.join(bad) or '-')
PY
)
[[ "$(echo "$REPORT" | sed -n 1p)" -ge 30 ]] && pass "found the boolean properties ($(echo "$REPORT" | sed -n 1p))" || fail "only $(echo "$REPORT" | sed -n 1p) @IsBoolean() found — the check is looking in the wrong place"
assert_eq "each @IsBoolean() has @StrictBoolean() in front of it" "$(echo "$REPORT" | sed -n 2p)" "-"

note "=== 1b. Tier 633: every number property reads its value strictly (static) ==="
REPORT=$(python3 - "$SCRIPT_DIR/../src" <<'PY'
import os, re, sys
n = 0; bad = []
for dp, dn, fn in os.walk(sys.argv[1]):
    for f in fn:
        if not f.endswith('.ts') or f == 'strict-number.ts': continue
        p = os.path.join(dp, f); s = open(p, encoding='utf-8').read()
        for m in re.finditer(r'@Is(?:Number|Int)\(', s):
            line = s[s.rfind('\n', 0, m.start()) + 1:m.start()]
            if line.lstrip().startswith(('//', '*', '/*')): continue
            n += 1
            if not line.endswith('@StrictNumber() '):
                bad.append('%s:%d' % (os.path.relpath(p, sys.argv[1]), s.count('\n', 0, m.start()) + 1))
print(n); print(','.join(bad) or '-')
PY
)
[[ "$(echo "$REPORT" | sed -n 1p)" -ge 120 ]] && pass "found the number properties ($(echo "$REPORT" | sed -n 1p))" || fail "only $(echo "$REPORT" | sed -n 1p) @IsNumber() / @IsInt() found — the check is looking in the wrong place"
assert_eq "each @IsNumber() / @IsInt() has @StrictNumber() in front of it" "$(echo "$REPORT" | sed -n 2p)" "-"

note "=== 2. measured on three routes ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier606-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"a","postalCode":"1","city":"b","country":"DE"}}'
K=$(json_field "$BODY" id)
exempt() { AS PUT "/api/v1/customers/$K?companyId=$C" '{"taxExempt":'"$1"'}'; echo "$STATUS/$(q "select \"taxExempt\" from \"Customer\" where id='$K'")"; }
assert_eq "customer taxExempt true" "$(exempt true)" "200/t"
assert_eq "…\"false\" as a string turns it off (was: on)" "$(exempt '"false"')" "200/f"
assert_eq "…\"true\" as a string turns it on" "$(exempt '"true"')" "200/t"
assert_eq "…false turns it off" "$(exempt false)" "200/f"
assert_eq "…\"1\" / \"0\" / 1 / 0" "$(exempt '"1"') $(exempt '"0"') $(exempt 1) $(exempt 0)" "200/t 200/f 200/t 200/f"
assert_eq "…a word that is neither: 400, unchanged (was: on)" "$(exempt '"vielleicht"')" "400/f"
assert_eq "…a number that is neither: 400" "$(exempt 5)" "400/f"

exp() { # number extra → status/net
  AS POST "/api/v1/expenses?companyId=$C" '{"description":"x","invoiceNumber":"'"$1"'","invoiceDate":"2026-06-01","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119'"$2"'}'
  echo "$STATUS/$(q "select coalesce((select \"netAmount\"::numeric(12,2)||'/'||\"isReverseCharge\" from \"Expense\" where \"companyId\"='$C' and \"invoiceNumber\"='$1'),'-')")"
}
assert_eq "expense creditNote \"false\": an ordinary expense (was: a credit note of −100)" "$(exp B-1 ',"creditNote":"false"')" "201/100.00/false"
assert_eq "expense creditNote true: a credit note" "$(exp B-2 ',"creditNote":true')" "201/-100.00/false"
assert_eq "expense isReverseCharge \"false\": not § 13b (was: § 13b)" "$(exp B-3 ',"isReverseCharge":"false"')" "201/100.00/false"
assert_eq "expense isReverseCharge \"nein\": 400, nothing stored" "$(exp B-4 ',"isReverseCharge":"nein"')" "400/-"

note "=== Tier 632: three flags in bodies that are no validated classes ==="
# An inline body type gets no ValidationPipe; these three read their flag as a
# truthy value — "false" was a dry run, the demo bank, a VIES check.
DAY=$(TZ=Europe/Berlin date +%F)
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$DAY'","items":[{"description":"x","quantity":1,"unitPrice":10,"vatRate":0.19}]}'
by_filter() { AS POST "/api/v1/invoices/bulk-send-by-filter?companyId=$C" '{"dateFrom":"'$DAY'","dateTo":"'$DAY'","dryRun":'"$1"'}'; echo "$STATUS/$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('dryRun'))" 2>/dev/null)"; }
assert_eq "bulk send by filter: dryRun \"false\" is no dry run (was: one), true is, a word is refused" "$(by_filter '"false"') $(by_filter true) $(by_filter '"vielleicht"' | cut -d/ -f1)" "201/False 201/True 400"
AS POST "/api/v1/customers/import?companyId=$C" '{"rows":[],"verifyVat":"nein"}'; A=$STATUS
AS POST "/api/v1/customers/import?companyId=$C" '{"rows":[],"verifyVat":"false"}'
assert_eq "customer import: verifyVat \"nein\" is refused, \"false\" is false" "$A $([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS")" "400 ok"
AS POST "/api/v1/fints/connections?companyId=$C" '{"companyId":"'$C'","blz":"12345678","userId":"x","label":"Test","pin":"12345","mockMode":"nein"}'
assert_eq "FinTS connection: mockMode \"nein\" is refused with the reason (was: the demo bank)" "$STATUS/$(echo "$BODY" | grep -c 'mockMode muss true oder false sein')/$(q "select count(*) from \"FinTSConnection\" where \"companyId\"='$C'" 2>/dev/null || echo 0)" "400/1/0"

note "=== Tier 633: a number is a number, or the digits for one ==="
# The implicit conversion is Number(value): true was 1 and "" was 0.
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$DAY'","items":[{"description":"x","quantity":1,"unitPrice":100,"vatRate":0.19}]}'; INV=$(json_field "$BODY" id)
fixture_issuer "$C"
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an issued invoice over 119 €" "$STATUS $(q "select status from \"Invoice\" where id='$INV'")" "200 sent"
pay() { AS POST "/api/v1/invoices/$INV/payments?companyId=$C" '{"amount":'"$1"',"paymentDate":"'$DAY'","paymentMethod":"bank_transfer"}'; echo "$STATUS/$(q "select coalesce(sum(amount),0)::numeric(12,2) from \"Payment\" where \"invoiceId\"='$INV'")"; }
assert_eq "a payment of true: 400, nothing booked (was: 1,00 € booked)" "$(pay true)" "400/0.00"
assert_eq "…of \"\": 400" "$(pay '""')" "400/0.00"
assert_eq "…of \"12abc\": 400" "$(pay '"12abc"')" "400/0.00"
assert_eq "…of \"19\" (digits in a string): 19,00 € — forms send strings" "$(pay '"19"')" "201/19.00"
assert_eq "…of 100: the rest" "$(pay 100)" "201/119.00"
line() { AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$DAY'","items":[{"description":"x","quantity":1,"unitPrice":'"$1"',"vatRate":0.19}]}'; echo "$STATUS"; }
assert_eq "an invoice line priced true / false / [] / {}: 400 each (true was a line at 1,00 €)" "$(line true) $(line false) $(line '[]') $(line '{}')" "400 400 400 400"
assert_eq "…priced \"12.50\": taken" "$(line '"12.50"')/$(q "select max(\"unitPrice\")::numeric(12,2) from \"InvoiceItem\" i join \"Invoice\" v on v.id=i.\"invoiceId\" where v.\"companyId\"='$C' and \"unitPrice\"=12.5")" "201/12.50"
AS PUT "/api/v1/customers/$K?companyId=$C" '{"creditLimit":5000,"paymentTerms":14}'
AS PUT "/api/v1/customers/$K?companyId=$C" '{"creditLimit":"","paymentTerms":""}'
assert_eq "an empty field is 'not given': the credit limit and the payment terms stay (was: both set to 0)" "$STATUS $(q "select \"creditLimit\"::numeric(12,2) || '/' || \"paymentTerms\" from \"Customer\" where id='$K'")" "200 5000.00/14"
AS POST "/api/v1/products?companyId=$C" '{"name":"'$TAG' ohne Preis","basePrice":""}'
prod() { AS POST "/api/v1/products?companyId=$C" '{"name":"'$TAG' P'"$RANDOM"'","basePrice":10,"vatRate":'"$1"'}'; echo "$STATUS/$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin).get('vatRate'))" 2>/dev/null)"; }
assert_eq "a field with a conversion of its own keeps it: a product's VAT rate sent as 19, \"19\" or 0.07 — and true is refused there too" "$(prod 19) $(prod '"19"') $(prod 0.07) $(prod true | cut -d/ -f1)" "201/0.19 201/0.19 201/0.07 400"
assert_eq "a product whose required price is empty: 400 (was: priced 0)" "$STATUS/$(q "select count(*) from \"Product\" where \"companyId\"='$C' and name='$TAG ohne Preis'")" "400/0"
summary
