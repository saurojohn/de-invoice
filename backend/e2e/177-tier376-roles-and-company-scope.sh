#!/bin/bash
# Tier 376 — roles are enforced on every route, /companies/:id is bound to the
# tenant, and VAT rates no longer leak between tenants
#
# Measured on a fresh stack before the change:
#   * A freshly registered user (admin of its own new company) sent
#     PUT /companies/<another tenant's id> {"name": ...} → 200, and the other
#     company's name changed in the database. GET /companies/<id>,
#     /datev-config and /feature-flags → 200 with the other tenant's data.
#     Tier 375 bound parameters named `companyId`; this controller calls it `:id`.
#   * A user with role `viewer` created a chart-of-accounts entry
#     (POST /accounting/accounts → 201), an asset (POST /assets → 201) and a
#     supplier (POST /ocr/match-supplier → 201), and rewrote the SMTP host
#     (PUT /mail/config → 200). 96 routes had no @Require; RolesGuard ran only
#     where a controller applied @Auth(), so the nine installment-plan routes
#     carried @Require() that was never evaluated.
#   * Tenant B's POST /vat-rates stored a GLOBAL row (companyId NULL); tenant
#     A's GET /vat-rates/current then returned B's 99 % rate.
#   * GET /health/summary was public and counted every company, user and
#     invoice on the installation (e2e 167 now covers its new scope).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
SRC="$SCRIPT_DIR/../src"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }

note "=== 1. static: RolesGuard is global, and every non-public route checks a role ==="
grep -qE "provide: APP_GUARD, useClass: RolesGuard" "$SRC/app.module.ts" \
  && pass "RolesGuard is registered as APP_GUARD" || fail "RolesGuard is not an APP_GUARD"
grep -qE "@CompanyIdParam\('id'\)" "$SRC/modules/company/company.controller.ts" \
  && pass "CompanyController binds :id to the tenant" || fail "CompanyController lacks @CompanyIdParam('id')"

# Routes that act on the caller's own account, or whose service filters per
# entity (search), need no role. Anything else without a role check fails.
EXPECTED_NO_ROLE="GET auth/me
GET search/customers
GET search/global
GET search/invoices
GET search/products
GET users/me/companies
POST auth/2fa/disable
POST auth/2fa/enable
POST auth/2fa/setup
POST auth/2fa/status
POST users/me/switch-company"
ACTUAL_NO_ROLE=$(python3 - "$SRC" <<'PY'
import re, glob, sys
src = sys.argv[1]
ROUTE = re.compile(r"@(Get|Post|Put|Patch|Delete)\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)")
out = set()
for f in sorted(glob.glob(f"{src}/**/*.controller.ts", recursive=True)):
    s = open(f, encoding="utf-8").read()
    code = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), s, flags=re.S)
    code = re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), code)
    ctrls = list(re.finditer(r"@Controller\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)", code))
    for ci, cm in enumerate(ctrls):
        cls_at = cm.end() + re.search(r"export\s+class\s+\w+", code[cm.end():]).start()
        prev = ctrls[ci - 1].end() if ci else 0
        head = code[max(code.rfind("\n}\n", prev, cm.start()), prev):cls_at]
        body = code[cls_at:(ctrls[ci + 1].start() if ci + 1 < len(ctrls) else len(code))]
        routes = list(ROUTE.finditer(body))
        for ri, r in enumerate(routes):
            base = routes[ri - 1].end() if ri else 0
            # a method body ends with a line that is exactly "  }"
            ends = list(re.finditer(r"\n  \}[ \t]*(?=\n)", body[base:r.start()]))
            lo = base + ends[-1].end() if ends else base
            m = re.search(r"\n\s*(?:async\s+)?\w+\s*\(", body[r.end():])
            deco = body[lo:r.end() + (m.start() if m else 0)]
            nxt = routes[ri + 1].start() if ri + 1 < len(routes) else len(body)
            if "@Public()" in head or "@Public()" in deco or "@Require(" in deco:
                continue
            if re.search(r"requireRole\(|UsersService\.can\(", body[r.end():nxt]):
                continue
            out.add(r.group(1).upper() + " " + "/".join(p for p in ((cm.group(1) or ""), (r.group(2) or "")) if p))
