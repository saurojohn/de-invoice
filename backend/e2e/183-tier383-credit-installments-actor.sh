#!/bin/bash
# Tier 383 — customer credit / allocation and installment-plan bodies, and
# actor ids that must be the caller
#
# Measured on a fresh stack before the change:
#   credit-adjust     amount 1e12 → 500; 5000-char description, undeclared field → 201;
#                     createdById = another tenant's user → 201, stored as the author
#   credit-payout     paymentDate "abc" → 500; amount 1e12 → 500
#   apply-credit      invoiceId 123 → 500
#   allocate-payment  paymentDate "2026-02-30" → 201, Payment stored 2026-03-02
#   installment-plans/from-invoice
#                     installmentCount 2.5 → 201: plan "2 Raten" with 3 rows of 476 €
#                     (1428 € for a 1190 € invoice); 5000 → 201 with 5000 rows;
#                     intervalDays -30 / 0 → 201; "drei" and firstDueDate "abc" → 500
#                     and installmentCount "3" (a string) → 500 — the invoice page sends numbers
# Multipart uploads (multer parses the form after the guards, so the guard's
# body binding never saw these fields):
#   POST /attachments  tenant B, form companyId=<A> + one of A's invoices → 201,
#                      file stored under company A; A's upload with uploadedById=<B> → 201,
#                      stored as the uploader
#   POST /storage/upload  tenant B, companyId=<A> → 201 into A's directory;
#                      type "../../../x" → 201, file written outside the storage root
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
Q="companyId=$COMPANY_ID"
TAG="e2e-183-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }
BANK=$(sql "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '1200';")
FUTURE=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=30)).isoformat())")

customer() { api_post "/api/v1/customers?$Q" "{\"name\":\"$TAG $1\",\"type\":\"business\"}"; json_field "$BODY" id; }
invoice() { # customer unitPrice
  api_post "/api/v1/invoices?$Q" "{\"customerId\":\"$1\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"$TAG\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  api_put "/api/v1/invoices/$id/status?$Q" '{"status":"sent"}'
  echo "$id"
}
CUST=$(customer credit)
INV=$(invoice "$CUST" 100)
[[ -n "$CUST" && -n "$INV" && -n "$BANK" ]] && pass "fixtures" || { fail "fixtures missing"; summary; exit 1; }
LEDGER() { sql "SELECT count(*) FROM \"CustomerCreditTransaction\" WHERE \"customerId\" = '$CUST';"; }
C="/api/v1/customers/$CUST"

note "=== 1. the callers' shapes still work ==="
api_post "$C/credit-adjust?$Q" "{\"amount\":50,\"description\":\"$TAG +50\"}";                 assert_status 201 "credit-adjust +50 (credit page / e2e 85)"
api_post "$C/credit-adjust?$Q" "{\"amount\":-5,\"description\":\"$TAG -5\",\"createdById\":\"$USER_ID\"}"; assert_status 201 "credit-adjust -5 with the caller's own createdById"
api_post "$C/credit-payout?$Q" "{\"amount\":5,\"paymentDate\":\"$(date +%Y-%m-%d)\",\"bankAccountId\":\"$BANK\",\"description\":\"$TAG payout\"}"; assert_status 201 "credit-payout (credit page)"
api_post "$C/apply-credit?$Q" "{\"invoiceId\":\"$INV\",\"amount\":6}";                        assert_status 201 "apply-credit (e2e 85)"
api_post "$C/allocate-payment?$Q" "{\"amount\":10,\"paymentDate\":\"$(date +%Y-%m-%d)\",\"paymentMethod\":\"Überweisung\",\"reference\":\"$TAG\"}"; assert_status 201 "allocate-payment (customer page)"
CUST2=$(customer plan); INV2=$(invoice "$CUST2" 1000)
# invoice detail page (Ratenplan suggestion modal: Number(...) inputs)
api_post "/api/v1/installment-plans/from-invoice?$Q" "{\"invoiceId\":\"$INV2\",\"installmentCount\":3,\"firstDueDate\":\"$FUTURE\",\"intervalDays\":30,\"notes\":\"$TAG\",\"autoPause\":true}"
assert_status 201 "from-invoice (invoice page shape)"
PLAN2=$(json_field "$BODY" id)
assert_eq "…3 installments" "$(sql "SELECT count(*) FROM \"Installment\" WHERE \"planId\" = '$PLAN2';")" "3"
assert_eq "…summing to the invoice total" "$(sql "SELECT (SELECT sum(amount) FROM \"Installment\" WHERE \"planId\" = '$PLAN2') = (SELECT total FROM \"Invoice\" WHERE id = '$INV2');")" "t"
# API clients sending numbers as strings: converted now (the old handler
# compared the string and answered 500 — measured on the old code)
CUST3=$(customer strings); INV3=$(invoice "$CUST3" 1000)
api_post "/api/v1/installment-plans/from-invoice?$Q" "{\"invoiceId\":\"$INV3\",\"installmentCount\":\"3\",\"firstDueDate\":\"$FUTURE\",\"intervalDays\":\"30\"}"
assert_status 201 "from-invoice with string numbers (was 500)"
PLAN3=$(json_field "$BODY" id)

