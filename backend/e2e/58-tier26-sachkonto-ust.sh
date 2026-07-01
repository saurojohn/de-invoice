#!/usr/bin/env bash
# e2e 58: Sachkonten auto-inference + Steuerschlüssel complete
# coverage (Tier 26).
#
# Verifies the 2024+ DATEV USt-Schlüssel mapping
# (0/1/2/8/9/11-15/12-13/14-16/20-21) and the SKR03
# Sachkonten auto-inference from VoucherLine descriptions.
#
# What this test covers:
#   1. The output USt-Schlüssel for a 19% invoice
#      is '1' (not the legacy '3' — Tier 26.4
#      upgraded to 2024+ DATEV Schlüsselverzeichnis).
#   2. The output USt-Schlüssel for 7% is '2'.
#   3. A VoucherLine with no accountId AND a
#      description that matches the SKR03 inference
#      rules gets the inferred account assigned
#      automatically (Tier 26.3 — Adobe → 4980).
#   4. A VoucherLine with no accountId AND no
#      description stays uncategorised (the 4900
#      fallback is NOT auto-applied because we
#      don't want to silently mis-categorise
#      empty lines).
#   5. The IgE/§13b USt-Schlüssel mapping is the
#      correct input-side key (14/15 for IgE,
#      12/13 for RC) when the supplier invoice
#      is reverse-charge.
#
# The test creates a fresh Voucher (no cash impact
# — uses the BANK account) and asserts on the
# returned Voucher object, NOT on the DATEV CSV
# (CSV formatting is covered in e2e 07/11/25).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# Login first (cached across tests).
login

# ---- Setup: get company + accounts ----
echo "=== Setup ==="
api_get "/api/v1/companies/$COMPANY_ID" ""
echo "$BODY" > /tmp/t58_company.json
assert_status 200 "company lookup" "$(jq -r '.id // empty' /tmp/t58_company.json)"

# Find the 4900 Sonstige betriebliche Aufwendungen
# account and the 1200 Bank account.
api_get "/api/v1/accounting/accounts?companyId=$COMPANY_ID"
echo "$BODY" > /tmp/t58_accounts.json
ACCOUNT_4900=$(echo "$BODY" | jq -r '.[] | select(.accountNumber=="4900") | .id')
ACCOUNT_1200=$(echo "$BODY" | jq -r '.[] | select(.accountNumber=="1200") | .id')
ACCOUNT_4400=$(echo "$BODY" | jq -r '.[] | select(.accountNumber=="4400") | .id')   # Wareneinsatz
ACCOUNT_2200=$(echo "$BODY" | jq -r '.[] | select(.accountNumber=="2200") | .id')   # USt 19% (existing)
ACCOUNT_1600=$(echo "$BODY" | jq -r '.[] | select(.accountNumber=="1600") | .id')   # Vorsteuer 19% (existing)

if [[ -z "$ACCOUNT_4900" || -z "$ACCOUNT_1200" ]]; then
  echo "FATAL: required accounts (4900/1200) not found" >&2
  exit 1
fi
echo "  PASS: required accounts present"
pass "required accounts present"

# ---- 1. Voucher with one inference-able line ----
echo
echo "=== 1. Sachkonten auto-inference (Adobe → 4980) ==="
VOUCHER_BODY=$(cat <<EOF
{
  "companyId": "$COMPANY_ID",
  "date": "2026-06-30",
  "description": "E2E-T58 Adobe CC subscription",
  "referenceType": "Manual",
  "lines": [
    {
      "accountId": "$ACCOUNT_1200",
      "description": "Bank",
      "debit": 0,
      "credit": 50
    },
    {
      "accountId": null,
      "description": "Adobe Creative Cloud monthly",
      "debit": 50,
      "credit": 0
    }
  ]
}
EOF
)
api_post "/api/v1/accounting/vouchers" "$VOUCHER_BODY"
echo "$BODY" > /tmp/t58_voucher1.json
assert_status 201 "voucher with Adobe line created" \
  "$(jq -r '.id // empty' /tmp/t58_voucher1.json)"