print("\n".join(sorted(out)))
PY
)
if [[ "$ACTUAL_NO_ROLE" == "$EXPECTED_NO_ROLE" ]]; then
  pass "only the reviewed self-service/search routes lack a role check (11)"
else
  fail "routes without a role check differ from the reviewed list:"
  diff <(echo "$EXPECTED_NO_ROLE") <(echo "$ACTUAL_NO_ROLE") | sed 's/^/      /'
fi

note "=== 2. set up tenant B and a viewer in company A ==="
STAMP=$(date +%s%N | cut -c1-13)
reg() { curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$1\",\"password\":\"Tier376-e2e\",\"companyName\":\"$2\"}"; }
BODY=$(reg "e2e-177-b-$STAMP@example.test" "e2e-177 Tenant B $STAMP")
B_USER=$(json_field "$BODY" user.id); B_COMPANY=$(json_field "$BODY" company.id)
BODY=$(reg "e2e-177-v-$STAMP@example.test" "e2e-177 Viewer home $STAMP")
V_USER=$(json_field "$BODY" user.id)
[[ -n "$B_USER" && -n "$B_COMPANY" && -n "$V_USER" ]] && pass "tenant B and the viewer registered" || { fail "register failed: $BODY"; summary; exit 1; }
sql "INSERT INTO \"UserCompany\" (\"userId\", \"companyId\", role) VALUES ('$V_USER', '$COMPANY_ID', 'viewer');" >/dev/null
assert_eq "viewer grant on company A" "$(sql "SELECT role FROM \"UserCompany\" WHERE \"userId\" = '$V_USER' AND \"companyId\" = '$COMPANY_ID';")" "viewer"

call() { # user company method path [body] [extra header] → STATUS/BODY
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "Content-Type: application/json" \
    -H "x-user-id: $1" -H "x-company-id: $2" ${6:+-H "$6"} ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}

note "=== 3. a viewer can read but not write ==="
Q="companyId=$COMPANY_ID"
call "$V_USER" "$COMPANY_ID" POST "/api/v1/accounting/accounts?$Q" '{"accountNumber":"9977","name":"e2e-177 viewer","type":"asset"}'
assert_status 403 "viewer POST /accounting/accounts (was 201)"
call "$V_USER" "$COMPANY_ID" POST "/api/v1/assets?$Q" '{"type":"Sonstiges","bezeichnung":"e2e-177 viewer","anschaffungsDatum":"2026-01-01","anschaffungsKosten":100,"nutzungsdauerMonate":12}'
assert_status 403 "viewer POST /assets (was 201)"
call "$V_USER" "$COMPANY_ID" POST "/api/v1/ocr/match-supplier?$Q" '{"name":"e2e-177 viewer supplier"}'
assert_status 403 "viewer POST /ocr/match-supplier (was 201)"
call "$V_USER" "$COMPANY_ID" PUT "/api/v1/mail/config?$Q" '{"smtpHost":"viewer.example","smtpUser":"u"}'
assert_status 403 "viewer PUT /mail/config (was 200)"
call "$V_USER" "$COMPANY_ID" POST "/api/v1/installment-plans?$Q" '{}'
assert_status 403 "viewer POST /installment-plans (@Require that never ran)"
assert_eq "no row written by the viewer" \
  "$(sql "SELECT (SELECT count(*) FROM \"Account\" WHERE name = 'e2e-177 viewer') + (SELECT count(*) FROM \"Asset\" WHERE bezeichnung = 'e2e-177 viewer') + (SELECT count(*) FROM \"Supplier\" WHERE name = 'e2e-177 viewer supplier');")" "0"