note "=== 2. bad credit / allocation bodies are 400 and book nothing ==="
BEFORE=$(LEDGER)
api_post "$C/credit-adjust?$Q" "{\"amount\":1000000000000,\"description\":\"$TAG\"}";         assert_status 400 "credit-adjust amount 1e12 (was 500)"
api_post "$C/credit-adjust?$Q" "{\"amount\":5,\"description\":\"$(printf 'D%.0s' $(seq 1 600))\"}"; assert_status 400 "credit-adjust 600-char description (5000 were stored)"
api_post "$C/credit-adjust?$Q" "{\"amount\":5,\"description\":\"$TAG\",\"unknown\":1}";        assert_status 400 "credit-adjust undeclared field (was 201)"
api_post "$C/credit-payout?$Q" "{\"amount\":1,\"paymentDate\":\"abc\",\"bankAccountId\":\"$BANK\"}"; assert_status 400 "credit-payout paymentDate abc (was 500)"
api_post "$C/credit-payout?$Q" "{\"amount\":1,\"paymentDate\":\"2026-02-30\",\"bankAccountId\":\"$BANK\"}"; assert_status 400 "credit-payout paymentDate 2026-02-30 (was 201)"
api_post "$C/credit-payout?$Q" "{\"amount\":1000000000000,\"paymentDate\":\"$(date +%Y-%m-%d)\",\"bankAccountId\":\"$BANK\"}"; assert_status 400 "credit-payout amount 1e12 (was 500)"
# a number is converted to the string "123" and then not found
api_post "$C/apply-credit?$Q" '{"invoiceId":123,"amount":1}';                                  assert_status 404 "apply-credit invoiceId 123 (was 500)"
assert_eq "no ledger row from the invalid requests" "$(LEDGER)" "$BEFORE"
PAYMENTS=$(sql "SELECT count(*) FROM \"Payment\" WHERE \"invoiceId\" = '$INV';")
api_post "$C/allocate-payment?$Q" '{"amount":10,"paymentDate":"2026-02-30","paymentMethod":"bank"}'; assert_status 400 "allocate-payment paymentDate 2026-02-30 (was stored as 03-02)"
api_post "$C/allocate-payment?$Q" '{"amount":1000000000000,"paymentDate":"2026-09-01","paymentMethod":"bank"}'; assert_status 400 "allocate-payment amount 1e12 (was 201)"
assert_eq "no payment from the invalid allocations" "$(sql "SELECT count(*) FROM \"Payment\" WHERE \"invoiceId\" = '$INV';")" "$PAYMENTS"

