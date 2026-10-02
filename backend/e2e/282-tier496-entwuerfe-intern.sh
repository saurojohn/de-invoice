#!/bin/bash
# Tier 496 — a draft stays internal
#
# A draft is not an invoice: it is not counted (UStVA, EÜR, OPOS) and may
# still change or be deleted. Measured before: the customer portal listed the
# customer's drafts with their amounts, opened them and served their PDF;
# and the PDF of a draft looked exactly like the issued invoice — nothing on
# it said "Entwurf".
#
# Now the portal shows issued documents only (a draft is 404 there), a draft
# gets no payment link, and its PDF carries "ENTWURF" (over the title and
# as a watermark).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-282-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier496-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
PUB() { # method path — no auth (portal)
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json")
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
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"kunde@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":$1,\"vatRate\":0.19}]}"; json_field "$BODY" id; }
ISSUED=$(inv 1000); AS PUT "/api/v1/invoices/$ISSUED/status?companyId=$C" '{"status":"sent"}'
DRAFT=$(inv 777)
AS POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$K\"}"
TOKEN=$(python3 -c "
import sys,json,urllib.parse as u
d=json.loads(sys.argv[1]); url=d.get('url','')
print(u.parse_qs(u.urlparse(url).query).get('token',[''])[0] or d.get('token',''))" "$BODY")
[[ -n "$TOKEN" ]] && pass "fixture: a portal session" || fail "portal session: $BODY"

note "=== the customer portal ==="
PUB GET "/api/v1/customer-portal/invoices?token=$TOKEN"
IDS=$(P "[i['id'] for i in (d if isinstance(d, list) else d.get('invoices', d.get('items', [])))]")
assert_eq "lists the issued invoice" "$(echo "$IDS" | grep -c "$ISSUED")" "1"
assert_eq "…but not the draft (was listed)" "$(echo "$IDS" | grep -c "$DRAFT")" "0"
PUB GET "/api/v1/customer-portal/invoice/$DRAFT?token=$TOKEN"
assert_eq "the draft's detail: 404 (was 200)" "$STATUS" "404"
PUB GET "/api/v1/customer-portal/invoice/$DRAFT/pdf?token=$TOKEN"
assert_eq "the draft's PDF: 404 (was served)" "$STATUS" "404"
PUB GET "/api/v1/customer-portal/invoice/$ISSUED?token=$TOKEN"
assert_eq "the issued one still opens" "$STATUS" "200"

note "=== no payment link for a draft ==="
AS POST "/api/v1/invoices/$DRAFT/generate-payment-link?companyId=$C" '{}'
assert_eq "refused (was minted)" "$STATUS" "400"
AS POST "/api/v1/invoices/$ISSUED/generate-payment-link?companyId=$C" '{}'
assert_eq "the issued invoice gets one" "$STATUS" "201"

note "=== the PDF of a draft says so ==="
curl -sS -o /tmp/t496d.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$DRAFT/pdf?companyId=$C&sign=false"
curl -sS -o /tmp/t496i.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$ISSUED/pdf?companyId=$C&sign=false"
assert_eq "draft: ENTWURF on it (was not)" "$(pdf_text /tmp/t496d.pdf | grep -c "ENTWURF")" "2"
assert_eq "issued: no ENTWURF" "$(pdf_text /tmp/t496i.pdf | grep -c "ENTWURF")" "0"

summary
