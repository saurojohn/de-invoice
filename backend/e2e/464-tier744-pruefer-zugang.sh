#!/bin/bash
# Tier 744 — a tax auditor's access (role "auditor")
#
# § 147 Abs. 6 AO: an auditor may read the books in the system (Z1). The only
# role for it was `viewer`, which cannot see the UStVA or the audit log, and the
# client's read-only switch is no boundary. Now:
#   1. the role is invited with a last day: required, at most a year;
#   2. it reads the books, the UStVA and the audit log, and the GoBD archives;
#   3. not the users, the operator's pages, the notes to the Berater;
#   4. it writes nothing: EVERY writing route answers 403, without any header;
#   5. the access ends on its day, an admin can extend it;
#   6. the role is no member: a sole admin can still leave the company.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-464-$(date +%s%N | cut -c1-13)"
LOG=/tmp/backend.log
SRC="$SCRIPT_DIR/../src"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier744-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE811907980
AS() { # user method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $1" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-d "$4"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
day() { python3 -c "import datetime,sys;print((datetime.date.today()+datetime.timedelta(days=int(sys.argv[1]))).isoformat())" "$1"; }
UNTIL=$(day 60)
# a little to read
CUST="{\"name\":\"Kunde\",\"type\":\"business\",\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
AS "$U" POST "/api/v1/customers?companyId=$C" "$CUST"
K=$(json_field "$BODY" id)
INV="{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS "$U" POST "/api/v1/invoices?companyId=$C" "$INV"
I=$(json_field "$BODY" id)
AS "$U" PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'

note "=== 1. the invitation has a last day ==="
invite() { # [accessUntil]
  local body="{\"email\":\"$TAG-a@example.test\",\"role\":\"auditor\"${1:+,\"accessUntil\":\"$1\"}}"
  AS "$U" POST "/api/v1/users/invitations?companyId=$C" "$body"
}
invite
assert_eq "without a last day: 400" "$STATUS/$(P "'Enddatum' in d['message']")" "400/True"
invite "$(day -1)"
assert_eq "a day past: 400" "$STATUS" "400"
invite "$(day 400)"
assert_eq "more than a year: 400" "$STATUS/$(P "'höchstens ein Jahr' in d['message']")" "400/True"
invite "2026-02-31"
assert_eq "no such day: 400" "$STATUS" "400"
invite "$UNTIL"
assert_eq "60 days: invited" "$STATUS" "201"
ITOKEN=$(grep -o "register?invite=[A-Za-z0-9_-]*" "$LOG" | tail -1 | cut -d= -f2)
ACCEPT="{\"token\":\"$ITOKEN\",\"password\":\"Tier744-pruef1\"}"
A=$(curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" -d "$ACCEPT" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('userId',''))")
[[ -n "$A" ]] && pass "fixture: the auditor accepted" || fail "accept"
AS "$A" GET /api/v1/auth/me
assert_eq "/auth/me: the role and the last day" "$(P "(d['role'], d['accessUntil'][:10])")" "('auditor', '$UNTIL')"
AS "$U" GET "/api/v1/users?companyId=$C"
assert_eq "the user list shows it" "$(P "[u['accessUntil'][:10] for u in (d['users'] if isinstance(d, dict) else d) if u['role']=='auditor']")" "['$UNTIL']"

note "=== 2. it reads the books, the UStVA and the audit log ==="
for path in "invoices" "expenses" "customers" "accounting/vouchers" "accounting/accounts" "ustva/filings" "audit-logs" "audit-logs/verify" "reports/dashboard" ; do
  AS "$A" GET "/api/v1/$path?companyId=$C"
  [[ "$STATUS" == "200" ]] && pass "GET $path: 200" || { [[ "$STATUS" == "404" ]] && note "GET $path: no such route" || fail "GET $path: $STATUS"; }
done
AS "$A" GET "/api/v1/invoices/$I?companyId=$C"
assert_eq "an invoice" "$STATUS" "200"
assert_eq "the GoBD export (viewer: 403)" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/gobd-export?companyId=$C&year=$(date +%Y)" -H "x-user-id: $A" -H "x-company-id: $C")" "200"
assert_eq "the GoBD archive" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/accounting/gobd-archive?companyId=$C&year=$(date +%Y)" -H "x-user-id: $A" -H "x-company-id: $C")" "200"

note "=== 3. not what is none of its business ==="
AS "$A" GET "/api/v1/users?companyId=$C"
assert_eq "the users: 403" "$STATUS" "403"
AS "$A" GET "/api/v1/admin/cron-health?companyId=$C"
assert_eq "the operator's pages: 403" "$STATUS" "403"
AS "$A" GET "/api/v1/invoices/$I/internal-notes?companyId=$C"
assert_eq "the invoice's internal notes: 403" "$STATUS" "403"

note "=== 4. it writes nothing, on any route ==="
RESULT=$(python3 - "$API" "$SRC" "$A" "$C" <<'PY'
import glob, json, re, sys, urllib.request, urllib.error
api, src, user, company = sys.argv[1:5]
ROUTE = re.compile(r"@(Post|Put|Patch|Delete)\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)")
# what the read-only rule lets through on purpose (roles.guard.ts); public routes have no user
ALLOWED = re.compile(r"^(auth/|users/me/switch-company|system/errors|ocr/scan|invoices/bulk-download|note-templates/:\w+/preview|invitations/|portal/|customer-portal/(request-session|profile|invoice/:id/mark-paid))")
UNSAFE = re.compile(r"restart|shutdown|restore")
fired, wrong = 0, []
for f in sorted(glob.glob(f"{src}/**/*.controller.ts", recursive=True)):
    s = open(f, encoding="utf-8").read()
    code = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), s, flags=re.S)
    code = re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), code)
    ctrls = list(re.finditer(r"@Controller\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)", code))
    for ci, cm in enumerate(ctrls):
        end = ctrls[ci + 1].start() if ci + 1 < len(ctrls) else len(code)
        for r in ROUTE.finditer(code[cm.end():end]):
            path = "/".join(p for p in ((cm.group(1) or ""), (r.group(2) or "")) if p)
            if ALLOWED.search(path) or UNSAFE.search(path):
                continue
            url = f"{api}/api/v1/" + re.sub(r"\*\w+", "x", re.sub(r":\w+", "00000000-0000-0000-0000-000000000000", path)) + f"?companyId={company}"
            req = urllib.request.Request(url, data=b"{}", method=r.group(1).upper(), headers={
                "Content-Type": "application/json", "x-user-id": user, "x-company-id": company})
            try:
                code_ = urllib.request.urlopen(req, timeout=15).status
            except urllib.error.HTTPError as e:
                code_ = e.code
            except Exception as e:
                code_ = type(e).__name__
            fired += 1
            if code_ != 403:
                wrong.append(f"{r.group(1).upper()} {path} {code_}")
