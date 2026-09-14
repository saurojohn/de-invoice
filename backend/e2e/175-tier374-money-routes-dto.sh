#!/bin/bash
# Tier 374 — payment, credit-note and Kassenbuch bodies are validated, and
# every real caller still works
#
# POST /invoices/:id/payments, /invoices/:id/credit-note, /cashbook/entries,
# /cashbook/entries/:id/reverse, /cashbook/close-day and /cashbook/reopen-day
# typed their bodies inline, which Nest's ValidationPipe cannot validate.
# Measured on a fresh stack before the change:
#   payments     {} / paymentDate "abc" / amount 1e12            → 500
#                e2e 07's body ("method" instead of "paymentMethod") → 500,
#                sent into /dev/null, so 07 never recorded its payment
#   credit-note  amount 1e12 / line vatRate 19                   → 500
#                amount "zehn", -50 or 0                          → 201 with a
#                FULL refund (-119 on a 119 invoice)
#   entries      businessDate "abc" / vatRate 19 / amount 1e12   → 500
#   close-day    date "abc"                                      → 500
# (reopen-day "abc" was not measured before, so it is not claimed as a 500.)
#
# A DTO under the global forbidNonWhitelisted turns any undeclared field a
# caller sends into a 400, so section 1 replays the shapes the real callers
# send (invoice detail page, credit-note modal, cashbook page, e2e 01–06, 50,
# 52, 80, 83, 149, Playwright credit-note / sequence-tier174 /
# cashbook-signature-tier194) and requires them to keep succeeding.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login

MUELLER="b9799545-956b-40db-8fcd-769b2d429aa9"
TODAY="$(date +%Y-%m-%d)"
# A day no other spec books on, so the close/reopen below is ours alone.
DAY="2031-03-17"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }

new_invoice() { # label → echoes id (gross 119)
  api_post "/api/v1/invoices?companyId=$COMPANY_ID" "{\"customerId\":\"$MUELLER\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"e2e-175 $1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  json_field "$BODY" id
}
cn_count() { sql "SELECT count(*) FROM \"Invoice\" WHERE \"referenceInvoiceId\" = '$1';"; }
entry_count() { sql "SELECT count(*) FROM \"CashBookEntry\" WHERE \"companyId\" = '$COMPANY_ID' AND \"businessDate\" = '$DAY';"; }

INV_PAY=$(new_invoice pay)
INV_FULL=$(new_invoice full)
INV_LINES=$(new_invoice lines)
INV_AMOUNT=$(new_invoice amount)
INV_BAD=$(new_invoice bad)
for v in "$INV_PAY" "$INV_FULL" "$INV_LINES" "$INV_AMOUNT" "$INV_BAD"; do
  [[ -n "$v" ]] || { fail "fixture invoice not created: $BODY"; summary; exit 1; }
done
pass "5 fixture invoices created"

note "=== 1. every real caller shape still succeeds ==="
PAY="/api/v1/invoices/$INV_PAY/payments?companyId=$COMPANY_ID"
# invoice detail page submitPayment()
api_post "$PAY" "{\"amount\":10,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\",\"reference\":\"e2e-175\",\"notes\":\"page shape\"}"
assert_status 201 "payment: page shape"
# e2e 52 / 83: full ISO timestamp, umlaut payment method
api_post "$PAY" '{"amount":10,"paymentDate":"2026-04-01T00:00:00.000Z","paymentMethod":"Überweisung"}'
assert_status 201 "payment: ISO timestamp + Überweisung"
# e2e 07 after its fix
api_post "$PAY" "{\"amount\":10,\"paymentDate\":\"2026-06-01\",\"paymentMethod\":\"bank_transfer\",\"notes\":\"E2E test payment\"}"
assert_status 201 "payment: e2e 07 shape"
# e2e 149: service-level answers are unchanged
api_post "$PAY" '{"amount":-10,"paymentDate":"2026-08-19","paymentMethod":"bank"}'
assert_status 400 "payment: negative amount still 400"
echo "$BODY" | grep -q "Betrag muss größer als 0" && pass "…with the service's German message" || fail "negative amount message changed: $BODY"
api_post "/api/v1/invoices/00000000-0000-0000-0000-000000000000/payments?companyId=$COMPANY_ID" '{"amount":100,"paymentDate":"2026-08-19","paymentMethod":"bank"}'
assert_status 404 "payment: unknown invoice still 404"

