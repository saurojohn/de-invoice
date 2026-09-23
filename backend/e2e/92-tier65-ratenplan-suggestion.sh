#!/usr/bin/env bash
# e2e 92: Tier 65 — Auto-Ratenplan suggestion.
#
# Validates the new /api/v1/installment-plans endpoints:
#
#   1. GET .../suggestion/:invoiceId returns eligible=true
#      for a high-amount sent invoice with no existing plan
#      and no active customer plan.
#   2. The suggestion defaults are sane (3 Raten, 30 days,
#      firstDueDate ≈ today+14d, notes="Ratenplan-Vorschlag").
#   3. A small-amount invoice (under threshold) returns
#      eligible=false with a "below threshold" reason.
#   4. An invoice with an existing Ratenplan returns
#      eligible=false with "already has plan" reason.
#   5. A customer with an active plan returns eligible=false
#      with "customer has active plan" reason.
#   6. POST .../from-invoice creates a Ratenplan AND
#      a Mahnungspause on the invoice in one shot (customer-level until Tier 429).
#   7. The created plan is linked to the invoice
#      (1:1 via invoiceId).
#   8. The created Mahnungspause has reason "Ratenplan aktiv",
#      invoiceId set, pausedUntil=null while the plan runs.
#   9. After create, the same invoice's suggestion returns
#      eligible=false ("already has plan").
#  10. Cleanup.
#
# Auth: shares /tmp/cashbook-e2e-auth.env.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# ───── 0. Wipe prior tier-65 fixtures ─────
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Mahnungspause" WHERE "companyId" = '$COMPANY_ID' AND reason = 'Ratenplan aktiv';
DELETE FROM "Installment" WHERE "planId" IN (SELECT id FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND notes = 'Ratenplan-Vorschlag');
DELETE FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND notes = 'Ratenplan-Vorschlag';
SQL
pass "wiped prior tier-65 fixtures"

# Tier 396: this used to pick an arbitrary customer (`Customer ... LIMIT 1`,
# no ORDER BY) and then REQUIRE that customer to happen to own both a >= 500 EUR
# and a < 500 EUR sent invoice, skipping when it did not. Adding customers
# anywhere in the suite changed which row came back, and CI silently went from
# 188 passed / 1 skipped to 187 / 2. The spec now creates exactly the two
# invoices it needs, so it cannot skip on ambient data.
T396="e2e-92-$(date +%s%N | cut -c1-13)"
api_post "/api/v1/customers?companyId=$COMPANY_ID" "{\"name\":\"$T396 Ratenplan\",\"type\":\"business\"}"
CUST_ID=$(json_field "$BODY" id)
[[ -n "$CUST_ID" ]] && pass "created the test customer: $CUST_ID" || { fail "customer create failed: $BODY"; summary; exit 1; }

mkinv92() { # unitPrice -> invoice id, status sent
  local id
  api_post "/api/v1/invoices?companyId=$COMPANY_ID" "{\"customerId\":\"$CUST_ID\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"$T396\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0}]}"
  id=$(json_field "$BODY" id)
  api_put "/api/v1/invoices/$id/status?companyId=$COMPANY_ID" '{"status":"sent"}'
  echo "$id"
}
HIGH_INV=$(mkinv92 1000)
LOW_INV=$(mkinv92 100)
[[ -n "$HIGH_INV" ]] && pass "high-amount invoice (1000 EUR, sent): $HIGH_INV" || { fail "high invoice missing"; summary; exit 1; }
[[ -n "$LOW_INV" ]] && pass "low-amount invoice (100 EUR, sent): $LOW_INV" || { fail "low invoice missing"; summary; exit 1; }

# Helper: stash $BODY into a file
stash() { printf '%s' "$BODY" > "$1"; }
jsf() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1', ''))" < "$2"; }

# ───── 1. Suggestion for high-amount sent invoice → eligible=true ─────
echo
note "=== 1. high-amount invoice → eligible=true ==="
api_get "/api/v1/installment-plans/suggestion/$HIGH_INV?companyId=$COMPANY_ID"
assert_eq "suggestion 200" "$STATUS" "200"
TMP1=$(mktemp); stash "$TMP1"
assert_eq "eligible=true" "$(jsf eligible "$TMP1")" "True"
assert_eq "threshold=500" "$(jsf threshold "$TMP1")" "500"
assert_eq "hasExistingPlan=false" "$(jsf hasExistingPlan "$TMP1")" "False"
assert_eq "hasCustomerActivePlan=false" "$(jsf hasCustomerActivePlan "$TMP1")" "False"
DEFAULT_COUNT=$(python3 -c "import json,sys; print(json.load(sys.stdin)['defaults']['installmentCount'])" < "$TMP1")
assert_eq "default installmentCount=3" "$DEFAULT_COUNT" "3"
DEFAULT_INTERVAL=$(python3 -c "import json,sys; print(json.load(sys.stdin)['defaults']['intervalDays'])" < "$TMP1")
assert_eq "default intervalDays=30" "$DEFAULT_INTERVAL" "30"
rm -f "$TMP1"

# ───── 2. Low-amount invoice → eligible=false (below threshold) ─────
echo
note "=== 2. low-amount invoice → eligible=false ==="
api_get "/api/v1/installment-plans/suggestion/$LOW_INV?companyId=$COMPANY_ID"
assert_eq "low suggestion 200" "$STATUS" "200"
TMP2=$(mktemp); stash "$TMP2"
assert_eq "eligible=false" "$(jsf eligible "$TMP2")" "False"
REASON2=$(jsf reason "$TMP2")
if echo "$REASON2" | grep -q "Schwellenwert"; then
  pass "reason mentions Schwellenwert: $REASON2"
