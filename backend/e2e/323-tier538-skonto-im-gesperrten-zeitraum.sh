#!/bin/bash
# Tier 538 — a supplier's Skonto is not booked into a submitted period
#
# Left open by Tier 537. A bank debit booked against a bill "with Skonto"
# creates a supplier credit note dated with the bank entry — it lowers that
# period's input tax (§ 17 UStG). Measured before: with the UStVA of June
# submitted, a debit of 08.06. booked with Skonto was accepted (201) and
# June's Vorsteuer fell by 3,80 € behind the submitted return.
#
# Now it is refused like any other document of the period; once the period is
# released it is booked. A payment of the full amount (no Skonto) moves no VAT
# and is booked either way.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-323-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier538-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
vorsteuer() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=6"; P "'%.2f' % d['vorsteuerSum']"; }
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"1\",\"country\":\"DE\"}}"
SU=$(json_field "$BODY" id)
bill() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$SU\",\"invoiceNumber\":\"$1\",\"description\":\"Ware\",\"invoiceDate\":\"2026-06-01\",\"netAmount\":1000,\"vatRate\":0.19,\"vatAmount\":190,\"grossAmount\":1190}"; json_field "$BODY" id; }
E1=$(bill ER-1); E2=$(bill ER-2)

MT=/tmp/t538-$TAG.mt940
cat > "$MT" <<'MT'
:1:F01BANKBICAXXX0000000000
:20:ST538
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR5000,00
:61:2606080608D1166,20NTRFNONREF//ER-1 abzgl. 2% Skonto
Lieferant
:61:2606090609D1190,00NTRFNONREF//ER-2
Lieferant
:62F:C260609EUR2643,80
-
MT
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
rm -f "$MT"
SID=$(json_field "$UP" id)
tx() { echo "$UP" | python3 -c "import sys,json;print([x['id'] for x in json.load(sys.stdin)['transactions'] if float(x['amount'])==$1][0])"; }
book() { AS POST "/api/v1/bank-statements/$SID/transactions/$(tx "$1")/book-expense?companyId=$C" "$2"; }

AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=6"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
F=$(json_field "$BODY" id)
assert_eq "fixture: June is submitted with 380 € Vorsteuer" "$STATUS/$(vorsteuer)" "201/380.00"

note "=== June is locked ==="
book -1166.2 "{\"expenseId\":\"$E1\",\"skonto\":true}"
assert_eq "the debit of 08.06. with Skonto: 400 (was 201)" "$STATUS" "400"
assert_eq "…the message names the period" "$(P "'2026-06' in d['message']")" "True"
assert_eq "…June's Vorsteuer is what was submitted (was 376,20)" "$(vorsteuer)" "380.00"
book -1190 "{\"expenseId\":\"$E2\"}"
assert_eq "the debit of 09.06. over the full amount: booked — a payment moves no VAT" "$STATUS" "201"

note "=== released ==="
AS PUT "/api/v1/ustva/filings/$F/release?companyId=$C" '{"released":true}'
book -1166.2 "{\"expenseId\":\"$E1\",\"skonto\":true}"
assert_eq "the Skonto is booked" "$STATUS" "201"
assert_eq "…June's Vorsteuer is lower by 3,80 €" "$(vorsteuer)" "376.20"
AS GET "/api/v1/ustva/filings?companyId=$C"
assert_eq "…and the history asks for a corrected return" "$(P "[x['berichtigungNoetig'] for x in d if x['id']=='$F']")" "[True]"

summary