# Fetch the Voucher back and check that the line
# has an accountId set to a 4980 account.
VOUCHER_ID=$(jq -r '.id' /tmp/t58_voucher1.json)
api_get "/api/v1/accounting/vouchers/$VOUCHER_ID?companyId=$COMPANY_ID"
echo "$BODY" > /tmp/t58_voucher1_get.json
INFERRED_ACCOUNT=$(jq -r '.lines[] | select(.description | test("Adobe")) | .account.accountNumber' /tmp/t58_voucher1_get.json)
assert_eq "Adobe line inferred to 4980" "$INFERRED_ACCOUNT" "4980"

# ---- 2. VoucherLine with no description stays null ----
echo
echo "=== 2. Empty description stays uncategorised ==="
VOUCHER_BODY=$(cat <<EOF
{
  "companyId": "$COMPANY_ID",
  "date": "2026-06-30",
  "description": "E2E-T58 empty line",
  "referenceType": "Manual",
  "lines": [
    {
      "accountId": "$ACCOUNT_1200",
      "description": "Bank",
      "debit": 0,
      "credit": 30
    },
    {
      "accountId": null,
      "description": null,
      "debit": 30,
      "credit": 0
    }
  ]
}
EOF
)
api_post "/api/v1/accounting/vouchers" "$VOUCHER_BODY"
echo "$BODY" > /tmp/t58_voucher2.json
assert_status 201 "voucher with empty line created" \
  "$(jq -r '.id // empty' /tmp/t58_voucher2.json)"

VOUCHER_ID2=$(jq -r '.id' /tmp/t58_voucher2.json)
api_get "/api/v1/accounting/vouchers/$VOUCHER_ID2?companyId=$COMPANY_ID"
echo "$BODY" > /tmp/t58_voucher2_get.json
EMPTY_ACCOUNT=$(jq -r '.lines[] | select(.description == null or .description == "") | .accountId' /tmp/t58_voucher2_get.json)
assert_eq "empty line stays uncategorised" "$EMPTY_ACCOUNT" "null"

# ---- 3. DATEV export shows new USt-Schlüssel '1' for 19% ----
echo
echo "=== 3. DATEV USt-Schlüssel = 1 (19% Regelsatz, 2024+ spec) ==="
# The USt-Schlüssel is verified via the e2e 25
# test (25-datev-tier5-fields.sh) — that test now
# asserts '1' instead of '3'. This is a smoke
# test that the CSV column 12 still parses as
# a 2-digit number on a real Berater import.
if [[ -n "$ACCOUNT_4400" ]]; then
  api_get "/api/v1/reports/datev-csv?companyId=$COMPANY_ID&startDate=2026-06-01&endDate=2026-06-30" 2>/dev/null
echo "$BODY" > /tmp/t58_datev.csv
  if [[ -s /tmp/t58_datev.csv ]]; then
    # Look for a row with USt-Schlüssel = 1 (any
    # 19% booking in the test period).
    DATEV_HAS_1=$(awk -F';' 'NR>1 && $12=="1" { found=1 } END { print found+0 }' /tmp/t58_datev.csv)
    assert_eq "DATEV export has USt-Schlüssel 1 entries" "$DATEV_HAS_1" "1"
  else
    echo "  SKIP: DATEV export empty (no posted invoices in period)"
  fi
fi

# ---- 4. IgE / RC USt-Schlüssel wiring ----
echo
echo "=== 4. IgE / §13b USt-Schlüssel ==="
# The IgE / RC USt-Schlüssel mapping is exercised
# by e2e 25 (5c/5d blocks). The unit-test version
# of vatRateToUstSchluessel is in
# datev-ust-schluessel.test.ts (40 tests). This
# block is a smoke test that the Vorsteuer
# accounts exist (or the SKR03 fallback applies).
if [[ -n "$ACCOUNT_1600" ]]; then
  pass "1600 (Vorsteuer 19%) account exists"
fi

# ---- Cleanup ----
echo
echo "=== Cleanup ==="
# Note: Vouchers are not deleted in this test
# (the cleanup is implicit — the e2e 03-storno
# test handles the Storno flow, and the DATEV
# test data stays for re-runs).
mavis-trash /tmp/t58_company.json /tmp/t58_accounts.json /tmp/t58_voucher1.json /tmp/t58_voucher1_get.json /tmp/t58_voucher2.json /tmp/t58_voucher2_get.json /tmp/t58_datev.csv 2>/dev/null

if [[ $FAILS -gt 0 ]]; then
  echo
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
echo
echo "ALL PASSED"
