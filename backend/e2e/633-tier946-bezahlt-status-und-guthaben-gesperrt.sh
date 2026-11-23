#!/bin/bash
# Tier 946 — a submitted month and the receipts it holds (Ist-Versteuerung)
#
# 1. An invoice set "paid" by hand counts on its issue date (the part no
#    payment covers — euer-zufluss.ts). A payment recorded later takes that
#    part to its own day: October's return changed after it was submitted
#    (measured: Kz 81 1 000 € → 0, November +1 000 €). Setting or taking back
#    the status itself went past the submitted month too.
# 2. An applied credit ('Guthaben') is income of its day; its deletion skipped
#    the lock of a submitted month and of closed books (measured: October's
#    Kz 81 lowered after October was submitted).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-633-$(date +%s%N | cut -c1-13)"

company() { # name [besteuerungsart]
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier946-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "{\"rechtsform\":\"GmbH\",\"besteuerungsart\":\"${2:-ist}\",\"besteuerungsartAb\":\"2026-01-01\"}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
  K=$(json_field "$BODY" id)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
inv() { # date net → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"deliveryDate\":\"$1\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"bank_transfer\"}"; }
kz81() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=$1"; P "float({k['kz']: k['value'] for k in d['kennzahlen']}.get('81') or 0)"; }
submit() { # month
  AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=$1"
  local data; data=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
  AS POST "/api/v1/ustva/filings?companyId=$C" "$data"
}

note "=== 1. set \"paid\" by hand, then the payment ==="
company Bezahlt
[[ -n "${C:-}" ]] && pass "fixture: a GmbH, Ist-Versteuerung" || { fail "register"; summary; exit 1; }
inv 2026-10-10 1000
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"paid"}'
assert_eq "set \"paid\" without a payment: October takes the 1 000 €" "$(kz81 10)" "1000.0"
submit 10
assert_eq "October submitted" "$STATUS" "201"
pay "$I" 1190 2026-11-12
assert_eq "the bank payment entered with 12.11. would take them out of October: refused (was 201)" \
  "$STATUS/$(P "'als bezahlt markierte Rechnung' in str(d.get('message'))")" "400/True"
assert_eq "…October still 1 000 €" "$(kz81 10)" "1000.0"
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "taking \"paid\" back would empty October: refused (was 200)" "$STATUS" "400"

note "=== 2. an applied credit deleted ==="
company Guthaben
inv 2026-10-01 1000; IA=$I
pay "$IA" 1500 2026-10-05
inv 2026-10-10 1000; IB=$I
AS POST "/api/v1/customers/$K/apply-credit?companyId=$C" "{\"invoiceId\":\"$IB\",\"amount\":310}"
assert_eq "the overpayment's 310 € credit applied to the second invoice" "$STATUS" "201"
# apply-credit books today; as if it had been applied on 20 October
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc \
  "update \"Payment\" set \"paymentDate\"='2026-10-20' where \"invoiceId\"='$IB' and \"paymentMethod\"='Guthaben'" >/dev/null
PG=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "select id from \"Payment\" where \"invoiceId\"='$IB' and \"paymentMethod\"='Guthaben'")
BEFORE=$(kz81 10)
submit 10
AS DELETE "/api/v1/invoices/$IB/payments/$PG?companyId=$C"
assert_eq "deleting the applied credit after October was submitted: refused (was 200)" "$STATUS" "400"
assert_eq "…October unchanged" "$(kz81 10)" "$BEFORE"

note "=== 3. a part payment of an invoice set \"paid\" by hand, deleted ==="
company Teilzahlung
inv 2026-10-10 1000
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"paid"}'
pay "$I" 500 2026-11-03
PART=$(json_field "$BODY" id)
assert_eq "500 € paid on 03.11. (October still open): October keeps the 690 € not covered" "$(kz81 10)" "579.83"
submit 10
AS DELETE "/api/v1/invoices/$I/payments/$PART?companyId=$C"
assert_eq "deleting the November payment would empty October (the status back to open): refused (was 200, October 579,83 → 0)" "$STATUS" "400"

note "=== 4. a credit note on an invoice set \"paid\" by hand ==="
company Gutschrift
inv 2026-10-10 1000
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"paid"}'
submit 10
AS POST "/api/v1/invoices/$I/credit-note?companyId=$C" '{"amount":1190,"reason":"Storno"}'
assert_eq "a full credit note in November" "${STATUS:0:2}" "20"
assert_eq "…October keeps its 1 000 € (was 0 — the credit note's settlement ate the part set paid)" "$(kz81 10)" "1000.0"
assert_eq "…November takes it back: a refund of 1 000 € net" "$(kz81 11)" "-1000.0"
AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"
assert_eq "…the customer's credit: the 1 190 € paid" "$(P "float(d['balance'])")" "1190.0"

note "=== 5. Soll: a Vorausrechnung set \"paid\", then its payment — October's Soll return holds none of it ==="
company Soll soll
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-10\",\"deliveryDate\":\"2026-12-15\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"paid"}'
submit 10
pay "$I" 1190 2026-11-05
assert_eq "the payment of 05.11. is taken (the issue date is in no Soll return)" "${STATUS:0:2}" "20"

summary
