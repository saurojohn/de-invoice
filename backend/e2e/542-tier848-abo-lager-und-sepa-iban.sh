#!/bin/bash
# Tier 848 — a recurring template's goods leave the stock; a SEPA transfer
# file takes only IBANs that are one, and names the account holder.
#
# Measured before:
#  - a tracked product billed by a template, 2 a month: the stock stayed at
#    10 — issued by the run, or as a draft issued by hand. The invoice's
#    lines were written without their product („not implemented yet“);
#  - a supplier's IBAN was checked for its first four characters: one with a
#    wrong check digit (a row from before Tier 527) went into the pain.001,
#    which the bank refuses as a whole;
#  - the payee of a transfer was always the supplier's name: the account
#    holder is stored as `accountHolder`, the file read `kontoinhaber`.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F); IN3=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=3)).isoformat())")
TAG="e2e-542-$(date +%s%N | cut -c1-13)"
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier848-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
fixture_issuer "$C"; q="companyId=$C"
AS PUT "/api/v1/companies/$C?$q" '{"bankInfo":{"bankName":"Testbank","iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
assert_status 200 "fixture: the company with its bank account"
AS POST "/api/v1/customers?$q" '{"name":"Kunde 542 GmbH","type":"business","address":{"street":"S 1","postalCode":"10115","city":"Berlin","country":"DE"}}'; K=$(json_field "$BODY" id)

note "=== 1. the goods of a recurring invoice leave the stock ==="
PRODUCT="{\"name\":\"Filter\",\"sku\":\"FIL-$TAG\",\"basePrice\":20,\"vatRate\":0.19,\"unit\":\"Stk\",\"stockQuantity\":10,\"trackInventory\":true}"
AS POST "/api/v1/products?$q" "$PRODUCT"; PR=$(json_field "$BODY" id)
assert_status 201 "fixture: a tracked product, 10 in stock"
stock() { PSQL "select \"stockQuantity\"::numeric(12,2) from \"Product\" where id='$PR'"; }
run() { # invoiceStatus [productNumber] → INV
  local b="{\"customerId\":\"$K\",\"name\":\"Filter-Abo $1\",\"interval\":\"monthly\",\"dayOfMonth\":1,\"startDate\":\"$TODAY\",\"invoiceStatus\":\"$1\",\"sendEmail\":false,\"items\":[{\"description\":\"Filter\",\"productNumber\":\"${2-FIL-$TAG}\",\"quantity\":2,\"unit\":\"Stk\",\"unitPrice\":20,\"vatRate\":0.19}]}"
  AS POST "/api/v1/recurring-invoices?$q" "$b"; local t; t=$(json_field "$BODY" id)
  AS POST "/api/v1/recurring-invoices/$t/run?$q" '{}'
  assert_status 201 "a run of a template with invoices „$1“"
  INV=$(json_field "$BODY" invoiceId)
}
run sent
assert_eq "the run issued 2: 8 in stock (was: 10)" "$(stock)" "8.00"
assert_eq "…and the invoice's line carries its product (was: none)" "$(PSQL "select \"productId\" from \"InvoiceItem\" where \"invoiceId\"='$INV'")" "$PR"
run draft
assert_eq "a draft takes nothing yet" "$(stock)" "8.00"
AS PUT "/api/v1/invoices/$INV/status?$q" '{"status":"sent"}'
assert_status 200 "the draft issued by hand"
assert_eq "…now its 2 have left: 6 (was: 10)" "$(stock)" "6.00"
AS POST "/api/v1/invoices/$INV/credit-note?$q" '{"reason":"Storno"}'
assert_eq "its Storno gives them back: 8" "$STATUS/$(stock)" "201/8.00"
run sent "GIBT-ES-NICHT"
assert_eq "a line whose number names no product: the invoice is made, without one, the stock as it was" \
  "$(PSQL "select coalesce(\"productId\", 'none') from \"InvoiceItem\" where \"invoiceId\"='$INV'")/$(stock)" "none/8.00"

note "=== 2. the SEPA transfer file ==="
SUP='{"name":"Lieferant 542 GmbH","bankInfo":{"iban":"de89 3704 0044 0532 0130 00","bic":"COBADEFFXXX","accountHolder":"Inhaberin Erika Muster"}}'
AS POST "/api/v1/suppliers?$q" "$SUP"; SU=$(json_field "$BODY" id)
assert_status 201 "fixture: a supplier whose account is held by someone else, the IBAN typed in lower case"
bill() { # number → id
  local b="{\"description\":\"Material\",\"invoiceDate\":\"$TODAY\",\"invoiceNumber\":\"R-$1\",\"supplierId\":\"$SU\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119,\"category\":\"Material\"}"
  AS POST "/api/v1/expenses?$q" "$b"; json_field "$BODY" id
}
batch() { local b="{\"companyId\":\"$C\",\"expenseIds\":[\"$1\"],\"executionDate\":\"$IN3\"}"; AS POST "/api/v1/payments/batches?$q" "$b"; }
# whatever the form stored, the file must carry the IBAN in capitals
PSQL "update \"Supplier\" set \"bankInfo\" = \"bankInfo\" || '{\"iban\":\"de89 3704 0044 0532 0130 00\"}'::jsonb where id='$SU'" >/dev/null
E1=$(bill 1); batch "$E1"
assert_status 201 "a transfer to it"
B=$(json_field "$BODY" id)
XML=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/payments/batches/$B/xml?$q")
assert_eq "the payee is the account holder (was: the supplier's name), the IBAN in capitals without spaces" \
  "$(echo "$XML" | python3 -c "import re,sys;x=sys.stdin.read();print(re.findall(r'<Cdtr>\s*<Nm>([^<]*)', x), re.findall(r'<CdtrAcct>\s*<Id>\s*<IBAN>([^<]*)', x))")" \
  "['Inhaberin Erika Muster'] ['DE89370400440532013000']"
AS POST "/api/v1/payments/batches/$B/cancel?$q" '{}'
# a row from before Tier 527: an IBAN with a wrong check digit
PSQL "update \"Supplier\" set \"bankInfo\" = '{\"iban\":\"DE00370400440532013000\"}'::jsonb where id='$SU'" >/dev/null
E2=$(bill 2); batch "$E2"
assert_status 400 "a transfer to an IBAN with a wrong check digit is refused (was: 201, in the file)"
[[ "$BODY" == *"R-2"* && "$BODY" == *"Prüfziffer"* ]] && pass "…naming the bill and the reason" || fail "message: $BODY"
assert_eq "…and no batch was made for it" "$(PSQL "select count(*) from \"Expense\" where id='$E2' and \"paidAt\" is not null")" "0"
PSQL "update \"Supplier\" set \"bankInfo\" = '{\"iban\":\"DE89370400440532013000\"}'::jsonb where id='$SU'" >/dev/null
batch "$E2"
assert_status 201 "without an account holder the payee is the supplier"
XML=$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/payments/batches/$(json_field "$BODY" id)/xml?$q")
assert_eq "…by name" "$(echo "$XML" | python3 -c "import re,sys;print(re.findall(r'<Cdtr>\s*<Nm>([^<]*)', sys.stdin.read()))")" "['Lieferant 542 GmbH']"
summary
