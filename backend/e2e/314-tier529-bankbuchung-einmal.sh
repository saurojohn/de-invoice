#!/bin/bash
# Tier 529 — a bank entry pays once; a statement that bookings rest on stays
#
# Measured before: one credit of 119 € on a bank statement, matched to an
# invoice of 119 € — and matched again to a second one: 201 both times, two
# invoices paid, 238 € received on paper from 119 € on the account. A credit
# of 300 € matched to three invoices of 119 € paid all three in full. And a
# statement with confirmed matches could be deleted: the payments and their
# vouchers stayed, resting on a statement that no longer existed.
#
# Now a match takes what is left of the entry (the last invoice gets the
# rest as a part payment; nothing left → 400), and a statement with booked
# matches is not deleted until they are taken back.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-314-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier529-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() { # → id of an issued invoice of 119 €
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id); AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'; echo "$id"
}
I1=$(inv); I2=$(inv); I3=$(inv); I4=$(inv); I5=$(inv)

MT=/tmp/t529-$TAG.mt940
cat > "$MT" <<'MT'
:1:F01BANKBICAXXX0000000000
:20:ST529
:25:DE89370400440532013000
:28C:1/1
:60F:C260901EUR0,00
:61:2609100910C119,00NTRFNONREF//Zahlung A
Kunde
:86:166?00GUTSCHRIFT?20Zahlung A
:61:2609110911C300,00NTRFNONREF//Zahlung B
Kunde
:86:166?00GUTSCHRIFT?20Zahlung B
:62F:C260911EUR419,00
-
MT
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
rm -f "$MT"
SID=$(json_field "$UP" id)
txn() { echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==$1][0])"; }
match() { AS POST "/api/v1/bank-statements/$SID/transactions/$(txn "$1")/match?companyId=$C" "{\"invoiceId\":\"$2\"}"; }
paid() { q "select coalesce(sum(amount),0)::numeric(12,2)||'/'||(select status from \"Invoice\" where id='$1') from \"Payment\" where \"invoiceId\"='$1'"; }
received() { q "select coalesce(sum(p.amount),0)::numeric(12,2) from \"Payment\" p join \"Invoice\" i on i.id=p.\"invoiceId\" where i.\"companyId\"='$C'"; }
[[ -n "$SID" ]] && pass "fixture: a statement with credits of 119 € and 300 €, five invoices of 119 €" || { fail "import: $UP"; summary; exit 1; }

note "=== 119 € for one invoice ==="
match 119 "$I1"
assert_eq "matched to the first invoice: paid" "$STATUS/$(paid "$I1")" "201/119.00/paid"
match 119 "$I2"
assert_eq "the same entry for a second invoice: 400 (was 201)" "$STATUS" "400"
assert_eq "…it says the entry is used up" "$(P "'vollständig zugeordnet' in d['message']")" "True"
assert_eq "…the second invoice is open, 119 € received in all (were 238)" "$(paid "$I2")|$(received)" "0.00/sent|119.00"

note "=== 300 € for three invoices ==="
match 300 "$I2"; assert_eq "first: 119 €, paid" "$STATUS/$(paid "$I2")" "201/119.00/paid"
match 300 "$I3"; assert_eq "second: 119 €, paid" "$STATUS/$(paid "$I3")" "201/119.00/paid"
match 300 "$I4"
assert_eq "third: the remaining 62 €, a part payment (was 119, paid)" "$STATUS/$(paid "$I4")" "201/62.00/sent"
match 300 "$I5"
assert_eq "a fourth: 400" "$STATUS" "400"
assert_eq "received in all: 419 € — what the account shows (was 595)" "$(received)" "419.00"

note "=== a match taken back frees the amount ==="
R=$(q "select id from \"BankReconciliation\" where \"invoiceId\"='$I4' and status='confirmed'")
AS POST "/api/v1/bank-statements/reconciliations/$R/reopen?companyId=$C" '{}'
assert_eq "the 62 € match is taken back" "$([[ "$STATUS" == 20* ]] && echo ok || echo "$STATUS $BODY")/$(paid "$I4")" "ok/0.00/sent"
match 300 "$I5"
assert_eq "…now the 62 € go to the fifth invoice" "$STATUS/$(paid "$I5")" "201/62.00/sent"

note "=== the statement ==="
AS DELETE "/api/v1/bank-statements/$SID?companyId=$C"
assert_eq "deleting it: 400 (was 200)" "$STATUS" "400"
assert_eq "…the statement and its matches are there" "$(q "select count(*) from \"BankStatement\" where id='$SID'")/$(q "select count(*) from \"BankReconciliation\" where \"companyId\"='$C' and status='confirmed'")" "1/4"
# A statement nothing is booked from can be deleted.
MT2=/tmp/t529b-$TAG.mt940
printf ':1:F01BANKBICAXXX0000000000\n:20:ST529B\n:25:DE89370400440532013000\n:28C:2/1\n:60F:C260912EUR419,00\n:61:2609120912C10,00NTRFNONREF//Zahlung Z\nKunde\n:86:166?00GUTSCHRIFT?20Zahlung Z\n:62F:C260912EUR429,00\n-\n' > "$MT2"
UP2=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT2;type=text/plain" -F "companyId=$C" -F "userId=$U")
rm -f "$MT2"
SID2=$(json_field "$UP2" id)
AS DELETE "/api/v1/bank-statements/$SID2?companyId=$C"
assert_eq "a statement with nothing booked: deleted" "$STATUS/$(q "select count(*) from \"BankStatement\" where id='$SID2'")" "200/0"

summary
