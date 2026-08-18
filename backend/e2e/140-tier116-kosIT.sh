#!/usr/bin/env bash
# e2e 140: Tier 116 — KoSIT Validator 1.6.2 integration.
# Replaces the in-process BR-* check (Tier 115) with the
# official KoSIT Validator (https://github.com/itplr-kosit/validator)
# for full EN 16931 + XRechnung 3.0.2 compliance.
#
# Test plan (7 sections, 30+ assertions):
#   0.  Verify infra setup (validator.jar + JDK + scenarios.xml)
#   1.  Setup: 4 invoices (B2B, B2B-OSS, B2G, Skonto)
#   2.  Engine=basic (default): in-process BR-* check
#   3.  Engine=kosit: real KoSIT JAR validation
#       - Schema: Y/N flag
#       - Schematron: Y/N flag
#       - Acceptance: ACCEPTABLE/REJECT
#       - Graceful fallback when JAR missing
#   4.  Engine=invalid: 400 bad request
#   5.  Cross-tenant → 401
#   6.  No auth → 401
#   7.  Cleanup
#
# Note: KoSIT 1.6.2 has bugs in the CLI (the createReport.xsl
# crashes with "node is null"). We work around this by using
# the table-format output (always printed, even on REJECT).
# The CLI exit code 0/1 indicates ACCEPTABLE/REJECT — we catch
# it and parse the table.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
TS=$(date +%s)
PREFIX="T116-$TS"
YEAR=2026

KOSIT_ROOT="$SCRIPT_DIR/../../infra/kosit"
JAVA_HOME_DIR="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home"

note "=== Test prefix: $PREFIX / year: $YEAR ==="

# ───── 0. Verify infra setup ─────
note "=== 0. KoSIT infrastructure ==="
if [[ -f "$KOSIT_ROOT/validator.jar" ]]; then
  pass "validator.jar present: $KOSIT_ROOT/validator.jar"
else
  fail "validator.jar MISSING — run scripts/setup-kosit.sh"
fi
if [[ -f "$KOSIT_ROOT/scenarios.xml" ]]; then
  pass "scenarios.xml present"
else
  fail "scenarios.xml MISSING"
fi
if [[ -f "$KOSIT_ROOT/repository/xsd/maindoc/UBL-Invoice-2.1.xsd" ]]; then
  pass "UBL 2.1 XSD present"
else
  fail "UBL 2.1 XSD MISSING"
fi
if [[ -x "$JAVA_HOME_DIR/bin/java" ]]; then
  pass "Java 17 present: $JAVA_HOME_DIR/bin/java"
else
  fail "Java 17 MISSING — install via brew install openjdk@17 or use Temurin"
fi
# Quick smoke test — run validator --help
HELP_OUT=$("$JAVA_HOME_DIR/bin/java" -jar "$KOSIT_ROOT/validator.jar" --help 2>&1 | head -1)
if echo "$HELP_OUT" | grep -q "KoSIT Validator"; then
  pass "validator.jar runs (--help output valid)"
else
  fail "validator.jar --help failed"
fi