# e2e 80 / Playwright credit-note: empty body = full refund
api_post "/api/v1/invoices/$INV_FULL/credit-note?companyId=$COMPANY_ID" '{}'
assert_status 201 "credit-note: {} (full refund)"
assert_close "full refund total" "$(json_field "$BODY" total)" "-119"
# Playwright sequence-tier174: lines mirrored from the original
api_post "/api/v1/invoices/$INV_LINES/credit-note?companyId=$COMPANY_ID" '{"reason":"e2e-175 lines","lines":[{"description":"e2e-175","quantity":1,"unitPrice":100,"vatRate":0.19}]}'
assert_status 201 "credit-note: lines shape"
# credit-note modal / e2e 80: amount + reason
api_post "/api/v1/invoices/$INV_AMOUNT/credit-note?companyId=$COMPANY_ID" '{"amount":50,"reason":"Goodwill credit"}'
assert_status 201 "credit-note: amount + reason"
assert_close "flat refund total" "$(json_field "$BODY" total)" "-50"

ENTRIES="/api/v1/cashbook/entries?companyId=$COMPANY_ID"
# cashbook page save(): nulls for the optional text fields
api_post "$ENTRIES" "{\"createdById\":\"$USER_ID\",\"businessDate\":\"$DAY\",\"type\":\"einnahme\",\"description\":\"e2e-175 page\",\"amount\":100,\"vatRate\":0.19,\"counterparty\":null,\"belegNumber\":null,\"notes\":null}"
assert_status 201 "cashbook entry: page shape"
E1=$(json_field "$BODY" id)
# cashbook page for umbuchung/eroeffnung: vatRate null
api_post "$ENTRIES" "{\"createdById\":\"$USER_ID\",\"businessDate\":\"$DAY\",\"type\":\"umbuchung\",\"description\":\"e2e-175 umbuchung\",\"amount\":5,\"vatRate\":null,\"counterparty\":\"Bank\",\"belegNumber\":\"B-175\",\"notes\":\"n\"}"
assert_status 201 "cashbook entry: vatRate null"
E2=$(json_field "$BODY" id)
# e2e 01–06 shape
api_post "$ENTRIES" "{\"createdById\":\"$USER_ID\",\"businessDate\":\"$DAY\",\"type\":\"ausgabe\",\"description\":\"e2e-175 spec\",\"amount\":20}"
assert_status 201 "cashbook entry: e2e spec shape"
E3=$(json_field "$BODY" id)
# e2e 05: service messages still reach the client
api_post "$ENTRIES" "{\"createdById\":\"$USER_ID\",\"businessDate\":\"$DAY\",\"type\":\"einnahme\",\"description\":\"   \",\"amount\":10}"
assert_status 400 "cashbook entry: blank description still 400"
echo "$BODY" | grep -q "Beschreibung" && pass "…mentions Beschreibung" || fail "blank description message changed: $BODY"
# cashbook page doStorno()
api_post "/api/v1/cashbook/entries/$E3/reverse?companyId=$COMPANY_ID" "{\"reason\":\"e2e-175 storno\",\"createdById\":\"$USER_ID\"}"
assert_status 201 "storno: page shape"
E4=$(json_field "$BODY" id)
# e2e 03: storno without a reason keeps the service message
api_post "/api/v1/cashbook/entries/$E1/reverse?companyId=$COMPANY_ID" "{\"createdById\":\"$USER_ID\"}"
assert_status 400 "storno without reason still 400"
echo "$BODY" | grep -q "Begründung" && pass "…mentions Begründung" || fail "storno reason message changed: $BODY"