note "=== 3. bad installment plans are 400 and create nothing ==="
plan_attempt() { # body-suffix label
  local cust inv
  cust=$(customer "p $RANDOM"); inv=$(invoice "$cust" 1000)
  api_post "/api/v1/installment-plans/from-invoice?$Q" "{\"invoiceId\":\"$inv\"$1}"
  assert_status 400 "$2"
  assert_eq "…no plan" "$(sql "SELECT count(*) FROM \"InstallmentPlan\" WHERE \"invoiceId\" = '$inv';")" "0"
}
plan_attempt ",\"installmentCount\":2.5,\"firstDueDate\":\"$FUTURE\"" "installmentCount 2.5 (was 201, 1428 € for 1190 €)"
plan_attempt ",\"installmentCount\":5000,\"firstDueDate\":\"$FUTURE\"" "installmentCount 5000 (was 201, 5000 rows)"
plan_attempt ",\"installmentCount\":3,\"firstDueDate\":\"$FUTURE\",\"intervalDays\":-30" "intervalDays -30 (was 201)"
plan_attempt ",\"installmentCount\":3,\"firstDueDate\":\"$FUTURE\",\"intervalDays\":0" "intervalDays 0 (was 201)"
plan_attempt ",\"installmentCount\":\"drei\",\"firstDueDate\":\"$FUTURE\"" "installmentCount \"drei\" (was 500)"
plan_attempt ",\"installmentCount\":3,\"firstDueDate\":\"abc\"" "firstDueDate abc (was 500)"

note "=== 4. actor ids must be the caller ==="
BODY=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier383-e2e\",\"companyName\":\"$TAG other\"}")
OTHER=$(json_field "$BODY" user.id)
OTHER_CO=$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "$OTHER" && -n "$OTHER_CO" ]] && pass "another tenant's user" || fail "register failed"
BEFORE=$(LEDGER)
api_post "$C/credit-adjust?$Q" "{\"amount\":7,\"description\":\"$TAG spoof\",\"createdById\":\"$OTHER\"}"
assert_status 403 "credit-adjust with another user's createdById (was 201, stored)"
assert_eq "…nothing booked" "$(LEDGER)" "$BEFORE"
api_post "/api/v1/cashbook/entries?$Q" "{\"createdById\":\"$OTHER\",\"businessDate\":\"2031-06-06\",\"type\":\"einnahme\",\"description\":\"$TAG\",\"amount\":1}"
assert_status 403 "cashbook entry with another user's createdById"