print(fired, json.dumps(wrong[:8]))
PY
)
[[ "${RESULT%% *}" -gt 200 ]] && pass "fired ${RESULT%% *} writing routes as the auditor" || fail "the sweep found too few routes: $RESULT"
assert_eq "every one answered 403" "${RESULT#* }" "[]"
AS "$A" POST "/api/v1/customers?companyId=$C" "$CUST"
assert_eq "…and says why, not as an internal action name" "$STATUS/$(P "d['message']")" "403/Ein Prüferzugang kann nur lesen."
assert_eq "nothing was written" "$(q "SELECT count(*) FROM \"Customer\" WHERE \"companyId\"='$C';")" "1"

note "=== 5. the access ends on its day; an admin can extend it ==="
q "UPDATE \"UserCompany\" SET \"accessUntil\"=now() - interval '1 minute' WHERE \"userId\"='$A';" >/dev/null
AS "$A" GET "/api/v1/invoices?companyId=$C"
assert_eq "past the day: 403, says so" "$STATUS/$(P "'abgelaufen' in d['message']")" "403/True"
AS "$U" PATCH "/api/v1/users/$A/role?companyId=$C" '{"role":"auditor"}'
assert_eq "an extension needs a day too" "$STATUS" "400"
EXT="{\"role\":\"auditor\",\"accessUntil\":\"$(day 30)\"}"
AS "$U" PATCH "/api/v1/users/$A/role?companyId=$C" "$EXT"
assert_eq "extended" "$STATUS" "200"
AS "$A" GET "/api/v1/invoices?companyId=$C"
assert_eq "…and it reads again" "$STATUS" "200"

note "=== 6. the role is no member ==="
AS "$U" GET /api/v1/auth/delete-account/check
assert_eq "the sole admin beside an auditor is the company's only member: closes, not blocked" \
  "$(P "(d['blockers'], [c['companyId'] for c in d['closes']])")" "([], ['$C'])"
AS "$U" PATCH "/api/v1/users/$A/role?companyId=$C" '{"role":"viewer"}'
assert_eq "another role has no last day" "$STATUS/$(q "SELECT \"accessUntil\" IS NULL FROM \"UserCompany\" WHERE \"userId\"='$A';")" "200/t"

summary
