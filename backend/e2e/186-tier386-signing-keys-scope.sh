#!/bin/bash
# Tier 386 — personal signing certificates are the caller's (or a member of the
# caller's company), and no response carries a private key
#
# Measured before the change, as a freshly registered tenant B against tenant
# A's user:
#   GET  /signing/user-cert-info?userId=<A's user>   → 200 with A's cert info
#   POST /signing/user-sign {"userId":<A's user>}     → 201, PDF signed with A's
#                                                       user's certificate (same fingerprint)
#   POST /signing/user-regenerate?userId=<A's user>   → 201, A's key rotated, and the
#                                                       response held the new
#                                                       "-----BEGIN RSA PRIVATE KEY-----"
#   POST /signing/regenerate (own company)            → the company private key in the response
#   user-sign with pdf "kein base64!" → 500; verify with pdf 123 → 500;
#   sign with an undeclared field → 201
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-186-$(date +%s%N | cut -c1-13)"

tenant() {
  curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier386-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r UA CA < <(tenant a)
read -r UB CB < <(tenant b)
[[ -n "${CA:-}" && -n "${CB:-}" ]] && pass "two tenants" || { fail "register failed"; summary; exit 1; }
TMPD=$(mktemp -d)
req() { # A|B method path [json-body-file]
  local u="$UA" c="$CA" resp
  [[ "$1" == B ]] && { u="$UB"; c="$CB"; }
  if [[ -n "${4:-}" ]]; then
    resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $u" -H "x-company-id: $c" -H "Content-Type: application/json" --data-binary "@$4")
  else
    resp=$(curl -sS -w "\n%{http_code}" -X "$2" "$API$3" -H "x-user-id: $u" -H "x-company-id: $c")
  fi
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
no_key() { # label
  [[ "$BODY" != *"PRIVATE KEY"* ]] && [[ -z "$(json_field "$BODY" key)" ]] && pass "$1: no private key in the response" || fail "$1: response contains a private key"
}
python3 - "$TMPD/p.pdf" <<'PY'
import sys
objs=[b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"]
out=b"%PDF-1.4\n"; offs=[]
for i,o in enumerate(objs,1):
    offs.append(len(out)); out+=b"%d 0 obj\n"%i+o+b"\nendobj\n"
x=len(out); out+=b"xref\n0 %d\n0000000000 65535 f \n"%(len(objs)+1)+b"".join(b"%010d 00000 n \n"%o for o in offs)
out+=b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"%(len(objs)+1,x)
open(sys.argv[1],"wb").write(out)
PY
B64=$(base64 < "$TMPD/p.pdf" | tr -d '\n')
# JSON bodies go through printf into files: \" inside $(...) keeps the backslash.
json_file() { # name format args...
  local name="$1" fmt="$2"; shift 2
  # shellcheck disable=SC2059
  printf "$fmt" "$@" > "$TMPD/$name.json"
}

note "=== 1. the caller's own certificate still works ==="
req A GET "/api/v1/signing/user-cert-info?userId=$UA"
assert_status 200 "A: own cert info"
FP_A=$(json_field "$BODY" fingerprint)
req A POST "/api/v1/signing/user-regenerate?userId=$UA"
assert_status 201 "A: rotates its own key"
no_key "user-regenerate"
FP_A2=$(json_field "$BODY" fingerprint)
[[ -n "$FP_A2" && "$FP_A2" != "$FP_A" ]] && pass "…new fingerprint" || fail "…fingerprint unchanged"
json_file us-a '{"userId":"%s","pdf":"%s"}' "$UA" "$B64"
req A POST /api/v1/signing/user-sign "$TMPD/us-a.json"
assert_status 201 "A: signs with its own certificate (PdfSignaturePanel shape)"
assert_eq "…with the current certificate" "$(json_field "$BODY" fingerprint)" "$FP_A2"
req A POST "/api/v1/signing/regenerate?companyId=$CA"
assert_status 201 "A: rotates the company key"
no_key "company regenerate"
[[ -n "$(json_field "$BODY" fingerprint)" ]] && pass "…fingerprint still returned" || fail "…no fingerprint"

note "=== 2. another company's user is out of reach ==="
req B GET "/api/v1/signing/user-cert-info?userId=$UA"
assert_status 404 "B: A's user's cert info (was 200)"
req B POST "/api/v1/signing/user-regenerate?userId=$UA"
assert_status 404 "B: rotate A's user's key (was 201 with the private key)"
no_key "B's rotate attempt"
req A GET "/api/v1/signing/user-cert-info?userId=$UA"
assert_eq "…A's fingerprint unchanged" "$(json_field "$BODY" fingerprint)" "$FP_A2"
json_file us-b '{"userId":"%s","pdf":"%s"}' "$UA" "$B64"
req B POST /api/v1/signing/user-sign "$TMPD/us-b.json"
assert_status 403 "B: sign with A's user's certificate (was 201)"
assert_eq "B's audit log has no rotation of A's user" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "SELECT count(*) FROM \"AuditLog\" WHERE action = 'signing.user_regenerate' AND \"entityId\" = '$UA' AND \"userId\" = '$UB';" 2>/dev/null)" "0"

note "=== 3. bodies ==="
json_file us-nb '{"userId":"%s","pdf":"kein base64!"}' "$UA"
req A POST /api/v1/signing/user-sign "$TMPD/us-nb.json"
assert_status 400 "user-sign: pdf not base64 (was 500)"
json_file v-num '{"pdf":123}'
req A POST /api/v1/signing/verify "$TMPD/v-num.json"
assert_status 400 "verify: pdf a number (was 500)"
json_file s-extra '{"companyId":"%s","pdf":"%s","extra":1}' "$CA" "$B64"
req A POST /api/v1/signing/sign "$TMPD/s-extra.json"
assert_status 400 "sign: undeclared field (was 201)"

rm -rf "$TMPD"
summary
exit $?
