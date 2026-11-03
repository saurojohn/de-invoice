#!/bin/bash
# Tier 783 — the same request sent several times at once
#
# A sweep sent every write route of one company six times at once and read the
# database after each burst (5xx answers, rows that are copies of each other,
# invariants of the books). Tier 534 had locked the payment, credit and bank
# paths; what was left:
#   - the first document of a year (or of a company): CREATE SEQUENCE IF NOT
#     EXISTS of two transactions at once — five of six invoices answered 500
#   - the annual AfA booked the year six times, the monthly run twelve months
#     six times, the AfA Storno reversed every row six times
#   - six saves of one UStVA month made six filings
#   - a voucher Storno: one Storno and five 500s; a correction reverses and
#     books anew: two at once each did — and so did two one after the other
#     (its "already reversed" check read the wrong field)
#   - a manual bank match: five 500s on the unique key
#   - SEPA mandates (the next reference), reminder templates (seeded on first
#     use): 500s on the unique key
#   - the OCR supplier match created the same supplier six times
# and, not of concurrency: the statement e-mail took an unparsable date (500).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-488-$(date +%s%N | cut -c1-13)"
# Tier 791: last year — its dates (June, an asset of 15 January) were in the
# future from 1 January to June of every year
Y=$(( $(date +%Y) - 1 ))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
cat > "$D/burst.py" <<'PY'
import sys, json, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
api, user, company, n, method, path, body = sys.argv[1:8]
def one(_):
    r = urllib.request.Request(api + path, data=body.encode() if body else None, method=method,
                               headers={"Content-Type": "application/json", "x-user-id": user, "x-company-id": company})
    try:
        with urllib.request.urlopen(r, timeout=120) as x: return x.status
    except urllib.error.HTTPError as e: return e.code
with ThreadPoolExecutor(int(n)) as ex: print(" ".join(str(s) for s in sorted(ex.map(one, range(int(n))))))
PY
burst() { python3 "$D/burst.py" "$API" "$U" "$C" "$@"; }
no5xx() { [[ " $1 " != *" 5"* ]] && pass "$2: no 5xx ($1)" || fail "$2: $1"; }
AS() { curl -sS -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}; }
id() { python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier783-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user']['companyId'])")
q "update \"User\" set \"emailVerifiedAt\"=now() where id='$U'" >/dev/null
q "update \"Company\" set address='{\"street\":\"Teststr. 1\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"}'::jsonb, \"taxId\"='12/345/67890' where id='$C'" >/dev/null
K=$(AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}" | id)
[[ -n "$K" ]] && pass "fixture: a new company and its customer" || { fail "fixture"; summary; exit 1; }

note "=== the first invoices of a company, six at once ==="
st=$(burst 6 POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$Y-06-01\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}")
assert_eq "six invoices: all 201 (was one 201 and five 500)" "$st" "201 201 201 201 201 201"
assert_eq "…numbered 1 to 6" "$(q "select string_agg(right(\"invoiceNumber\",6), ' ' order by \"invoiceNumber\") from \"Invoice\" where \"companyId\"='$C'")" "000001 000002 000003 000004 000005 000006"

note "=== AfA ==="
AS POST "/api/v1/assets?companyId=$C" "{\"type\":\"Maschine\",\"bezeichnung\":\"$TAG Anlage\",\"anschaffungsDatum\":\"$Y-01-15\",\"anschaffungsKosten\":1200,\"nutzungsdauerMonate\":36}" >/dev/null
A=$(q "select id from \"Asset\" where \"companyId\"='$C'")
afa() { q "select count(*) from \"Expense\" where \"relatedAssetId\"='$A' and \"afaYear\"=$Y and \"afaReversedAt\" is null and \"reversesExpenseId\" is null"; }
st=$(burst 6 POST "/api/v1/assets/book-afa?companyId=$C&year=$Y" "")
no5xx "$st" "the annual AfA six times at once"
assert_eq "…one booking for the year (was six)" "$(afa)" "1"
st=$(burst 6 POST "/api/v1/assets/storno-afa?companyId=$C&year=$Y" "")
no5xx "$st" "the AfA Storno six times at once"
assert_eq "…the booking reversed once (was six times)" "$(q "select count(*) from \"Expense\" where \"reversesExpenseId\" in (select id from \"Expense\" where \"relatedAssetId\"='$A' and \"reversesExpenseId\" is null)")" "1"
st=$(burst 6 POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=$Y" "")
no5xx "$st" "the monthly AfA six times at once"
assert_eq "…twelve monthly bookings (was 72)" "$(afa)" "12"

note "=== UStVA ==="
FILING=$(AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=3" | python3 -c "import sys,json;d=json.load(sys.stdin);d['status']='draft';d['companyId']='$C';print(json.dumps(d))")
st=$(burst 6 POST "/api/v1/ustva/filings?companyId=$C" "$FILING")
no5xx "$st" "one month's filing saved six times at once"
assert_eq "…one filing for the month (was six)" "$(q "select count(*) from \"UStvaFiling\" where \"companyId\"='$C' and year=$Y and month=3")" "1"

note "=== vouchers ==="
AS GET "/api/v1/accounting/accounts/seed?companyId=$C" >/dev/null
A1=$(q "select id from \"Account\" where \"companyId\"='$C' and \"accountNumber\"='1200'"); A2=$(q "select id from \"Account\" where \"companyId\"='$C' and \"accountNumber\"='8200'")
lines="[{\"accountId\":\"$A1\",\"debit\":119,\"credit\":0},{\"accountId\":\"$A2\",\"debit\":0,\"credit\":119}]"
V=$(AS POST "/api/v1/accounting/vouchers?companyId=$C" "{\"companyId\":\"$C\",\"date\":\"$Y-06-01\",\"description\":\"$TAG Beleg\",\"createdById\":\"$U\",\"lines\":$lines}" | id)
st=$(burst 6 PUT "/api/v1/accounting/vouchers/$V/status?companyId=$C" '{"status":"voided"}')
assert_eq "a voucher voided six times at once: all 200 (was one 200 and five 500)" "$st" "200 200 200 200 200 200"
assert_eq "…one Storno" "$(q "select count(*) from \"Voucher\" where \"reversedById\"='$V'")" "1"
V2=$(AS POST "/api/v1/accounting/vouchers?companyId=$C" "{\"companyId\":\"$C\",\"date\":\"$Y-06-01\",\"description\":\"$TAG Beleg 2\",\"createdById\":\"$U\",\"lines\":$lines}" | id)
before=$(q "select count(*) from \"Voucher\" where \"companyId\"='$C'")
st=$(burst 2 POST "/api/v1/accounting/vouchers/$V2/correct?companyId=$C" "{\"date\":\"$Y-06-02T10:00:00.000Z\",\"description\":\"$TAG Korrektur\",\"reason\":\"e2e\",\"lines\":$lines}")
no5xx "$st" "a voucher corrected twice at once"
assert_eq "…one Storno and one new voucher (was two of each)" "$(( $(q "select count(*) from \"Voucher\" where \"companyId\"='$C'") - before ))" "2"
st=$(curl -sS -o "$D/k" -w '%{http_code}' -X POST "$API/api/v1/accounting/vouchers/$V2/correct?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d "{\"date\":\"$Y-06-03T10:00:00.000Z\",\"description\":\"$TAG Korrektur 2\",\"reason\":\"e2e\",\"lines\":$lines}")
assert_eq "correcting the same voucher again, afterwards: 400 (was a second Storno and K-voucher)" "$st" "400"
assert_eq "…the original reversed once" "$(q "select count(*) from \"Voucher\" where \"reversedById\"='$V2'")" "1"

