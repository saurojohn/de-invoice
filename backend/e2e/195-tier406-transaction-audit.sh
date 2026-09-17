#!/bin/bash
# Tier 406 — writes inside an interactive transaction are audited
#
# PrismaService copies the audit-extended client's model accessors onto itself
# but skipped every `$…` member, so `this.prisma.$transaction(async (tx) => …)`
# ran on PrismaService's own, unextended client and every write through `tx`
# bypassed the audit extension. Measured before the fix:
#   plain invoice create              → 1 AuditLog row
#   credit note (inside a tx)         → 0 rows
#   deleting a paid invoice           → invoice AND its 119 € payment gone,
#                                       audit trail ends at invoice.updated
# Eleven call sites were affected: credit notes, recurring invoices, customer
# credit, customer merges, instalment plans, portal payments, invitation
# acceptance, invoice deletion. (The array form of $transaction was audited.)
#
# Two neighbouring findings, fixed with it:
#   - an invoice with recorded payments could be deleted, payments included
#   - deleting the newest draft left a gap anyway: the SEQUENCE never went back,
#     so the book read 1, 3 — defeating the rule that only the newest may go
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-195-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
audit() { sql "SELECT coalesce(string_agg(action, ',' ORDER BY seq), '-') FROM \"AuditLog\" WHERE \"entityId\" = '$1';"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier406-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
newinv() {
  AS POST "/api/v1/invoices?companyId=$C" \
    "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
}

note "=== 1. a credit note — created inside a transaction — is audited ==="
newinv; I1=$(json_field "$BODY" id)
AS POST "/api/v1/invoices/$I1/credit-note?companyId=$C" '{"reason":"Tier 406"}'
CN=$(json_field "$BODY" id)
assert_eq "the credit note has its audit row (was none)" "$(audit "$CN")" "invoice.created"
assert_eq "…attributed to the user who made it" \
  "$(sql "SELECT \"userId\" FROM \"AuditLog\" WHERE \"entityId\" = '$CN' LIMIT 1;")" "$U"
assert_eq "…and to the company" \
  "$(sql "SELECT \"companyId\" FROM \"AuditLog\" WHERE \"entityId\" = '$CN' LIMIT 1;")" "$C"

note "=== 2. a recurring run — also a transaction — is audited ==="
AS POST "/api/v1/recurring-invoices?companyId=$C" \
  "{\"name\":\"$TAG monthly\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"2026-08-19\",\"items\":[{\"description\":\"Hosting\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}],\"sendEmail\":false}"
TPL=$(json_field "$BODY" id)
AS POST "/api/v1/recurring-invoices/$TPL/run?companyId=$C" "{}"
assert_status 201 "the recurring run fires"
GEN=$(sql "SELECT id FROM \"Invoice\" WHERE \"companyId\" = '$C' AND \"recurringInvoiceId\" = '$TPL' ORDER BY \"createdAt\" DESC LIMIT 1;")
[[ -n "$GEN" ]] && pass "fixture: the generated invoice" || fail "no generated invoice for the template"
assert_eq "the generated invoice has its audit row (was none)" "$(audit "$GEN")" "invoice.created"

note "=== 3. only committed writes are audited ==="
# The same wiring PrismaService uses, driven directly: a rollback must leave no
# row. Routing the transaction through the extended client alone did (measured:
# row gone, audit row present), because the extension writes on its own
# connection — hence the buffer that is flushed only after commit.
PROBE=$(cd "$SCRIPT_DIR/.." && npx ts-node scripts/probe-audit-transactions.ts 2>&1 | tail -1)
note "probe: $PROBE"
pj() { python3 -c "import sys,json;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$PROBE" "$1" 2>/dev/null; }
assert_eq "a committed transaction leaves one audit row" "$(pj committedRows)" "1"
assert_eq "a rolled-back write does not exist" "$(pj rolledBackRow)" "0"
assert_eq "…and leaves no audit row either" "$(pj rolledBackRows)" "0"
assert_eq "a nested transaction is written once, by the outermost" "$(pj nestedRows)" "1"

note "=== 4. an invoice with payments is not deleted ==="
newinv; I2=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I2/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I2/payments?companyId=$C" \
  "{\"amount\":119,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_status 201 "fixture: a 119 € payment"
AS DELETE "/api/v1/invoices/$I2?companyId=$C"
assert_status 403 "deleting the paid invoice is refused (was 200)"
[[ "$BODY" == *"Zahlungen"* ]] && pass "…with a message pointing at Storno" || fail "…unexpected body: $BODY"
assert_eq "the invoice is still there" "$(sql "SELECT count(*) FROM \"Invoice\" WHERE id = '$I2';")" "1"
assert_eq "…and so is the payment (was deleted with it)" \
  "$(sql "SELECT count(*) FROM \"Payment\" WHERE \"invoiceId\" = '$I2';")" "1"

note "=== 5. a deleted sent invoice is on the record, and its number stays retired ==="
# Whether a sent invoice may be deleted on its issue day at all is an open
# decision (HANDOFF §9 item 14); today it may. What must hold either way: the
# deletion is audited, and a number a customer may have seen is never reused.
newinv; I3=$(json_field "$BODY" id); N3=$(json_field "$BODY" invoiceNumber)
AS PUT "/api/v1/invoices/$I3/status?companyId=$C" '{"status":"sent"}'
AS DELETE "/api/v1/invoices/$I3?companyId=$C"
assert_status 200 "the newest sent invoice is deleted"
assert_eq "…and the deletion is audited (was not)" "$(audit "$I3")" "invoice.created,invoice.updated,invoice.deleted"
assert_eq "…with the deleted number in the before-image" \
  "$(sql "SELECT \"oldData\"->>'invoiceNumber' FROM \"AuditLog\" WHERE \"entityId\" = '$I3' AND action = 'invoice.deleted';")" "$N3"
newinv; N4=$(json_field "$BODY" invoiceNumber)
[[ "$N4" != "$N3" ]] && pass "the next invoice does not reuse $N3 (got $N4)" || fail "$N3 was handed out again"

note "=== 6. a deleted draft gives its number back ==="
newinv; D=$(json_field "$BODY" id); ND=$(json_field "$BODY" invoiceNumber)
AS DELETE "/api/v1/invoices/$D?companyId=$C"
assert_status 200 "the newest draft is deleted"
assert_eq "…audited" "$(audit "$D")" "invoice.created,invoice.deleted"
newinv; NEXT=$(json_field "$BODY" invoiceNumber)
assert_eq "the next invoice takes the draft's number (was: skipped it)" "$NEXT" "$ND"

note "=== 7. the audit chain still verifies ==="
# The buffered rows are written through the same hash-chained writer, after
# commit; a mis-ordered flush would show up here.
AS GET "/api/v1/audit-logs/verify?companyId=$C"
assert_status 200 "GET /audit-logs/verify"
assert_eq "chain ok" "$(json_field "$BODY" ok)" "True"

summary; exit $?
