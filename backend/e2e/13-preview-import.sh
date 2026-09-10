#!/bin/bash
# Test 13: Bank statement preview (parse without persist)
# - POST /bank-statements/preview with a valid MT940 file
#   returns parsed header (format, IBAN, bank, period,
#   balances) + the sample transactions
# - balanceCheck is computed: opening + credits − debits
#   vs closing balance
# - take parameter caps the sample size
# - Empty file → 400
# - Invalid file (not MT940 or CAMT) → 400
# - NO BankStatement row is created (parse-only)
# - The response is the same shape the frontend shows
#   in the preview modal

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

echo "=== Test: bank statement preview ==="

# Snapshot existing BankStatement count so we can verify
# nothing was created by the preview calls.
PRE_COUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';" 2>/dev/null | tr -d ' ')

# Test 1: well-formed MT940 (passes balance check)
# Build a minimal MT940 inline. Opening=1000, one credit
# of 500, one debit of 200, expected close=1300.
MT940_OK=$(printf '%s\n' \
'{1:F01SPKEDE33XXX0000000000}{2:I940SPKEDE33XXXXN}{4:' \
':20:OKTEST' \
':25:DE32500105170648489890' \
':28C:1/1' \
':60F:C260601EUR1000,00' \
':61:2606010601C500,00N024NONREF//BANK' \
'KUNDE MÜLLER' \
'INV-2026-T1' \
':86:KUNDE MÜLLER' \
'INV-2026-T1' \
':61:2606020602D200,00N024NONREF//BANK' \
'LIEFERANT XYZ' \
':86:LIEFERANT XYZ' \
':62F:C260602EUR1300,00' \
'-' \
'}' \
)
echo "$MT940_OK" > /tmp/preview-ok.mt940

HTTP=$(curl -sS -o /tmp/preview-resp.json -w "%{http_code}" \
  -X POST "http://localhost:3001/api/v1/bank-statements/preview" \
  -F "file=@/tmp/preview-ok.mt940" \
  -F "take=10" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID")
# Nest's default POST status is 201 (Created). The
# preview endpoint is parse-only but still uses
# @Post, so the response is 201.
assert_eq "preview HTTP (balanced MT940)" "$HTTP" "201"

FMT=$(json_field "$(cat /tmp/preview-resp.json)" format)
IBAN=$(json_field "$(cat /tmp/preview-resp.json)" accountIban)
TCOUNT=$(json_field "$(cat /tmp/preview-resp.json)" totalTransactions)
BCHECK=$(json_field "$(cat /tmp/preview-resp.json)" balanceCheck)
DEBIT=$(json_field "$(cat /tmp/preview-resp.json)" totalDebit)
CREDIT=$(json_field "$(cat /tmp/preview-resp.json)" totalCredit)
SAMPLE_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['sampleTransactions']))" < /tmp/preview-resp.json)
OPEN=$(json_field "$(cat /tmp/preview-resp.json)" openingBalance)
CLOSE=$(json_field "$(cat /tmp/preview-resp.json)" closingBalance)

assert_eq "preview format" "$FMT" "mt940"
assert_eq "preview IBAN" "$IBAN" "DE32500105170648489890"
assert_eq "preview totalTransactions" "$TCOUNT" "2"
assert_eq "preview balanceCheck (balanced)" "$BCHECK" "ok"
assert_eq "preview totalDebit (200)" "$DEBIT" "200.00"
assert_eq "preview totalCredit (500)" "$CREDIT" "500.00"
assert_eq "preview sample length" "$SAMPLE_LEN" "2"
# Prisma returns numeric values as strings without
# forced decimal padding. "1000.00" comes from the
# .toFixed(2) in the service, but values that came
# out of the parser as whole numbers are passed
# through Decimal which strips trailing zeros on
# stringify. Either is acceptable — assert the
# numeric value rather than the string format.
assert_eq "preview opening balance (numeric)" \
  "$(python3 -c "print(float('$OPEN'))")" "1000.0"
