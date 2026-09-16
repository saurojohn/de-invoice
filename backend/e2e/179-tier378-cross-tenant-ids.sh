#!/bin/bash
# Tier 378 — a tenant cannot reach another company's records by id
#
# Tiers 375/376 bound `companyId` to the authenticated company; the record id
# in the path was still looked up by id alone in several services. Measured
# on a fresh stack, tenant B (registered, admin of its own empty company)
# using company A's ids, with B's own companyId:
#   GET  /berater/notes/:id                         200 — A's note
#   GET  /inventory/:productId                      200 — A's product and stock
#   PUT  /inventory/:productId/adjust               200 — A's stock set to 42
#   GET  /payments/batches/:id  (+ /xml)            200 — A's SEPA batch, pain.001 XML
#   GET  /payments/direct-debit/batches/:id (+ /xml) 200 — debtors' IBANs, pain.008 XML
#   PUT  /invoices/:id/status                       200 — A's invoice updated; audit row under B
#   DELETE /reports/cost-center-budgets/:id         200 — A's budget deleted
#   POST /system/errors/:id/resolve | /mute         201 — A's error event changed
#   POST /customers/:id/credit-adjust               201 — credit transaction on A's customer
# and, not leaks but wrong codes for a foreign/unknown id: voucher PDF,
# XRechnung, ZUGFeRD, reminder email-data (500), PATCH/DELETE /webhooks/:id
# (Prisma P2025 → 500).
#
# Section 1 is the generic guard: every GET route that takes a record id is
# called by B with A's ids and must not answer 2xx with A's data.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
SRC="$SCRIPT_DIR/../src"
A="$COMPANY_ID"
STAMP=$(date +%s%N | cut -c1-13)
TAG="e2e-179-$STAMP"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }
TODAY=$(date +%Y-%m-%d)