# ───── 1. Setup: 4 invoices ─────
note "=== 1. Setup: 4 customers + 4 invoices ==="
# Re-use Tier 115 fixture pattern (PREFIX-based)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'T116-%'
);
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'T116-%';
DELETE FROM "Customer" WHERE "customerNumber" LIKE 'T116-%' OR name LIKE 'T116-%';
SQL
ORIGINAL_ADDRESS=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT address::text FROM \"Company\" WHERE id='$COMPANY_ID';" 2>&1 | tr -d '\n' | head -1)
cleanup() {
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null 2>&1
DELETE FROM "InvoiceItem" WHERE "invoiceId" IN (
  SELECT id FROM "Invoice" WHERE "invoiceNumber" LIKE 'T116-%'
);
DELETE FROM "Invoice" WHERE "invoiceNumber" LIKE 'T116-%';
DELETE FROM "Customer" WHERE "customerNumber" LIKE 'T116-%' OR name LIKE 'T116-%';
UPDATE "Company" SET address = '${ORIGINAL_ADDRESS}'::jsonb WHERE id = '$COMPANY_ID';
SQL
}
trap cleanup EXIT
# Make sure company has a valid address (BR-06)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "UPDATE \"Company\" SET address='{\"street\":\"Otto-Hahn-Str. 24\",\"city\":\"Dreieich\",\"postalCode\":\"63303\",\"country\":\"Deutschland\"}'::jsonb, \"bankInfo\"='{\"bic\":\"HELADEFFXXX\",\"iban\":\"DE89370400440532013000\",\"bankName\":\"Commerzbank\"}'::jsonb WHERE id='$COMPANY_ID';" >/dev/null
pass "seeded company address + IBAN"

docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Customer" (id, "companyId", name, "customerNumber", "vatId", address, "paymentTerms", tags, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} B2B Kunde', 'T116-${TS}-B2B',
   'DE123456789', '{"street":"Test 1","city":"Berlin","postalCode":"10115","country":"Deutschland"}'::jsonb,
   30, ARRAY['${PREFIX}']::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} B2B-OSS', 'T116-${TS}-OSS',
   'ATU12345678', '{"street":"Mariahilfer 10","city":"Wien","postalCode":"1060","country":"Österreich"}'::jsonb,
   30, ARRAY['${PREFIX}']::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} B2G Behörde', 'T116-${TS}-B2G',
   NULL, '{"street":"Behörde 1","city":"Bonn","postalCode":"53111","country":"Deutschland","leitwegId":"991-12345-67"}'::jsonb,
   30, ARRAY['${PREFIX}']::text[], now(), now()),
  (gen_random_uuid()::text, '$COMPANY_ID', '${PREFIX} Skonto Kunde', 'T116-${TS}-SK',
   'DE987654321', '{"street":"Skonto 1","city":"München","postalCode":"80331","country":"Deutschland"}'::jsonb,
   14, ARRAY['${PREFIX}']::text[], now(), now());
SQL
pass "created 4 customers"

# Helper to create invoice via SQL (the API auto-assigns invoiceNumber)
create_invoice() {
  local inv_num="$1" cust_num="$2" skonto_pct="${3:-0}" skonto_days="${4:-0}"
  local cust_id=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Customer\" WHERE \"customerNumber\"='$cust_num';" 2>&1 | tr -d ' ' | head -1)
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Invoice" (id, "companyId", "invoiceNumber", type, status, "issueDate", "dueDate",
                       "customerId", subtotal, "totalVat", total, currency, language,
                       "skontoPercent", "skontoDays", "createdAt", "updatedAt")
VALUES
  ('inv-${inv_num}'::text, '$COMPANY_ID', '${inv_num}', 'INV', 'sent',
   '${YEAR}-05-01', '${YEAR}-05-31',
   '${cust_id}'::text, 1000, 190, 1190, 'EUR', 'de-DE',
   ${skonto_pct}, ${skonto_days}, now(), now());
INSERT INTO "InvoiceItem" (id, "invoiceId", description, quantity, "unitPrice", "vatRate",
                           "netAmount", "vatAmount", "grossAmount", "sortOrder")
VALUES
  (gen_random_uuid()::text, 'inv-${inv_num}'::text, 'Beratung', 1.0, 1000.0, 0.19,
   1000.0, 190.0, 1190.0, 1);
SQL
  echo "inv-${inv_num}"
}
INV_B2B=$(create_invoice "T116-${TS}-B2B" "T116-${TS}-B2B")
INV_OSS=$(create_invoice "T116-${TS}-OSS" "T116-${TS}-OSS")
INV_B2G=$(create_invoice "T116-${TS}-B2G" "T116-${TS}-B2G")
INV_SK=$(create_invoice "T116-${TS}-SK" "T116-${TS}-SK" 2 14)
pass "created 4 invoices"

