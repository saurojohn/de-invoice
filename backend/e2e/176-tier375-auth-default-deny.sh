#!/bin/bash
# Tier 375 — authentication is default-deny, and a tenant can only name its
# own company
#
# Measured on a fresh stack before the change:
#   * 49 of 449 routes had no guard at all. With NO credentials, only a
#     companyId: GET /accounting/accounts and /accounting/vouchers returned
#     the chart of accounts and every Buchungsbeleg (200), POST
#     /accounting/accounts created an account (201), POST /ocr/match-supplier
#     created a supplier (201), GET /mail/config returned the SMTP host and
#     user, and PUT /mail/config (which keeps the stored password when the
#     field is empty — so a changed host receives it), the voucher
#     reversal / status / generate routes and PUT /inventory/:id/adjust
#     reached their handlers (404 only because the probe used a dummy id).
#   * Any authenticated user could name another company: a freshly
#     registered tenant B, sending its own headers with ?companyId=<A>, got
#     200 with A's invoices and customers. The guard checked x-company-id;
#     the handlers used the query string. The ~20 existing "cross-tenant"
#     assertions all send a wrong x-company-id header, never a wrong query
#     string, which is why this was never caught.
#
# Now HeaderAuthGuard is an APP_GUARD (routes opt out with @Public()), and it
# rejects a companyId in the path, query or body that is not the
# authenticated company (403). @AllowOtherCompanyId() exempts switch-company,
# which checks the grant itself.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
SRC="$SCRIPT_DIR/../src"

note "=== 1. static: the guard is global and the public routes are exactly these ==="
if grep -qE "provide: APP_GUARD, useClass: HeaderAuthGuard" "$SRC/app.module.ts"; then
  pass "HeaderAuthGuard is registered as APP_GUARD"
else
  fail "HeaderAuthGuard is not registered as APP_GUARD in app.module.ts"
fi

# Adding a public route must be a deliberate edit of this list.
EXPECTED_PUBLIC="GET customer-portal/invoice/:id
GET customer-portal/invoice/:id/pdf
GET customer-portal/invoices
GET customer-portal/profile
GET health
GET health/deep
GET invitations/verify
GET metrics
GET portal/:token
GET system/health
GET system/health/deep
PATCH customer-portal/profile
POST auth/2fa/verify
POST auth/forgot-password
POST auth/login
POST auth/register
POST auth/reset-password
POST customer-portal/invoice/:id/mark-paid
POST customer-portal/request-session
POST invitations/accept
POST portal/:token/mark-paid
POST system/errors"

ROUTES_JSON=$(python3 - "$SRC" <<'PY'
import re, glob, os, json, sys
src = sys.argv[1]
ROUTE = re.compile(r"@(Get|Post|Put|Patch|Delete)\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)")
rows = []
for f in sorted(glob.glob(f"{src}/**/*.controller.ts", recursive=True)):
    s = open(f, encoding="utf-8").read()
    # blank out comments so a decorator named in a comment does not count
    code = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), s, flags=re.S)
    code = re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), code)
    ctrls = list(re.finditer(r"@Controller\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)", code))
    for ci, cm in enumerate(ctrls):
        cls = re.search(r"export\s+class\s+\w+", code[cm.end():])
        cls_at = cm.end() + cls.start()
        prev_end = ctrls[ci - 1].end() if ci else 0
        head_start = max(code.rfind("\n}\n", prev_end, cm.start()), prev_end)
        cls_public = "@Public()" in code[head_start:cls_at]
        body_end = ctrls[ci + 1].start() if ci + 1 < len(ctrls) else len(code)
        body = code[cls_at:body_end]
        routes = list(ROUTE.finditer(body))
        for ri, r in enumerate(routes):
            # this method's decorators: from the end of the previous method's
            # body to the method name. A method body ends with a line that is
            # exactly "  }"; a bare '}' would also match the object literal in
            # @Throttle({ default: { ... } }) and cut off an @Public() above it.
            ends = list(re.finditer(r"\n  \}[ \t]*(?=\n)", body[(routes[ri - 1].end() if ri else 0):r.start()]))
            lo = ((routes[ri - 1].end() if ri else 0) + ends[-1].end()) if ends else (routes[ri - 1].end() if ri else 0)
            m = re.search(r"\n\s*(?:async\s+)?\w+\s*\(", body[r.end():])
            hi = r.end() + (m.start() if m else 0)
            deco = body[lo:hi]
            path = "/".join(p for p in ((cm.group(1) or ""), (r.group(2) or "")) if p)
            rows.append({"method": r.group(1).upper(), "path": path,
                         "public": cls_public or "@Public()" in deco,
                         "at": f"{os.path.relpath(f, src)}:{code.count(chr(10), 0, cls_at + r.start()) + 1}"})
