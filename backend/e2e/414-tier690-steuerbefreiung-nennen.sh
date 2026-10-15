#!/bin/bash
# Tier 690 — a tax-exempt sale names its exemption, or it is not issued
#
# The owner, 15.10.2026, on the open point of Tier 688 (a 0 % sale in Germany
# without § 13b / igL: the program cannot know which § 4 exemption applies):
# „开具时若缺少免税说明就拒绝并提示补写“ — refuse to issue it until the
# exemption is named.
#
# § 14 Abs. 4 Nr. 8 UStG asks every invoice for a tax-exempt supply to name
# the exemption; § 33 Satz 1 Nr. 4 UStDV asks the same of a small invoice
# (≤ 250 €). Measured before: such an invoice was issued without a word.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-414-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier690-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","taxId":"12/345/67890","email":"info@t690.example","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
cust() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$1\",\"type\":\"business\"${3:+,\"vatId\":\"$3\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Stadt\",\"postalCode\":\"12345\",\"country\":\"$2\"},\"contact\":{\"email\":\"k-$1@example.test\"}}"; P "d['id']"; }
DE=$(cust Schule DE); CH=$(cust Schweiz CH CHE-123.456.789); FR=$(cust France FR FR12345678901)
TODAY=$(TZ=Europe/Berlin date +%F)
draft() { # customer price rate [extra json]
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\",${4:-}\"items\":[{\"description\":\"Kurs\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":$3}]}"; P "d['id']"
}
issue() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"sent"}'; echo "$STATUS"; }

note "=== 1. refused without the exemption ==="
A=$(draft "$DE" 1000 0)
AS PUT "/api/v1/invoices/$A/status?companyId=$C" '{"status":"sent"}'
assert_eq "0 % to a German customer, no remark: 400 (was: issued)" "$STATUS" "400"
assert_eq "…the answer says what is missing and how to give it" "$(P "'Hinweis auf die Steuerbefreiung' in d['message'] and 'Bemerkungen' in d['message'] and '§ 14 Abs. 4 Nr. 8' in d['message']")" "True"
B=$(draft "$DE" 100 0)
assert_eq "a small invoice (≤ 250 €) too (§ 33 UStDV)" "$(issue "$B")" "400"
AS PUT "/api/v1/invoices/$A?companyId=$C" '{"notes":"Bitte pünktlich zahlen."}'
assert_eq "a remark that names no exemption does not do" "$(issue "$A")" "400"

note "=== 2. issued once it is named ==="
AS PUT "/api/v1/invoices/$A?companyId=$C" '{"notes":"Steuerfrei nach § 4 Nr. 21 UStG."}'
assert_eq "with „Steuerfrei nach § 4 Nr. 21 UStG“: 200" "$(issue "$A")" "200"
for n in "Umsatzsteuerfrei (Heilbehandlung)" "befreit gem. Art. 132 MwStSystRL"; do
  X=$(draft "$DE" 300 0 "\"notes\":\"$n\",")
  assert_eq "with „$n“: 200" "$(issue "$X")" "200"
done

note "=== 3. what is no exemption needs no remark ==="
assert_eq "19 %: 200" "$(issue "$(draft "$DE" 500 0.19)")" "200"
assert_eq "§ 13b to a German business: 200 (its own note)" "$(issue "$(draft "$DE" 500 0 '"reverseCharge":true,')")" "200"
assert_eq "export to Switzerland: 200 (its own note, Tier 688)" "$(issue "$(draft "$CH" 500 0)")" "200"
assert_eq "igL to France: 200" "$(issue "$(draft "$FR" 500 0 '"euTransaction":true,')")" "200"

note "=== 4. a Kleinunternehmer has the § 19 note ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer"}'
assert_eq "Kleinunternehmer, 0 %, no remark: 200" "$(issue "$(draft "$DE" 500 0)")" "200"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"standard"}'

note "=== 5. a recurring invoice that is issued by itself, the same ==="
R=$(curl -sS -X POST "$API/api/v1/recurring-invoices?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d "{\"customerId\":\"$DE\",\"name\":\"Kurs monatlich\",\"interval\":\"monthly\",\"intervalCount\":1,\"startDate\":\"$TODAY\",\"invoiceStatus\":\"sent\",\"sendEmail\":false,\"items\":[{\"description\":\"Kurs\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":200,\"vatRate\":0}]}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[[ -n "$R" ]] && pass "fixture: a recurring invoice at 0 %, issued on its own" || fail "recurring fixture"
AS POST "/api/v1/recurring-invoices/$R/run?companyId=$C" '{}'
assert_eq "its run without the remark: refused, with the reason" "$(P "'Hinweis auf die Steuerbefreiung' in str(d)")" "True"

note "=== 6. the form says it before ==="
PAGE="$SCRIPT_DIR/../../frontend/src/app/dashboard/invoices/create/page.tsx"
assert_eq "the create form shows the hint under the remarks, in three languages" \
  "$(grep -c 'data-testid="invoice-exemption-hint"' "$PAGE") $(cat "$SCRIPT_DIR/../../frontend/messages/"{de,en,zh}.json | grep -c '"exemptionHintMissing"')" "1 3"

summary