call "$V_USER" "$COMPANY_ID" GET "/api/v1/accounting/accounts?$Q";   assert_status 200 "viewer GET /accounting/accounts"
call "$V_USER" "$COMPANY_ID" GET "/api/v1/assets?$Q";                assert_status 200 "viewer GET /assets"
call "$V_USER" "$COMPANY_ID" GET "/api/v1/companies/$COMPANY_ID";    assert_status 200 "viewer GET /companies/:id"
# read-only mode lets the reads through (company.read was not allow-listed)
call "$USER_ID" "$COMPANY_ID" GET "/api/v1/companies/$COMPANY_ID" "" "x-readonly: 1"
assert_status 200 "read-only mode GET /companies/:id"
call "$USER_ID" "$COMPANY_ID" POST "/api/v1/accounting/accounts?$Q" '{"accountNumber":"9976","name":"e2e-177 readonly","type":"asset"}' "x-readonly: 1"
assert_status 403 "read-only mode POST /accounting/accounts"

note "=== 4. /companies/:id is bound to the tenant ==="
NAME_BEFORE=$(sql "SELECT name FROM \"Company\" WHERE id = '$COMPANY_ID';")
call "$B_USER" "$B_COMPANY" PUT "/api/v1/companies/$COMPANY_ID" '{"name":"e2e-177 OVERWRITE"}'
assert_status 403 "B PUT /companies/<A> (was 200)"
assert_eq "A's name unchanged" "$(sql "SELECT name FROM \"Company\" WHERE id = '$COMPANY_ID';")" "$NAME_BEFORE"
call "$B_USER" "$B_COMPANY" GET "/api/v1/companies/$COMPANY_ID";                 assert_status 403 "B GET /companies/<A> (was 200)"
call "$B_USER" "$B_COMPANY" GET "/api/v1/companies/$COMPANY_ID/datev-config";    assert_status 403 "B GET /companies/<A>/datev-config (was 200)"
call "$B_USER" "$B_COMPANY" GET "/api/v1/companies/$COMPANY_ID/feature-flags";   assert_status 403 "B GET /companies/<A>/feature-flags (was 200)"
call "$B_USER" "$B_COMPANY" GET "/api/v1/companies/$B_COMPANY";                  assert_status 200 "B GET its own company"

note "=== 5. VAT rates stay with their company ==="
call "$B_USER" "$B_COMPANY" POST "/api/v1/vat-rates" '{"countryCode":"ZX","rate":0.99,"rateType":"standard","name":"e2e-177 tenant B","effectiveFrom":"2025-01-01T00:00:00Z"}'
assert_status 201 "B creates a rate"
assert_eq "B's rate belongs to B" "$(json_field "$BODY" companyId)" "$B_COMPANY"
call "$USER_ID" "$COMPANY_ID" GET "/api/v1/vat-rates/current?countryCode=ZX"
[[ "$STATUS" == "200" && ${#BODY} -lt 5 ]] && pass "A does not see B's rate (null)" || fail "A saw B's rate: $STATUS $BODY"
call "$B_USER" "$B_COMPANY" GET "/api/v1/vat-rates/current?countryCode=ZX"
assert_eq "B sees its own rate" "$(json_field "$BODY" name)" "e2e-177 tenant B"

note "=== 6. cleanup ==="
sql "DELETE FROM \"VatRate\" WHERE name = 'e2e-177 tenant B';" >/dev/null
sql "DELETE FROM \"UserCompany\" WHERE \"userId\" = '$V_USER' AND \"companyId\" = '$COMPANY_ID';" >/dev/null
assert_eq "viewer grant removed" "$(sql "SELECT count(*) FROM \"UserCompany\" WHERE \"userId\" = '$V_USER' AND \"companyId\" = '$COMPANY_ID';")" "0"

summary
exit $?