print(json.dumps(rows))
PY
)
ROUTE_COUNT=$(python3 -c "import json,sys;print(len(json.loads(sys.argv[1])))" "$ROUTES_JSON")
[[ "$ROUTE_COUNT" -gt 400 ]] && pass "route inventory parsed ($ROUTE_COUNT routes)" || fail "route inventory looks wrong: $ROUTE_COUNT routes"
ACTUAL_PUBLIC=$(python3 -c "import json,sys;print('\n'.join(sorted({r['method']+' '+r['path'] for r in json.loads(sys.argv[1]) if r['public']})))" "$ROUTES_JSON")
if [[ "$ACTUAL_PUBLIC" == "$EXPECTED_PUBLIC" ]]; then
  pass "@Public() routes match the reviewed list (22)"
else
  fail "@Public() routes differ from the reviewed list:"
  diff <(echo "$EXPECTED_PUBLIC") <(echo "$ACTUAL_PUBLIC") | sed 's/^/      /'
fi

note "=== 2. runtime: every other route answers 401 without credentials ==="
# Mutations that could leave the box (bank, ELSTER, mail) or act on the host
# are not fired here; section 1 already proves they are not public, and the
# guard is global.
SWEEP=$(python3 - "$API" "$ROUTES_JSON" <<'PY'
import json, re, sys, urllib.request, urllib.error
api, rows = sys.argv[1], json.loads(sys.argv[2])
RISKY = re.compile(r"fints|elster|send|mail|smtp|backup|restore|restart|shutdown|cron|run|import|submit|test|deliver|replay|requeue|seed|reset|prune", re.I)
fired = bad = 0
for r in rows:
    if r["public"] or (r["method"] != "GET" and RISKY.search(r["path"])):
        continue
    url = f"{api}/api/v1/" + re.sub(r":[A-Za-z0-9_]+", "00000000-0000-0000-0000-000000000000", r["path"])
    data = b"{}" if r["method"] != "GET" else None
    req = urllib.request.Request(url, data=data, method=r["method"], headers={"Content-Type": "application/json"})
    try:
        code = urllib.request.urlopen(req, timeout=15).status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:
        code = f"error:{type(e).__name__}"
    fired += 1
    if code != 401:
        bad += 1
        print(f"NOT401 {code} {r['method']} /{r['path']} ({r['at']})")
print(f"SUMMARY {fired} {bad}")
PY
)
read -r _ FIRED BAD <<< "$(echo "$SWEEP" | grep '^SUMMARY')"
echo "$SWEEP" | grep '^NOT401' | sed 's/^/      /'
[[ "${FIRED:-0}" -gt 300 ]] && pass "fired $FIRED non-public routes without credentials" || fail "sweep fired only ${FIRED:-0} routes"
assert_eq "non-public routes answering anything but 401" "${BAD:-?}" "0"