api_get "/api/v1/cashbook/day?companyId=$COMPANY_ID&date=$DAY"
ENDE=$(json_field "$BODY" ende)
# cashbook page saveZ() / Playwright tier194
api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{\"date\":\"$DAY\",\"physicalCount\":$ENDE,\"closedById\":\"$USER_ID\"}"
assert_status 201 "close-day: page shape"
# cashbook page reopenDay()
api_post "/api/v1/cashbook/reopen-day?companyId=$COMPANY_ID" "{\"date\":\"$DAY\"}"
assert_status 201 "reopen-day: page shape"

note "=== 2. invalid bodies are 400 and change nothing ==="
PAYMENTS_BEFORE=$(sql "SELECT count(*) FROM \"Payment\" WHERE \"invoiceId\" = '$INV_BAD';")
PAYB="/api/v1/invoices/$INV_BAD/payments?companyId=$COMPANY_ID"
api_post "$PAYB" '{}';                                                                             assert_status 400 "payment: empty body (was 500)"
api_post "$PAYB" '{"amount":10,"paymentDate":"abc","paymentMethod":"bank_transfer"}';             assert_status 400 "payment: paymentDate abc (was 500)"
api_post "$PAYB" "{\"amount\":1000000000000,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"; assert_status 400 "payment: amount 1e12 (was 500)"
api_post "$PAYB" '{"amount":119,"paymentDate":"2026-06-01","method":"bank_transfer"}';            assert_status 400 "payment: old e2e 07 body with 'method' (was 500)"
assert_eq "payments on the invoice after invalid posts" "$(sql "SELECT count(*) FROM \"Payment\" WHERE \"invoiceId\" = '$INV_BAD';")" "$PAYMENTS_BEFORE"

CNB="/api/v1/invoices/$INV_BAD/credit-note?companyId=$COMPANY_ID"
api_post "$CNB" '{"amount":1000000000000,"reason":"e2e-175"}';                                   assert_status 400 "credit-note: amount 1e12 (was 500)"
api_post "$CNB" '{"lines":[{"description":"x","quantity":1,"unitPrice":10,"vatRate":19}]}';       assert_status 400 "credit-note: line vatRate 19 (was 500)"
api_post "$CNB" '{"amount":"zehn"}';                                                             assert_status 400 "credit-note: amount 'zehn' (was 201 full refund)"
api_post "$CNB" '{"amount":-50,"reason":"e2e-175"}';                                             assert_status 400 "credit-note: amount -50 (was 201 full refund)"
api_post "$CNB" '{"amount":0}';                                                                  assert_status 400 "credit-note: amount 0 (was 201 full refund)"
api_post "$CNB" '{"amount":50,"refund":true}';                                                   assert_status 400 "credit-note: undeclared field"
assert_eq "credit notes on the invoice after invalid posts" "$(cn_count "$INV_BAD")" "0"

COUNT_BEFORE=$(entry_count)
api_post "$ENTRIES" '{"businessDate":"abc","type":"einnahme","description":"e2e-175","amount":10}';                 assert_status 400 "cashbook entry: businessDate abc (was 500)"
api_post "$ENTRIES" "{\"businessDate\":\"$DAY\",\"type\":\"einnahme\",\"description\":\"e2e-175\",\"amount\":10,\"vatRate\":19}"; assert_status 400 "cashbook entry: vatRate 19 (was 500)"
api_post "$ENTRIES" "{\"businessDate\":\"$DAY\",\"type\":\"einnahme\",\"description\":\"e2e-175\",\"amount\":1000000000000}"; assert_status 400 "cashbook entry: amount 1e12 (was 500)"
api_post "$ENTRIES" "{\"businessDate\":\"2031-02-30\",\"type\":\"einnahme\",\"description\":\"e2e-175\",\"amount\":10}"; assert_status 400 "cashbook entry: 30 February"
assert_eq "entries on $DAY after invalid posts" "$(entry_count)" "$COUNT_BEFORE"

api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" '{"date":"abc","physicalCount":0}';                   assert_status 400 "close-day: date abc (was 500)"
api_post "/api/v1/cashbook/close-day?companyId=$COMPANY_ID" "{\"date\":\"$DAY\",\"physicalCount\":1000000000000}"; assert_status 400 "close-day: physicalCount 1e12"
api_post "/api/v1/cashbook/reopen-day?companyId=$COMPANY_ID" '{"date":"abc"}';                                   assert_status 400 "reopen-day: date abc"
assert_eq "closes on $DAY after invalid posts" "$(sql "SELECT count(*) FROM \"CashBookDailyClose\" WHERE \"companyId\" = '$COMPANY_ID' AND \"businessDate\" = '$DAY';")" "0"

note "=== 3. cleanup ==="
# The day is open again (reopen-day above). Storno first, then the originals.
for id in "$E4" "$E3" "$E2" "$E1"; do
  [[ -n "$id" ]] && api_delete "/api/v1/cashbook/entries/$id?companyId=$COMPANY_ID"
done
assert_eq "e2e-175 cash book entries left" "$(entry_count)" "0"

summary
exit $?
