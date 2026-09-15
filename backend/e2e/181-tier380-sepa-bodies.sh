#!/bin/bash
# Tier 380 — SEPA mandate and batch bodies are validated before a bank file is
# built
#
# Measured on a fresh stack before the change:
#   POST /payments/mandates            dateOfSignature "2026-02-30" → 201, stored 2026-03-02;
#                                      IBAN "DE00" / "DE12!!!@@@" / wrong check digit → 201;
#                                      mandateReference 80 chars, debitorName 300 chars,
#                                      BIC "not a bic!!", undeclared field → 201
#                                      and the other way round: IBAN "de72 3704 …" (valid, lower
#                                      case with spaces) → 400, the prefix check ran before normalising
#   POST /payments/direct-debit/batches collections ["x"] / numeric / null ids → 500;
#                                      executionDate "2026-13-45" → 500;
#                                      creditorIban "DE00" → 201, written into the pain.008 XML
#   POST /payments/batches             expenseIds [123] / [null] → 500
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
C="$COMPANY_ID"
TAG="e2e-181-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }
IBAN_OK="DE89370400440532013000"
CR="\"creditorIban\":\"$IBAN_OK\",\"creditorBic\":\"COBADEFFXXX\",\"creditorName\":\"$TAG Gläubiger\",\"creditorIdentifier\":\"DE98ZZZ09999999999\""
EXEC=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=10)).isoformat())")