note "=== 3. the routes that were open before (measured) ==="
for spec in "GET /api/v1/accounting/accounts" "GET /api/v1/accounting/vouchers" "POST /api/v1/accounting/accounts" \
            "POST /api/v1/ocr/match-supplier" "GET /api/v1/mail/config" "PUT /api/v1/mail/config" \
            "PUT /api/v1/inventory/00000000-0000-0000-0000-000000000000/adjust" "POST /api/v1/vat-rates"; do
  m=${spec%% *}; u=${spec#* }
  code=$(curl -s -o /dev/null -w "%{http_code}" -X "$m" "$API$u?companyId=$COMPANY_ID" -H "Content-Type: application/json" -d '{}')
  assert_eq "$spec without credentials" "$code" "401"
done

note "=== 4. public routes still work without credentials ==="
code=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/health");                                          assert_eq "GET /health" "$code" "200"
BODY=$(curl -s -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
[[ -n "$(json_field "$BODY" id)" ]] && pass "POST /auth/login with the seed user" || fail "login failed: $BODY"
code=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/customer-portal/invoices");                        assert_eq "GET /customer-portal/invoices without token (400, not 401)" "$code" "400"

note "=== 5. a tenant can only name its own company ==="
STAMP=$(date +%s%N | cut -c1-13)
BODY=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"e2e-176-$STAMP@example.test\",\"password\":\"TenantB-2026\",\"companyName\":\"e2e-176 Tenant B $STAMP\"}")
B_USER=$(json_field "$BODY" user.id); B_COMPANY=$(json_field "$BODY" company.id)
[[ -n "$B_USER" && -n "$B_COMPANY" ]] && pass "tenant B registered" || { fail "register failed: $BODY"; summary; exit 1; }

as_b() { # method path [body] → sets STATUS/BODY
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json" \
    -H "x-user-id: $B_USER" -H "x-company-id: $B_COMPANY" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
as_b GET "/api/v1/invoices?companyId=$COMPANY_ID&pageSize=1";    assert_status 403 "B reads A's invoices via ?companyId (was 200)"
as_b GET "/api/v1/customers?companyId=$COMPANY_ID&pageSize=1";   assert_status 403 "B reads A's customers via ?companyId (was 200)"
as_b GET "/api/v1/invoices?companyId=$B_COMPANY&companyId=$COMPANY_ID"; assert_status 403 "repeated ?companyId (array) is refused"
as_b POST "/api/v1/payments/batches?companyId=$B_COMPANY" "{\"companyId\":\"$COMPANY_ID\",\"expenseIds\":[],\"executionDate\":\"2026-10-01\"}"
assert_status 403 "A's companyId in the body is refused"
as_b GET "/api/v1/invoices?companyId=$B_COMPANY&pageSize=1";     assert_status 200 "B reads its own invoices"
api_get "/api/v1/invoices?companyId=$COMPANY_ID&pageSize=1";     assert_status 200 "A reads its own invoices"
# Record-level scoping still holds with the tenant's OWN companyId: B's
# supplier is not visible to A (404, as the services have always answered).
as_b POST "/api/v1/suppliers?companyId=$B_COMPANY" "{\"name\":\"e2e-176 B supplier $STAMP\"}"
assert_status 201 "B creates a supplier"
B_SUPPLIER=$(json_field "$BODY" id)
api_get "/api/v1/suppliers/$B_SUPPLIER?companyId=$COMPANY_ID"
assert_status 404 "A fetching B's supplier with A's own companyId → 404"
# The header check from before is unchanged.
code=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v1/invoices?companyId=$COMPANY_ID" -H "x-user-id: $B_USER" -H "x-company-id: $COMPANY_ID")
assert_eq "B claiming A in x-company-id" "$code" "401"

note "=== 6. switch-company may name another company, and still checks the grant ==="
api_post "/api/v1/users/me/switch-company" "{\"companyId\":\"$B_COMPANY\"}"
assert_status 403 "A switching to B without a grant"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "INSERT INTO \"UserCompany\" (\"userId\", \"companyId\", role) VALUES ('$USER_ID', '$B_COMPANY', 'accountant');" >/dev/null
api_post "/api/v1/users/me/switch-company" "{\"companyId\":\"$B_COMPANY\"}"
assert_status 201 "A switching to B with a grant"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -c \
  "DELETE FROM \"UserCompany\" WHERE \"userId\" = '$USER_ID' AND \"companyId\" = '$B_COMPANY';" >/dev/null
assert_eq "temporary grant removed" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "SELECT count(*) FROM \"UserCompany\" WHERE \"userId\" = '$USER_ID' AND \"companyId\" = '$B_COMPANY';" | tr -d ' ')" "0"

summary
exit $?
