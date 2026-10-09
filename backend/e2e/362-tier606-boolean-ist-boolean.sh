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
summary