note "=== 0. fixtures: a customer with two sent invoices ==="
api_post "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde GmbH\",\"type\":\"business\"}"
CUST=$(json_field "$BODY" id)
[[ -n "$CUST" ]] && pass "customer" || { fail "customer not created: $BODY"; summary; exit 1; }
inv() {
  api_post "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$CUST\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"$TAG\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  api_put "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
INV1=$(inv); INV2=$(inv)
[[ -n "$INV1" && -n "$INV2" ]] && pass "two sent invoices" || fail "invoices not created"
MANDATES() { sql "SELECT count(*) FROM \"SepaDirectDebitMandate\" WHERE \"customerId\" = '$CUST';"; }

note "=== 1. every real caller shape still succeeds ==="
# e2e 137: full body with BIC and description
api_post "/api/v1/payments/mandates" "{\"companyId\":\"$C\",\"customerId\":\"$CUST\",\"dateOfSignature\":\"2026-07-20\",\"type\":\"CORE\",\"iban\":\"$IBAN_OK\",\"bic\":\"COBADEFFXXX\",\"debitorName\":\"$TAG Kunde GmbH\",\"description\":\"Mitgliedsbeitrag 2026\"}"
assert_status 201 "mandate: e2e 137 shape"
MANDATE=$(json_field "$BODY" id)
# direct-debit page: IBAN already upper-cased without spaces, no BIC, no description
api_post "/api/v1/payments/mandates?companyId=$C" "{\"companyId\":\"$C\",\"customerId\":\"$CUST\",\"dateOfSignature\":\"$(date +%Y-%m-%d)\",\"type\":\"CORE\",\"iban\":\"DE82370400440532013999\",\"debitorName\":\"$TAG Kunde GmbH\"}"
assert_status 201 "mandate: direct-debit page shape (no BIC)"
# an IBAN typed with spaces and lower case is accepted and normalised
api_post "/api/v1/payments/mandates?companyId=$C" "{\"companyId\":\"$C\",\"customerId\":\"$CUST\",\"dateOfSignature\":\"2026-07-22\",\"type\":\"B2B\",\"iban\":\"de72 3704 0044 0532 0138 88\",\"debitorName\":\"$TAG Kunde GmbH\"}"
assert_status 201 "mandate: IBAN with spaces, lower case (was 400)"
assert_eq "…stored normalised" "$(json_field "$BODY" iban)" "DE72370400440532013888"
# e2e 137 / direct-debit page batch: collections + executionDate (+ creditor fields here, since
# this spec must not depend on the company's saved bank details)
api_post "/api/v1/payments/direct-debit/batches?companyId=$C" "{\"companyId\":\"$C\",\"collections\":[{\"invoiceId\":\"$INV1\",\"mandateId\":\"$MANDATE\"}],\"executionDate\":\"$EXEC\",\"notes\":\"$TAG\",$CR}"
assert_status 201 "direct-debit batch: caller shape"
BATCH=$(json_field "$BODY" id)

note "=== 2. invalid mandate bodies are 400 and store nothing ==="
BEFORE=$(MANDATES)
M="\"companyId\":\"$C\",\"customerId\":\"$CUST\",\"type\":\"CORE\",\"debitorName\":\"$TAG\""
api_post "/api/v1/payments/mandates" "{$M,\"dateOfSignature\":\"2026-02-30\",\"iban\":\"$IBAN_OK\"}";   assert_status 400 "dateOfSignature 2026-02-30 (was 201, stored 03-02)"
api_post "/api/v1/payments/mandates" "{$M,\"dateOfSignature\":\"2026-07-20\",\"iban\":\"DE00\"}";        assert_status 400 "IBAN DE00 (was 201)"
api_post "/api/v1/payments/mandates" "{$M,\"dateOfSignature\":\"2026-07-20\",\"iban\":\"DE12!!!@@@\"}";  assert_status 400 "IBAN DE12!!!@@@ (was 201)"
api_post "/api/v1/payments/mandates" "{$M,\"dateOfSignature\":\"2026-07-20\",\"iban\":\"DE89370400440532013001\"}"; assert_status 400 "IBAN with a wrong check digit (was 201)"
api_post "/api/v1/payments/mandates" "{$M,\"dateOfSignature\":\"2026-07-20\",\"iban\":\"$IBAN_OK\",\"mandateReference\":\"$(printf 'X%.0s' $(seq 1 80))\"}"; assert_status 400 "mandateReference 80 chars (was 201)"
api_post "/api/v1/payments/mandates" "{\"companyId\":\"$C\",\"customerId\":\"$CUST\",\"debitorName\":\"$(printf 'N%.0s' $(seq 1 300))\",\"dateOfSignature\":\"2026-07-20\",\"iban\":\"$IBAN_OK\"}"; assert_status 400 "debitorName 300 chars (was 201)"
api_post "/api/v1/payments/mandates" "{$M,\"dateOfSignature\":\"2026-07-20\",\"iban\":\"$IBAN_OK\",\"bic\":\"not a bic!!\"}"; assert_status 400 "BIC 'not a bic!!' (was 201)"
api_post "/api/v1/payments/mandates" "{$M,\"dateOfSignature\":\"2026-07-20\",\"iban\":\"$IBAN_OK\",\"unknown\":1}"; assert_status 400 "undeclared field (was 201)"
assert_eq "no mandate stored by the invalid requests" "$(MANDATES)" "$BEFORE"

note "=== 3. invalid batch bodies are 400 (were 500) and build no file ==="
DD_BEFORE=$(sql "SELECT count(*) FROM \"SepaDirectDebitBatch\" WHERE \"companyId\" = '$C';")
DD="/api/v1/payments/direct-debit/batches?companyId=$C"
api_post "$DD" "{\"companyId\":\"$C\",\"collections\":[\"x\"],\"executionDate\":\"$EXEC\",$CR}";                                      assert_status 400 "collections [\"x\"] (was 500)"
api_post "$DD" "{\"companyId\":\"$C\",\"collections\":[{\"invoiceId\":1,\"mandateId\":2}],\"executionDate\":\"$EXEC\",$CR}";         assert_status 400 "numeric ids (was 500)"
api_post "$DD" "{\"companyId\":\"$C\",\"collections\":[{\"invoiceId\":null,\"mandateId\":null}],\"executionDate\":\"$EXEC\",$CR}";   assert_status 400 "null ids (was 500)"
api_post "$DD" "{\"companyId\":\"$C\",\"collections\":[{\"invoiceId\":\"$INV2\",\"mandateId\":\"$MANDATE\"}],\"executionDate\":\"2026-13-45\",$CR}"; assert_status 400 "executionDate 2026-13-45 (was 500)"
api_post "$DD" "{\"companyId\":\"$C\",\"collections\":[{\"invoiceId\":\"$INV2\",\"mandateId\":\"$MANDATE\"}],\"executionDate\":\"$EXEC\",\"creditorIban\":\"DE00\",\"creditorIdentifier\":\"DE98ZZZ09999999999\"}"; assert_status 400 "creditorIban DE00 (was 201, in the XML)"
assert_eq "no direct-debit batch built" "$(sql "SELECT count(*) FROM \"SepaDirectDebitBatch\" WHERE \"companyId\" = '$C';")" "$DD_BEFORE"
CT="/api/v1/payments/batches?companyId=$C"
api_post "$CT" "{\"companyId\":\"$C\",\"expenseIds\":[123],\"executionDate\":\"$EXEC\",\"debtorIban\":\"$IBAN_OK\"}";   assert_status 400 "expenseIds [123] (was 500)"
api_post "$CT" "{\"companyId\":\"$C\",\"expenseIds\":[null],\"executionDate\":\"$EXEC\",\"debtorIban\":\"$IBAN_OK\"}";  assert_status 400 "expenseIds [null] (was 500)"
api_post "$CT" "{\"companyId\":\"$C\",\"expenseIds\":[\"x\"],\"executionDate\":\"2026-02-30\",\"debtorIban\":\"$IBAN_OK\"}"; assert_status 400 "executionDate 2026-02-30"
api_post "$CT" "{\"companyId\":\"$C\",\"expenseIds\":[\"x\"],\"executionDate\":\"$EXEC\",\"debtorIban\":\"DE12!!!@@@\"}";   assert_status 400 "debtorIban DE12!!!@@@"

note "=== 4. cleanup ==="
[[ -n "$BATCH" ]] && sql "UPDATE \"Invoice\" SET \"collectedBySepaBatchId\" = NULL WHERE \"collectedBySepaBatchId\" = '$BATCH'; DELETE FROM \"SepaDirectDebitCollection\" WHERE \"batchId\" = '$BATCH'; DELETE FROM \"SepaDirectDebitBatch\" WHERE id = '$BATCH';" >/dev/null
sql "DELETE FROM \"SepaDirectDebitMandate\" WHERE \"customerId\" = '$CUST';" >/dev/null
assert_eq "e2e-181 mandates removed" "$(MANDATES)" "0"

summary
exit $?