note "=== 5. multipart uploads bind companyId and actor ids too ==="
TMPD=$(mktemp -d)
printf '%%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%%%EOF\n' > "$TMPD/r.pdf"
printf ':20:T383\n' > "$TMPD/s.mt940"
mp() { # A|B path curl-args...
  local who="$1" path="$2"; shift 2
  local u="$USER_ID" c="$COMPANY_ID" resp
  [[ "$who" == B ]] && { u="$OTHER"; c="$OTHER_CO"; }
  resp=$(curl -sS -w "\n%{http_code}" -X POST "$API$path" -H "x-user-id: $u" -H "x-company-id: $c" "$@")
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
ATT() { sql "SELECT count(*) FROM \"Attachment\" WHERE \"entityId\" = '$INV';"; }
BEFORE=$(ATT)
mp B /api/v1/attachments -F "file=@$TMPD/r.pdf;type=application/pdf" -F "companyId=$COMPANY_ID" -F entityType=invoice -F "entityId=$INV"
assert_status 403 "attachment: tenant B with companyId=A on A's invoice (was 201, stored under A)"
mp A /api/v1/attachments -F "file=@$TMPD/r.pdf;type=application/pdf" -F "companyId=$COMPANY_ID" -F entityType=invoice -F "entityId=$INV" -F "uploadedById=$OTHER"
assert_status 403 "attachment: uploadedById = another tenant's user (was 201, stored)"
assert_eq "…no attachment from either" "$(ATT)" "$BEFORE"
# invoice page / ReceiptsPanel shape
mp A /api/v1/attachments -F "file=@$TMPD/r.pdf;type=application/pdf" -F "companyId=$COMPANY_ID" -F entityType=invoice -F "entityId=$INV" -F "uploadedById=$USER_ID"
assert_status 201 "attachment: the invoice page's own upload"
ATT_ID=$(json_field "$BODY" id)
STMTS=$(sql "SELECT count(*) FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';")
mp B /api/v1/bank-statements/import -F "file=@$TMPD/s.mt940;type=text/plain" -F "companyId=$COMPANY_ID"
assert_status 403 "bank import: tenant B with companyId=A"
mp A /api/v1/bank-statements/import -F "file=@$TMPD/s.mt940;type=text/plain" -F "companyId=$COMPANY_ID" -F "userId=$OTHER"
assert_status 403 "bank import: userId = another tenant's user"
assert_eq "…no statement imported" "$(sql "SELECT count(*) FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';")" "$STMTS"
mp B /api/v1/storage/upload -F "file=@$TMPD/r.pdf" -F "companyId=$COMPANY_ID"
assert_status 403 "storage upload: tenant B with companyId=A (was 201 into A's directory)"
mp B /api/v1/storage/upload -F "file=@$TMPD/r.pdf" -F "type=../../../e2e-183-escape"
assert_status 400 "storage upload: type ../../../ (was 201, written outside the root)"
mp B /api/v1/storage/upload -F "file=@$TMPD/r.pdf"
assert_status 201 "storage upload without companyId"
SPATH=$(json_field "$BODY" file.path)
[[ "$SPATH" == */attachments/$OTHER_CO/* ]] && pass "…stored under the caller's company" || fail "…stored at '$SPATH' (was 'default')"
mp B /api/v1/companies/upload-logo -F "file=@$TMPD/r.pdf;type=image/png" -F "companyId=$COMPANY_ID"
assert_status 403 "company logo: tenant B with companyId=A"
mp B /api/v1/berater/notes -F "companyId=$COMPANY_ID" -F entityType=invoice -F "entityId=$INV" -F message=x
assert_status 403 "berater note: tenant B with companyId=A"
# Static: guards run before multer, so a bare FileInterceptor route would trust the form again.
BARE=$(grep -rln "FileInterceptor(" "$SCRIPT_DIR/../src" | grep -v "src/auth/caller-bound-upload.ts" || true)
[[ -z "$BARE" ]] && pass "every upload route goes through CallerBoundUpload" || fail "FileInterceptor used directly in: $BARE"
UPLOADS=$(grep -rl "@UploadedFile" "$SCRIPT_DIR/../src" | sort)
BOUND=$(grep -rl "@CallerBoundUpload(" "$SCRIPT_DIR/../src" | sort)
[[ -n "$UPLOADS" && "$UPLOADS" == "$BOUND" ]] && pass "…and every @UploadedFile controller uses it ($(echo "$UPLOADS" | wc -l | tr -d ' ') files)" || fail "@UploadedFile / CallerBoundUpload mismatch: $(comm -3 <(echo "$UPLOADS") <(echo "$BOUND") | tr -s ' \t\n' ' ')"

note "=== 6. cleanup ==="
[[ -n "$ATT_ID" ]] && api_delete "/api/v1/attachments/$ATT_ID?$Q"
[[ -n "$SPATH" ]] && curl -s -o /dev/null -X DELETE "$API/api/v1/storage/files/$SPATH" -H "x-user-id: $OTHER" -H "x-company-id: $OTHER_CO"
rm -rf "$TMPD"
for plan in "$PLAN2" "$PLAN3"; do
  [[ -n "$plan" ]] && sql "DELETE FROM \"Installment\" WHERE \"planId\" = '$plan'; DELETE FROM \"InstallmentPlan\" WHERE id = '$plan';" >/dev/null
done
sql "DELETE FROM \"Mahnungspause\" WHERE \"customerId\" IN ('$CUST2', '$CUST3');" >/dev/null
assert_eq "e2e-183 plan removed" "$(sql "SELECT count(*) FROM \"InstallmentPlan\" WHERE id = '$PLAN2';")" "0"

summary
exit $?
