#!/bin/bash
# Tier 407 — every record that carries money has an audit trail
#
# The audit extension covered 18 models. Measured before the fix:
#   a 119 € cash payment recorded, then deleted      → three invoice.updated
#                                                       rows, nothing naming the
#                                                       payment, amount or actor
#   a member's role changed viewer → accountant      → no row at all (the
#                                                       service upserts, and the
#                                                       extension had no upsert)
#   registration / invitation acceptance             → usercompany.created rows
#                                                       with companyId NULL, so
#                                                       absent from the company's
#                                                       own trail
# Payment, Mahnung, instalments, customer credit, the Kassenabschluss, UStVA
# filings, voucher lines, bank reconciliation, SEPA, VAT rates, the company's
# master data and memberships had no trail and no explicit audit call either.
#
# Adding Company carried a risk that is asserted here too: before Tier 208 a
# company's PEM signing key lived in Company.settings, and the append-only,
# hash-chained audit table must never receive it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-196-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier407-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}

note "=== 1. a payment's life is on the record ==="
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":119,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"cash\"}"
P=$(json_field "$BODY" id)
[[ -n "$P" ]] && pass "fixture: a 119 € cash payment" || fail "payment: $BODY"
AS DELETE "/api/v1/invoices/$I/payments/$P?companyId=$C"
assert_status 200 "the payment is removed"
assert_eq "its trail: created, then deleted (was: nothing)" \
  "$(sql "SELECT string_agg(action, ',' ORDER BY seq) FROM \"AuditLog\" WHERE \"entityId\" = '$P';")" \
  "payment.created,payment.deleted"
assert_eq "…the deletion keeps the amount" \
  "$(sql "SELECT (\"oldData\"->>'amount')::numeric = 119 FROM \"AuditLog\" WHERE \"entityId\" = '$P' AND action = 'payment.deleted';")" "t"
assert_eq "…and who removed it" \
  "$(sql "SELECT \"userId\" FROM \"AuditLog\" WHERE \"entityId\" = '$P' AND action = 'payment.deleted';")" "$U"

note "=== 2. membership and role changes are on the company's record ==="
AS POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-m@example.test\",\"role\":\"viewer\"}"
INV=$(json_field "$BODY" id)
AS POST "/api/v1/users/invitations/$INV/resend?companyId=$C" "{}"
TOK=$(json_field "$BODY" tokenPlain)
M=$(curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOK\",\"password\":\"Tier407-member\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('userId',''))")
[[ -n "$M" ]] && pass "fixture: an invited member (viewer)" || fail "invitation accept"
AS PATCH "/api/v1/users/$M/role?companyId=$C" '{"role":"accountant"}'
assert_status 200 "the admin changes the member's role"
UC_ROWS() { sql "SELECT count(*) FROM \"AuditLog\" WHERE \"entityType\" = 'UserCompany' AND \"companyId\" = '$C' AND \"entityId\" = '$1:$C' $2;"; }
assert_eq "the owner's membership is in the company's trail (was: companyId NULL)" "$(UC_ROWS "$U" "AND action = 'usercompany.created'")" "1"
assert_eq "…so is the member's, from the public invitation route" "$(UC_ROWS "$M" "AND action = 'usercompany.created'")" "1"
assert_eq "the role change is recorded (was: no row — the service upserts)" \
  "$(sql "SELECT (\"oldData\"->>'role') || '>' || (\"newData\"->>'role') FROM \"AuditLog\" WHERE \"entityType\" = 'UserCompany' AND \"entityId\" = '$M:$C' AND action = 'usercompany.updated';")" \
  "viewer>accountant"
assert_eq "…made by the admin" \
  "$(sql "SELECT \"userId\" FROM \"AuditLog\" WHERE \"entityId\" = '$M:$C' AND action = 'usercompany.updated';")" "$U"

