#!/bin/bash
# Tier 446 — a bank reconciliation is undone as a whole, not by a voucher Storno
#
# Measured before: a customer payment matched from the bank statement books a
# voucher (referenceType BankReconciliation, 1200 an 1406) and records a
# Payment. A plain Storno of that voucher (POST /accounting/vouchers/:id/
# reversal) answered 201 and took back only the journal lines: the Payment
# stayed, so the invoice stayed "paid" and was never dunned; the
# reconciliation stayed "confirmed". Undoing the match afterwards — the one
# way to get the invoice open again — reversed the voucher a second time.
#
# The whole undo exists: "Zuordnung rückgängig machen" (reconciliations/:id/
# reopen) reverses the voucher, deletes the Payment, clears voucherRefId and
# puts the match back to "suggested". The plain Storno is refused now (400,
# naming that route); a correction (/correct) keeps working — the payment
# happened, only its accounts change.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-235-$(date +%s%N | cut -c1-13)"
Y=2026

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier446-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
says() { grep -qF "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }
inv_status() { AS GET "/api/v1/invoices/$1?companyId=$C"; py 'print(d["status"])'; }
voucher_count() { AS GET "/api/v1/accounting/vouchers?companyId=$C"; py 'r=d if isinstance(d,list) else d.get("data",d.get("items",[]));print(len(r))'; }

AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","contact":{"email":"'$TAG'@example.test"}}'
CU=$(json_field "$BODY" id)
invoice() { # description
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CU'","issueDate":"'$Y'-06-01","dueDate":"'$Y'-06-15","items":[{"description":"'$1'","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
I1=$(invoice Leistung)

MT=/tmp/t446-$TAG.mt940
cat > "$MT" <<'EOF'
:1:F01BANKBICAXXX0000000000
:20:ST446
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR1000,00
:61:2606100610C119,00NTRFNONREF//Zahlung Kunde
Kunde
:62F:C260610EUR1119,00
-
EOF
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
TXN=$(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==119][0])")
[[ -n "$TXN" ]] && pass "fixture: the credit is imported" || fail "import: $UP"

note "=== the payment is matched ==="
AS POST "/api/v1/bank-statements/$SID/transactions/$TXN/match?companyId=$C" '{"invoiceId":"'$I1'"}'
assert_eq "matched" "$STATUS" "201"
V=$(py 'print(d.get("voucherId") or "")')
RECON=$(py 'print(d.get("reconciliationId") or "")')
assert_eq "invoice paid" "$(inv_status "$I1")" "paid"
N0=$(voucher_count)

note "=== a plain Storno of the reconciliation voucher ==="
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"falsch zugeordnet"}'
assert_eq "refused (was 201: journal back, payment kept)" "$STATUS" "400"
assert_eq "…naming the undo that takes the payment back too" "$(says "mit „Rückgängig“ zurück")" "yes"
assert_eq "no Storno voucher written" "$(voucher_count)" "$N0"
assert_eq "the invoice is unchanged: paid" "$(inv_status "$I1")" "paid"
curl -sS -o /tmp/t446.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
assert_eq "…and paid in DATEV too: the Debitor owes nothing (was 119 while the app said paid)" \
  "$(datev_balance /tmp/t446.csv 10000)" "0.00"

note "=== the reconciliation undo does it all ==="
AS POST "/api/v1/bank-statements/reconciliations/$RECON/reopen?companyId=$C"
assert_eq "reopen" "$STATUS" "201"
assert_eq "invoice open again" "$(inv_status "$I1")" "sent"
assert_eq "one Storno voucher" "$(voucher_count)" "$((N0 + 1))"
curl -sS -o /tmp/t446.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
assert_eq "DATEV: the Debitor owes the invoice" "$(datev_balance /tmp/t446.csv 10000)" "119.00"
assert_eq "DATEV: the bank account is back to 0" "$(datev_balance /tmp/t446.csv 1200)" "0.00"

note "=== a correction of a reconciliation voucher still works ==="
I2=$(invoice Zweite)
MT2=/tmp/t446b-$TAG.mt940
sed 's/ST446/ST446B/' "$MT" > "$MT2"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT2;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID2=$(json_field "$UP" id)
TXN2=$(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==119][0])")
AS POST "/api/v1/bank-statements/$SID2/transactions/$TXN2/match?companyId=$C" '{"invoiceId":"'$I2'"}'
V2=$(py 'print(d.get("voucherId") or "")')
AS GET "/api/v1/accounting/vouchers/$V2?companyId=$C"
LINES=$(py 'import json;print(json.dumps([{"accountId":l["accountId"],"debit":float(l["debit"]),"credit":float(l["credit"]),"description":"korrigiert"} for l in d["lines"]]))')
AS POST "/api/v1/accounting/vouchers/$V2/correct?companyId=$C" '{"date":"'$Y'-06-11T00:00:00Z","reason":"Text","lines":'"$LINES"'}'
assert_eq "Korrektur accepted" "$STATUS" "201"
assert_eq "…the invoice stays paid" "$(inv_status "$I2")" "paid"

note "=== data from before this tier: the voucher was already reversed by hand ==="
I3=$(invoice Dritte)
MT3=/tmp/t446c-$TAG.mt940
sed 's/ST446/ST446C/' "$MT" > "$MT3"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT3;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID3=$(json_field "$UP" id)
TXN3=$(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])==119][0])")
AS POST "/api/v1/bank-statements/$SID3/transactions/$TXN3/match?companyId=$C" '{"invoiceId":"'$I3'"}'
V3=$(py 'print(d.get("voucherId") or "")'); RECON3=$(py 'print(d.get("reconciliationId") or "")')
# What the plain Storno wrote before this tier (the Payment stayed).
q "insert into \"Voucher\" (id, \"companyId\", \"voucherNumber\", date, description, \"referenceType\", status, \"reversedById\", \"createdAt\")
   values (gen_random_uuid()::text, '$C', 'LEGACY-S1', now(), 'Storno: alt', 'VoucherReversal', 'posted', '$V3', now())" >/dev/null
N3=$(voucher_count)
AS POST "/api/v1/bank-statements/reconciliations/$RECON3/reopen?companyId=$C"
assert_eq "reopen still takes the payment back" "$STATUS/$(inv_status "$I3")" "201/sent"
assert_eq "…without a second Storno of the same voucher (was one more)" "$(voucher_count)" "$N3"

summary