note "=== 0. fixtures in company A, tenant B ==="
CUST=$(sql "SELECT id FROM \"Customer\" WHERE \"companyId\" = '$A' ORDER BY \"createdAt\" LIMIT 1;")
api_post "/api/v1/invoices?companyId=$A" "{\"customerId\":\"$CUST\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"$TAG\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}"
INV=$(json_field "$BODY" id)
api_put "/api/v1/invoices/$INV/status?companyId=$A" '{"status":"sent"}'
assert_status 200 "A sets its own invoice to sent"
api_post "/api/v1/reports/cost-center-budgets?companyId=$A" "{\"year\":2032,\"costCenter\":\"E2E179\",\"monthlyTargets\":[0,0,0,0,0,0,0,0,0,0,0,0]}"
BUDGET=$(json_field "$BODY" id)
api_post "/api/v1/payments/mandates?companyId=$A" "{\"companyId\":\"$A\",\"customerId\":\"$CUST\",\"dateOfSignature\":\"2026-07-20\",\"type\":\"CORE\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"debitorName\":\"$TAG Kunde\"}"
MANDATE=$(json_field "$BODY" id)
EXEC=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=10)).isoformat())")
api_post "/api/v1/payments/direct-debit/batches?companyId=$A" "{\"companyId\":\"$A\",\"collections\":[{\"invoiceId\":\"$INV\",\"mandateId\":\"$MANDATE\"}],\"executionDate\":\"$EXEC\",\"notes\":\"$TAG\"}"
DD_BATCH=$(json_field "$BODY" id)
curl -s -o /dev/null -X POST "$API/api/v1/system/errors" -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $A" -d "{\"message\":\"$TAG error\",\"source\":\"frontend\"}"
ERR=$(sql "SELECT id FROM \"ErrorEvent\" WHERE \"companyId\" = '$A' AND message LIKE '%$TAG%' LIMIT 1;")
PRODUCT=$(sql "SELECT id FROM \"Product\" WHERE \"companyId\" = '$A' ORDER BY \"createdAt\" LIMIT 1;")
NOTE=$(sql "SELECT id FROM \"BeraterNote\" WHERE \"companyId\" = '$A' LIMIT 1;")
SEPA=$(sql "SELECT id FROM \"SepaBatch\" WHERE \"companyId\" = '$A' LIMIT 1;")
VOUCHER=$(sql "SELECT id FROM \"Voucher\" WHERE \"companyId\" = '$A' LIMIT 1;")
WEBHOOK=$(sql "SELECT id FROM \"Webhook\" WHERE \"companyId\" = '$A' LIMIT 1;")
for v in INV BUDGET MANDATE DD_BATCH ERR PRODUCT; do
  [[ -n "${!v}" ]] && pass "fixture $v" || fail "fixture $v missing"
done
BODY=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier378-e2e\",\"companyName\":\"$TAG Tenant B\"}")
B_USER=$(json_field "$BODY" user.id); B_COMPANY=$(json_field "$BODY" company.id)
[[ -n "$B_USER" && -n "$B_COMPANY" ]] && pass "tenant B registered" || { fail "register failed"; summary; exit 1; }
as_b() { # method path [body] → STATUS/BODY
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "Content-Type: application/json" \
    -H "x-user-id: $B_USER" -H "x-company-id: $B_COMPANY" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
QB="companyId=$B_COMPANY"

note "=== 1. every GET route with a record id: B gets none of A's data ==="
SWEEP_PY=$(mktemp /tmp/e2e-179-sweep.XXXXXX)
cat > "$SWEEP_PY" <<'PY'
import re, glob, json, subprocess, sys, urllib.request, urllib.error
src, api, A, BU, BC, pg = sys.argv[1:7]
def one(table):
    out = subprocess.run(["docker", "exec", pg, "psql", "-U", "de_invoice", "-d", "de_invoice", "-tA", "-c",
        f'SELECT id FROM "{table}" WHERE "companyId" = \'{A}\' LIMIT 1'], capture_output=True, text=True).stdout.strip()
    return out.splitlines()[0].strip() if out else None
MAP = {"assets": "Asset", "attachments": "Attachment", "audit-logs": "AuditLog", "bank-statements": "BankStatement",
       "close-day": "CashBookDailyClose", "customers": "Customer", "deliveries": "WebhookDelivery", "emails": "EmailSend",
       "entries": "CashBookEntry", "expenses": "Expense", "filings": "UStvaFiling", "invoices": "Invoice",
       "by-invoice": "Invoice", "from-invoice": "Invoice", "reminders": "Invoice", "suggestion": "Invoice",
       "for-customer": "Customer", "installment-plans": "InstallmentPlan", "inventory": "Product",
       "invoice-templates": "InvoiceTemplate", "mahnungen": "Mahnung", "mahnungspausen": "Mahnungspause",
       "note-templates": "NoteTemplate", "notes": "BeraterNote", "products": "Product", "recurring-invoices": "RecurringInvoice",
       "suppliers": "Supplier", "voucher-templates": "VoucherTemplate", "vouchers": "Voucher", "webhooks": "Webhook"}
ids, routes = {}, set()
for f in glob.glob(f"{src}/**/*.controller.ts", recursive=True):
    s = open(f).read()
    ctrls = list(re.finditer(r"@Controller\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)", s))
    for ci, cm in enumerate(ctrls):
        body = s[cm.end():(ctrls[ci + 1].start() if ci + 1 < len(ctrls) else len(s))]
        for r in re.finditer(r"@Get\(\s*['\"]([^'\"]*)['\"]\s*\)", body):
            path = "/".join(p for p in ((cm.group(1) or ""), r.group(1)) if p)
            if ":" in path and not path.startswith(("portal", "customer-portal", "companies", "admin", "fints")):
                routes.add(path)
fired = leaks = skipped = 0
for path in sorted(routes):
    segs, sub, ok = path.split("/"), [], True
    for i, sg in enumerate(segs):
        if not sg.startswith(":"):
            sub.append(sg); continue
        prev = segs[i - 1] if i else ""
        if prev == "batches":
            table = "SepaDirectDebitBatch" if "direct-debit" in path else "SepaBatch"
        else:
            table = MAP.get(prev)
        if table and table not in ids:
            ids[table] = one(table)
        if not table or not ids.get(table):
            ok = False; break
        sub.append(ids[table])
    if not ok:
        skipped += 1; continue
    req = urllib.request.Request(f"{api}/api/v1/" + "/".join(sub) + f"?companyId={BC}",
                                 headers={"x-user-id": BU, "x-company-id": BC})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            status, text = r.status, r.read(20000).decode(errors="replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, ""
    except Exception as e:
        status, text = f"ERR:{type(e).__name__}", ""
    fired += 1
    ids_in_path = [v for v in sub if len(v) >= 32]
    if isinstance(status, int) and 200 <= status < 300 and (A in text or any(v in text for v in ids_in_path) or "<Document" in text):
        leaks += 1
        print(f"LEAK {status} GET /{path}")
print(f"SUMMARY {fired} {leaks} {skipped}")
PY
SWEEP=$(python3 "$SWEEP_PY" "$SRC" "$API" "$A" "$B_USER" "$B_COMPANY" "$PG_CONTAINER")
rm -f "$SWEEP_PY"
read -r _ FIRED LEAKS SKIPPED <<< "$(echo "$SWEEP" | grep '^SUMMARY')"
echo "$SWEEP" | grep '^LEAK' | sed 's/^/      /'
[[ "${FIRED:-0}" -gt 40 ]] && pass "fired $FIRED id routes as tenant B ($SKIPPED without a fixture)" || fail "sweep fired only ${FIRED:-0}"
assert_eq "GET routes that returned company A's data to tenant B" "${LEAKS:-?}" "0"

note "=== 2. the measured reads ==="
as_b GET "/api/v1/berater/notes/$NOTE?$QB"
[[ -z "$NOTE" ]] && note "no berater note in A — skipped" || assert_status 404 "B GET A's berater note (was 200)"
as_b GET "/api/v1/inventory/$PRODUCT?$QB"
[[ "$STATUS" == "200" && ${#BODY} -lt 5 ]] && pass "B GET A's product stock → empty (was A's product)" || fail "B saw A's stock: $STATUS $BODY"
as_b GET "/api/v1/payments/direct-debit/batches/$DD_BATCH?$QB";      assert_status 400 "B GET A's direct-debit batch (was 200 with IBANs)"
as_b GET "/api/v1/payments/direct-debit/batches/$DD_BATCH/xml?$QB";  assert_status 400 "B GET A's pain.008 XML (was 200)"
if [[ -n "$SEPA" ]]; then
  as_b GET "/api/v1/payments/batches/$SEPA?$QB";      assert_status 400 "B GET A's SEPA batch (was 200)"
  as_b GET "/api/v1/payments/batches/$SEPA/xml?$QB";  assert_status 400 "B GET A's pain.001 XML (was 200)"
fi

note "=== 3. the measured writes change nothing in A ==="
STOCK_BEFORE=$(sql "SELECT \"stockQuantity\" FROM \"Product\" WHERE id = '$PRODUCT';")
as_b PUT "/api/v1/inventory/$PRODUCT/adjust?$QB" '{"changeType":"adjustment","quantity":42}'
assert_status 404 "B adjusts A's stock (was 200)"
assert_eq "A's stock unchanged" "$(sql "SELECT \"stockQuantity\" FROM \"Product\" WHERE id = '$PRODUCT';")" "$STOCK_BEFORE"
STATUS_BEFORE=$(sql "SELECT status FROM \"Invoice\" WHERE id = '$INV';")
as_b PUT "/api/v1/invoices/$INV/status?$QB" '{"status":"paid"}'
assert_status 404 "B changes A's invoice status (was 200)"
assert_eq "A's invoice status unchanged" "$(sql "SELECT status FROM \"Invoice\" WHERE id = '$INV';")" "$STATUS_BEFORE"
as_b DELETE "/api/v1/reports/cost-center-budgets/$BUDGET?$QB"
assert_status 404 "B deletes A's cost-center budget (was 200)"
assert_eq "A's budget still there" "$(sql "SELECT count(*) FROM \"CostCenterBudget\" WHERE id = '$BUDGET';")" "1"
ERR_STATUS=$(sql "SELECT status FROM \"ErrorEvent\" WHERE id = '$ERR';")
as_b POST "/api/v1/system/errors/$ERR/mute?$QB";     assert_status 404 "B mutes A's error event (was 201)"
as_b POST "/api/v1/system/errors/$ERR/resolve?$QB";  assert_status 404 "B resolves A's error event (was 201)"
assert_eq "A's error event unchanged" "$(sql "SELECT status FROM \"ErrorEvent\" WHERE id = '$ERR';")" "$ERR_STATUS"
CREDIT_BEFORE=$(sql "SELECT count(*) FROM \"CustomerCreditTransaction\" WHERE \"customerId\" = '$CUST';")
as_b POST "/api/v1/customers/$CUST/credit-adjust?$QB" "{\"amount\":5,\"description\":\"$TAG by B\"}"
assert_status 404 "B adjusts A's customer credit (was 201)"
assert_eq "no credit transaction on A's customer" "$(sql "SELECT count(*) FROM \"CustomerCreditTransaction\" WHERE \"customerId\" = '$CUST';")" "$CREDIT_BEFORE"