note "=== 3. company master data is audited without ever copying a private key ==="
# A company row from before Tier 208 can still carry its signing key in
# settings. Plant one, change an unrelated field, and look everywhere.
sql "UPDATE \"Company\" SET settings = jsonb_build_object(
       'signing', jsonb_build_object('cert', 'CERT-$TAG', 'key', E'-----BEGIN PRIVATE KEY-----\\nTIER407$TAG\\n-----END PRIVATE KEY-----'),
       'datev', jsonb_build_object('beraterNr', '4071'))
     WHERE id = '$C';" >/dev/null
AS PUT "/api/v1/companies/$C?companyId=$C" '{"phone":"+49 30 4070"}'
assert_status 200 "a company update"
assert_eq "it is audited" \
  "$(sql "SELECT count(*) > 0 FROM \"AuditLog\" WHERE \"entityType\" = 'Company' AND \"entityId\" = '$C' AND action = 'company.updated';")" "t"
assert_eq "the private key is nowhere in the audit table" \
  "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"oldData\"::text LIKE '%TIER407$TAG%' OR \"newData\"::text LIKE '%TIER407$TAG%';")" "0"
assert_eq "…its place holds the redaction marker" \
  "$(sql "SELECT \"oldData\"->'settings'->'signing'->>'key' FROM \"AuditLog\" WHERE \"entityId\" = '$C' AND action = 'company.updated' ORDER BY seq DESC LIMIT 1;")" "[REDACTED]"
assert_eq "…while the rest of the settings are kept" \
  "$(sql "SELECT \"oldData\"->'settings'->'datev'->>'beraterNr' FROM \"AuditLog\" WHERE \"entityId\" = '$C' AND action = 'company.updated' ORDER BY seq DESC LIMIT 1;")" "4071"
assert_eq "the company row itself is untouched by the redaction" \
  "$(sql "SELECT (settings->'signing'->>'key') LIKE '%TIER407$TAG%' FROM \"Company\" WHERE id = '$C';")" "t"

note "=== 4. the chain still verifies ==="
AS GET "/api/v1/audit-logs/verify?companyId=$C"
assert_status 200 "GET /audit-logs/verify"
assert_eq "chain ok" "$(json_field "$BODY" ok)" "True"

note "=== 5. no money-bearing model is written without a trail ==="
# A model with a Decimal column must be audited, or be listed here with the
# reason it is not. Adding a model means editing one of the two on purpose.
EXEMPT="ProductStockHistory VatRateHistory RecurringInvoiceItem Asset"
#   ProductStockHistory, VatRateHistory — append-only history tables themselves
#   RecurringInvoiceItem               — template lines, nothing is booked
#   Asset                              — assets.service writes explicit
#                                        writeActivity rows (Tier 368)
MISSING=$(python3 - "$SCRIPT_DIR/../prisma/schema.prisma" "$SCRIPT_DIR/../src/prisma/audit-log.extension.ts" "$EXEMPT" <<'PY'
import re, sys
schema = open(sys.argv[1], encoding="utf-8").read()
ext = open(sys.argv[2], encoding="utf-8").read()
block = ext[ext.index("const AUDITED_MODELS"):]
block = block[:block.index("])")]
audited = set(re.findall(r"'([A-Za-z]+)'", block))
exempt = set(sys.argv[3].split())
out = []
for m in re.finditer(r"^model (\w+) \{(.*?)^\}", schema, re.S | re.M):
    name, body = m.group(1), m.group(2)
    if re.search(r"^\s+\w+\s+Decimal", body, re.M) and name not in audited and name not in exempt:
        out.append(name)
print(" ".join(out))
PY
)
[[ -z "$MISSING" ]] && pass "every Decimal model is audited or exempt with a reason" \
  || fail "money-bearing models with no trail: $MISSING"
grep -q "async upsert(" "$SCRIPT_DIR/../src/prisma/audit-log.extension.ts" \
  && pass "the extension hooks upsert" || fail "no upsert hook"
grep -q "async createMany(" "$SCRIPT_DIR/../src/prisma/audit-log.extension.ts" \
  && pass "the extension hooks createMany" || fail "no createMany hook"

summary; exit $?