# ───── 2. Engine=basic (default in-process) ─────
note "=== 2. engine=basic — in-process BR-* check ==="
api_get "/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID&engine=basic"
VAL_OK=$(json_field "$BODY" "valid")
test "$VAL_OK" = "True" && pass "basic validate ok (B2B)" || fail "basic validate: $VAL_OK (body=$BODY)"
ERR_ENGINE=$(json_field "$BODY" "engine" 2>/dev/null || echo "")
# basic engine has no "engine" field (legacy)
if [ -z "$ERR_ENGINE" ]; then
  pass "basic has no engine field (legacy shape)"
else
  note "basic has engine=$ERR_ENGINE (informational)"
fi

# ───── 3. Engine=kosit — real KoSIT JAR ─────
note "=== 3. engine=kosit — KoSIT Validator 1.6.2 ==="
api_get "/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID&engine=kosit"
ENGINE=$(json_field "$BODY" "engine")
test "$ENGINE" = "kosit" && pass "engine=kosit" \
  || { fail "engine=$ENGINE (expected kosit)"; echo "BODY=$BODY" | head -2; }
# Should have a valid+acceptance result
ACCEPTANCE=$(json_field "$BODY" "acceptance")
test -n "$ACCEPTANCE" && pass "acceptance=$ACCEPTANCE" \
  || fail "no acceptance field"
# Schema/Schematron flags present
HAS_SCHEMA=$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print('schema' in d and 'schematron' in d)")
test "$HAS_SCHEMA" = "True" && pass "schema + schematron flags present" \
  || fail "schema/schematron flags missing"
# durationMs present (KoSIT run timing)
DUR=$(json_field "$BODY" "durationMs")
if [ -n "$DUR" ] && [ "$DUR" -gt 0 ]; then
  pass "durationMs=$DUR (>0ms)"
else
  fail "durationMs not set: '$DUR'"
fi

# ───── 3.0 Tier 117: UBL 2.1 XSD element order fix ─────
# Before Tier 117, the generator emitted cvc-complex-type.2.4.a
# errors (BuyerReference before DocumentCurrencyCode, Note at
# the end, ItemLocationQuantity instead of ClassifiedTaxCategory).
# After the fix, the generator must pass both XSD and Schematron.
# Note: schema/schematron are returned as Y/N strings (not booleans).
SCHEMA_FLAG=$(json_field "$BODY" "schema")
test "$SCHEMA_FLAG" = "Y" && pass "Tier 117: schema=Y (UBL 2.1 XSD order fix)" \
  || { fail "Tier 117: schema=$SCHEMA_FLAG (XSD still fails)"; echo "BODY=$BODY" | head -2; }
SCHEMA_FLAG=$(json_field "$BODY" "schematron")
test "$SCHEMA_FLAG" = "Y" && pass "Tier 117: schematron=Y (XRechnung 3.0 rules)" \
  || { fail "Tier 117: schematron=$SCHEMA_FLAG"; echo "BODY=$BODY" | head -2; }
test "$ACCEPTANCE" = "ACCEPTABLE" && pass "Tier 117: acceptance=ACCEPTABLE" \
  || fail "Tier 117: acceptance=$ACCEPTANCE (expected ACCEPTABLE)"

# Test 3.1: same call for Skonto invoice
api_get "/api/v1/invoices/${INV_SK}/xrechnung/validate?companyId=$COMPANY_ID&engine=kosit"
ENGINE_SK=$(json_field "$BODY" "engine")
test "$ENGINE_SK" = "kosit" && pass "Skonto invoice: engine=kosit" \
  || fail "Skonto: engine=$ENGINE_SK"