else
  fail "expected reason to mention Schwellenwert, got: $REASON2"
fi
rm -f "$TMP2"

# ───── 3. POST from-invoice creates plan + auto-pause ─────
echo
note "=== 3. POST /from-invoice creates plan + auto-pause ==="
# Compute firstDueDate = today + 14 days
FIRST_DUE=$(date -v+14d -u +"%Y-%m-%d" 2>/dev/null || date -u -d "+14 days" +"%Y-%m-%d")
BODY="{\"invoiceId\":\"$HIGH_INV\",\"installmentCount\":3,\"firstDueDate\":\"$FIRST_DUE\",\"intervalDays\":30,\"notes\":\"Ratenplan-Vorschlag\"}"
api_post "/api/v1/installment-plans/from-invoice?companyId=$COMPANY_ID" "$BODY"
assert_eq "from-invoice 201" "$STATUS" "201"
TMP3=$(mktemp); stash "$TMP3"
PLAN_ID=$(jsf id "$TMP3")
[[ -n "$PLAN_ID" ]] && pass "captured plan id: $PLAN_ID" || fail "no plan id"
assert_eq "plan linked to invoice" "$(jsf invoiceId "$TMP3")" "$HIGH_INV"
assert_eq "plan installmentCount=3" "$(jsf installmentCount "$TMP3")" "3"
INSTALLMENT_COUNT=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['installments']))" < "$TMP3")
assert_eq "plan has 3 installments" "$INSTALLMENT_COUNT" "3"
rm -f "$TMP3"

# Verify the Mahnungspause was created
PAUSE_ROWS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT count(*) FROM \"Mahnungspause\" WHERE \"companyId\" = '$COMPANY_ID'
  AND reason = 'Ratenplan aktiv' AND \"invoiceId\" = '$HIGH_INV' AND \"customerId\" IS NULL;" 2>&1 | tr -d ' ')
# Tier 429: the pause covers the plan's invoice, not the whole customer (their
# other invoices were not dunned either), and ends when the plan completes or
# is cancelled.
assert_eq "auto-pause created on the invoice" "$PAUSE_ROWS" "1"

# Verify the pause is open-ended (pausedUntil IS NULL)
PAUSE_ENDED=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT CASE WHEN \"pausedUntil\" IS NULL THEN 'null' ELSE 'set' END
  FROM \"Mahnungspause\" WHERE \"companyId\" = '$COMPANY_ID'
  AND reason = 'Ratenplan aktiv' AND \"invoiceId\" = '$HIGH_INV' LIMIT 1;" 2>&1 | tr -d ' ')
assert_eq "pause runs while the plan is active" "$PAUSE_ENDED" "null"

# ───── 4. After create, suggestion says "already has plan" ─────
echo
note "=== 4. after create → suggestion ineligible (existing plan) ==="
api_get "/api/v1/installment-plans/suggestion/$HIGH_INV?companyId=$COMPANY_ID"
TMP4=$(mktemp); stash "$TMP4"
ELIGIBLE4=$(jsf eligible "$TMP4")
if [[ "$ELIGIBLE4" == "False" ]]; then
  REASON4=$(jsf reason "$TMP4")
  # "existiert bereits" — the actual phrase is
  # "Für diese Rechnung existiert bereits ein Ratenplan"
  if echo "$REASON4" | grep -qi "existiert bereits"; then
    pass "reason mentions existing plan: $REASON4"
  else
    fail "expected 'existiert bereits' in reason, got: $REASON4"
  fi
else
  fail "expected eligible=false after create, got $ELIGIBLE4"
fi
rm -f "$TMP4"

# ───── 5. Customer with active plan → ineligible ─────
echo
note "=== 5. customer with active plan → ineligible ==="
# Use the LOW_INV (no existing plan) but customer now has an active plan
# (from the from-invoice create above). Should be ineligible.
api_get "/api/v1/installment-plans/suggestion/$LOW_INV?companyId=$COMPANY_ID"
TMP5=$(mktemp); stash "$TMP5"
ELIGIBLE5=$(jsf eligible "$TMP5")
if [[ "$ELIGIBLE5" == "False" ]]; then
  REASON5=$(jsf reason "$TMP5")
  if echo "$REASON5" | grep -qi "aktiven Ratenplan"; then
    pass "reason mentions customer active plan: $REASON5"
  else
    fail "expected 'aktiven Ratenplan' in reason, got: $REASON5"
  fi
else
  fail "expected eligible=false (customer active plan), got $ELIGIBLE5"
fi
rm -f "$TMP5"

# ───── 6. Cleanup ─────
echo
note "=== 6. cleanup ==="
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Mahnungspause" WHERE "companyId" = '$COMPANY_ID' AND reason = 'Ratenplan aktiv';
DELETE FROM "Installment" WHERE "planId" IN (SELECT id FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND notes = 'Ratenplan-Vorschlag');
DELETE FROM "InstallmentPlan" WHERE "companyId" = '$COMPANY_ID' AND notes = 'Ratenplan-Vorschlag';
-- Tier 396: the spec's own customer + its two invoices.
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (SELECT id FROM "Invoice" WHERE "customerId" = '$CUST_ID');
DELETE FROM "Invoice" WHERE "customerId" = '$CUST_ID';
DELETE FROM "Customer" WHERE id = '$CUST_ID';
SQL
pass "cleanup complete"

summary
exit $?