assert_eq "preview closing balance (numeric)" \
  "$(python3 -c "print(float('$CLOSE'))")" "1300.0"

# Test 2: take=1 returns only 1 sample transaction
HTTP=$(curl -sS -o /tmp/preview-t1.json -w "%{http_code}" \
  -X POST "http://localhost:3001/api/v1/bank-statements/preview" \
  -F "file=@/tmp/preview-ok.mt940" \
  -F "take=1" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID")
# Nest's @Post default status is 201 (Created). The
# preview endpoint doesn't create anything but the
# default is still 201 — the frontend doesn't care.
assert_eq "preview HTTP (take=1)" "$HTTP" "201"
SAMPLE_LEN=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['sampleTransactions']))" < /tmp/preview-t1.json)
assert_eq "take=1 sample length" "$SAMPLE_LEN" "1"
# But totalTransactions still reflects the full count
TCOUNT=$(json_field "$(cat /tmp/preview-t1.json)" totalTransactions)
assert_eq "take=1 totalTransactions (still 2)" "$TCOUNT" "2"

# Test 3: unbalanced MT940 (opening + credits − debits ≠
# closing) → balanceCheck='mismatch'
MT940_BAD=$(printf '%s\n' \
'{1:F01SPKEDE33XXX0000000000}{2:I940SPKEDE33XXXXN}{4:' \
':20:BADTEST' \
':25:DE32500105170648489890' \
':28C:1/1' \
':60F:C260601EUR1000,00' \
':61:2606010601C500,00N024NONREF//BANK' \
'KUNDE' \
':86:KUNDE' \
':61:2606020602D200,00N024NONREF//BANK' \
'LIEFERANT' \
':86:LIEFERANT' \
':62F:C260602EUR9999,99' \
'-' \
'}' \
)
echo "$MT940_BAD" > /tmp/preview-bad.mt940

HTTP=$(curl -sS -o /tmp/preview-bad.json -w "%{http_code}" \
  -X POST "http://localhost:3001/api/v1/bank-statements/preview" \
  -F "file=@/tmp/preview-bad.mt940" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "preview HTTP (unbalanced MT940)" "$HTTP" "201"
BCHECK=$(json_field "$(cat /tmp/preview-bad.json)" balanceCheck)
assert_eq "balanceCheck (mismatch)" "$BCHECK" "mismatch"

# Test 4: empty file → 400
echo "" > /tmp/preview-empty.mt940
HTTP=$(curl -sS -o /tmp/preview-empty.json -w "%{http_code}" \
  -X POST "http://localhost:3001/api/v1/bank-statements/preview" \
  -F "file=@/tmp/preview-empty.mt940" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "empty file rejected" "$HTTP" "400"

# Test 5: garbage content → 400
echo "this is not a bank statement" > /tmp/preview-garbage.mt940
HTTP=$(curl -sS -o /tmp/preview-garbage.json -w "%{http_code}" \
  -X POST "http://localhost:3001/api/v1/bank-statements/preview" \
  -F "file=@/tmp/preview-garbage.mt940" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: $COMPANY_ID")
assert_eq "garbage file rejected" "$HTTP" "400"

# Test 6: NO BankStatement was created (parse-only)
POST_COUNT=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT count(*) FROM \"BankStatement\" WHERE \"companyId\" = '$COMPANY_ID';" 2>/dev/null | tr -d ' ')
assert_eq "no BankStatement created by preview" "$POST_COUNT" "$PRE_COUNT"

# Cleanup test files
mavis-trash /tmp/preview-ok.mt940 /tmp/preview-bad.mt940 /tmp/preview-empty.mt940 /tmp/preview-garbage.mt940 /tmp/preview-resp.json /tmp/preview-t1.json /tmp/preview-bad.json /tmp/preview-empty.json /tmp/preview-garbage.json 2>/dev/null

echo
summary