note "=== a manual bank match ==="
I=$(q "select id from \"Invoice\" where \"companyId\"='$C' order by \"invoiceNumber\" limit 1")
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}' >/dev/null
SID=$(python3 -c "import uuid;print(uuid.uuid4())"); TID=$(python3 -c "import uuid;print(uuid.uuid4())")
q "insert into \"BankStatement\" (id, \"companyId\", format, \"fileName\", \"fileSize\", \"rawContent\", \"createdAt\") values ('$SID', '$C', 'csv', 'e2e.csv', 1, '[]', now());
   insert into \"BankTransaction\" (id, \"statementId\", \"companyId\", \"valueDate\", \"entryDate\", amount, currency, purpose, \"createdAt\") values ('$TID', '$SID', '$C', '$Y-06-05', '$Y-06-05', 119, 'EUR', '$TAG', now())" >/dev/null
st=$(burst 6 POST "/api/v1/bank-statements/$SID/transactions/$TID/match?companyId=$C" "{\"invoiceId\":\"$I\"}")
no5xx "$st" "one bank entry matched to one invoice six times at once (was five 500)"
assert_eq "…one confirmed match" "$(q "select count(*) from \"BankReconciliation\" where \"bankTransactionId\"='$TID' and status='confirmed'")" "1"
assert_eq "…one payment" "$(q "select count(*) from \"Payment\" where \"invoiceId\"='$I'")" "1"

note "=== numbers and seeded rows ==="
st=$(burst 6 POST "/api/v1/payments/mandates?companyId=$C" "{\"companyId\":\"$C\",\"customerId\":\"$K\",\"dateOfSignature\":\"$Y-06-01\",\"iban\":\"DE89370400440532013000\",\"debitorName\":\"$TAG\"}")
assert_eq "six mandates of one customer and day at once: all 201 (was one 201, five 500)" "$st" "201 201 201 201 201 201"
assert_eq "…six references" "$(q "select count(distinct \"mandateReference\") from \"SepaDirectDebitMandate\" where \"companyId\"='$C'")" "6"
REF=$(q "select \"mandateReference\" from \"SepaDirectDebitMandate\" where \"companyId\"='$C' limit 1")
st=$(curl -sS -o "$D/m" -w '%{http_code}' -X POST "$API/api/v1/payments/mandates?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$C\",\"customerId\":\"$K\",\"mandateReference\":\"$REF\",\"dateOfSignature\":\"$Y-06-01\",\"iban\":\"DE89370400440532013000\",\"debitorName\":\"$TAG\"}")
assert_eq "a reference typed in that is taken: 409 (was 500)" "$st" "409"
assert_eq "…saying so" "$(json_field "$(cat "$D/m")" message)" "Die Mandatsreferenz $REF ist bereits vergeben."
st=$(burst 6 PUT "/api/v1/reminders/templates/second?companyId=$C" '{"subject":"Zweite Mahnung","body":"Bitte zahlen."}')
assert_eq "a reminder template saved six times at once, before it exists: all 200 (was one 200, five 500)" "$st" "200 200 200 200 200 200"
st=$(burst 6 POST "/api/v1/ocr/match-supplier?companyId=$C" "{\"name\":\"$TAG Lieferant\"}")
no5xx "$st" "the OCR supplier match six times at once"
assert_eq "…one supplier (was six)" "$(q "select count(*) from \"Supplier\" where \"companyId\"='$C' and name='$TAG Lieferant'")" "1"

note "=== the statement e-mail ==="
st=$(curl -sS -o "$D/s" -w '%{http_code}' -X POST "$API/api/v1/customers/$K/statement.email?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$C\",\"from\":\"gestern\",\"to\":\"heute\"}")
assert_eq "a date that does not parse: 400 (was 500)" "$st" "400"

summary