note "=== 4. foreign / unknown ids are 404, not 500 ==="
[[ -n "$VOUCHER" ]] && { as_b GET "/api/v1/accounting/vouchers/$VOUCHER/pdf?$QB"; assert_status 404 "voucher PDF, foreign id (was 500)"; }
as_b GET "/api/v1/invoices/$INV/xrechnung?$QB";          assert_status 404 "XRechnung, foreign id (was 500)"
as_b GET "/api/v1/invoices/$INV/zugferd?$QB";            assert_status 404 "ZUGFeRD, foreign id (was 500)"
as_b GET "/api/v1/reminders/$INV/email-data?$QB&level=first"; assert_status 404 "reminder email-data, foreign id (was 500)"
if [[ -n "$WEBHOOK" ]]; then
  as_b PATCH "/api/v1/webhooks/$WEBHOOK?$QB" '{"name":"x"}'; assert_status 404 "PATCH webhook, foreign id (was 500)"
  as_b DELETE "/api/v1/webhooks/$WEBHOOK?$QB";              assert_status 404 "DELETE webhook, foreign id (was 500)"
fi

note "=== 4b. Tier 395: an OMITTED companyId must not drop the tenant filter ==="
# HeaderAuthGuard binds a body/query companyId only when it is PRESENT. Where a
# handler passed that optional value straight into a Prisma where, leaving it
# out removed the filter. Measured: B posting only A's customerId to
# /customer-portal/admin/create-session got 201 with a working portal token +
# URL for A's customer, that customer's e-mail address, and the portal login
# mail was sent to them.
as_b POST "/api/v1/customer-portal/admin/create-session" "{\"customerId\":\"$CUST\"}"
assert_status 400 "B mints a portal session for A's customer, no companyId (was 201 + token)"
[[ "$BODY" != *"token="* ]] && pass "…no portal token in the answer" || fail "…token leaked: ${BODY:0:120}"
as_b POST "/api/v1/customer-portal/admin/create-session" "{\"customerId\":\"$CUST\",\"companyId\":\"$A\"}"
assert_status 403 "…and with A's companyId the guard still refuses"
# The error timeline took an optional companyId query param; omitting it counted
# every tenant's errors.
as_b GET "/api/v1/system/errors/timeline?days=30"
assert_status 200 "B reads the error timeline without a companyId"
cat > "/tmp/$TAG-tl.py" <<'PY'
import json, sys
d = json.load(sys.stdin)
# shape: {days, source, buckets:[{date,total,open,resolved,muted}]}
print(int(sum(b.get("total", 0) for b in d.get("buckets", []))))
PY
TL_TOTAL=$(echo "$BODY" | python3 "/tmp/$TAG-tl.py" 2>/dev/null || echo 0)
rm -f "/tmp/$TAG-tl.py"
assert_eq "…and counts none of A's errors (B's company is empty)" "$TL_TOTAL" "0"

note "=== 5. company A still works on its own records ==="
api_get "/api/v1/payments/direct-debit/batches/$DD_BATCH?companyId=$A";  assert_status 200 "A reads its direct-debit batch"
api_get "/api/v1/inventory/$PRODUCT";                                   assert_status 200 "A reads its stock"
[[ -n "$(json_field "$BODY" id)" ]] && pass "…with the product" || fail "A's stock read empty: $BODY"
api_post "/api/v1/customers/$CUST/credit-adjust?companyId=$A" "{\"amount\":1,\"description\":\"$TAG by A\"}"
assert_status 201 "A adjusts its customer's credit"
api_delete "/api/v1/reports/cost-center-budgets/$BUDGET?companyId=$A"; assert_status 200 "A deletes its budget"
api_post "/api/v1/system/errors/$ERR/mute?companyId=$A" '{}';           assert_status 201 "A mutes its error event"

summary
exit $?