SK_ACCEPTANCE=$(json_field "$BODY" "acceptance")
test "$SK_ACCEPTANCE" = "ACCEPTABLE" && pass "Tier 117: Skonto acceptance=ACCEPTABLE" \
  || fail "Tier 117: Skonto acceptance=$SK_ACCEPTANCE (expected ACCEPTABLE)"

# Test 3.2: B2G invoice (with Leitweg-ID as BuyerReference)
api_get "/api/v1/invoices/${INV_B2G}/xrechnung/validate?companyId=$COMPANY_ID&engine=kosit"
ENGINE_B2G=$(json_field "$BODY" "engine")
test "$ENGINE_B2G" = "kosit" && pass "B2G invoice: engine=kosit" \
  || fail "B2G: engine=$ENGINE_B2G"
B2G_ACCEPTANCE=$(json_field "$BODY" "acceptance")
test "$B2G_ACCEPTANCE" = "ACCEPTABLE" && pass "Tier 117: B2G acceptance=ACCEPTABLE" \
  || fail "Tier 117: B2G acceptance=$B2G_ACCEPTANCE (expected ACCEPTABLE)"

# Test 3.3: B2B-OSS (Austrian buyer)
api_get "/api/v1/invoices/${INV_OSS}/xrechnung/validate?companyId=$COMPANY_ID&engine=kosit"
OSS_ACCEPTANCE=$(json_field "$BODY" "acceptance")
test "$OSS_ACCEPTANCE" = "ACCEPTABLE" && pass "Tier 117: B2B-OSS acceptance=ACCEPTABLE" \
  || fail "Tier 117: B2B-OSS acceptance=$OSS_ACCEPTANCE (expected ACCEPTABLE)"

# ───── 4. Engine=invalid → 400 ─────
note "=== 4. engine=invalid → 400 ==="
BAD_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID&engine=invalid")
test "$BAD_STATUS" = "400" && pass "engine=invalid → 400" \
  || fail "engine=invalid → $BAD_STATUS (expected 400)"

# ───── 5. Cross-tenant → 401 ─────
note "=== 5. No x-user-id → 401 ==="
NO_AUTH=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID&engine=kosit")
test "$NO_AUTH" = "401" && pass "no auth → 401" \
  || fail "no auth → $NO_AUTH (expected 401)"

# ───── 6. graceful fallback when KoSIT unavailable ─────
note "=== 6. Graceful fallback when KoSIT JAR missing ==="
# Temporarily move the JAR to simulate "not installed"
mv "$KOSIT_ROOT/validator.jar" "$KOSIT_ROOT/validator.jar.tmp"
api_get "/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID&engine=kosit"
FB_ENGINE=$(json_field "$BODY" "engine")
test "$FB_ENGINE" = "kosit-unavailable" && pass "fallback engine=kosit-unavailable" \
  || fail "fallback engine=$FB_ENGINE (expected kosit-unavailable)"
# Should have a warning about the missing JAR
HAS_FB_WARN=$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);w=d.get('warnings',[]);print(any('KoSIT' in w.get('message','') or 'kosit' in w.get('message','') for w in w))")
test "$HAS_FB_WARN" = "True" && pass "fallback warning mentions KoSIT" \
  || fail "fallback warning missing"
# Restore JAR
mv "$KOSIT_ROOT/validator.jar.tmp" "$KOSIT_ROOT/validator.jar"
pass "restored validator.jar"

# ───── 7. engine=basic still works after fallback test ─────
note "=== 7. engine=basic still works ==="
api_get "/api/v1/invoices/${INV_B2B}/xrechnung/validate?companyId=$COMPANY_ID&engine=basic"
VAL_OK2=$(json_field "$BODY" "valid")
test "$VAL_OK2" = "True" && pass "basic still works after fallback" \
  || fail "basic broke after fallback: $VAL_OK2"

# Cleanup tmp
rm -f /tmp/kosIT-*.log

summary "Tier 116 — KoSIT Validator 1.6.2 integration"
