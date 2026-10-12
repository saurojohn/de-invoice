#!/bin/bash
# Tier 670 — Anlage KAP read against §§ 20, 32d EStG
# (gesetze-im-internet.de, 12.10.2026).
#
#   § 20 Abs. 9   Sparer-Pauschbetrag: 1 000 € (spouses assessed together
#                 2 000 €) from 2023 — 801 € / 1 602 € before — and never
#                 more than the capital income.
#   § 20 Abs. 8   Capital income that belongs to a business is business
#                 income; § 32d Abs. 1: the 25 % are for income "die nicht
#                 unter § 20 Absatz 8 fallen".
#
# Before:
#   - 1 000 € for every year (2022: 801 €), shown in full against 300 € of
#     income; "Zusammenveranlagung" in the label, and nothing to choose it
#     with (the setting the service read was written by no page, no route).
#   - „Zins“ anywhere in the purpose made a credit interest income: a
#     customer's payment „Rechnung 12 inkl. Verzugszinsen“ of 1 190 € was
#     capital income, and tax was computed on it.
#   - A credit that is booked or matched to an invoice — in the books, so
#     business income — counted all the same.
#   - Nothing on the form said that a business account's interest does not
#     belong here, nor that a credit is what is left after the bank's tax.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-397-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier670-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
SQL() { docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -At -c "$1"; }
kap() { AS GET "/api/v1/accounting/anlage-kap?companyId=$C&year=$1"; }
line() { field "[l['amount'] for l in d['einnahmen'] + d['abzuege'] if l['kennziffer'] == '$1'][0]"; }

note "=== 1. the allowance of the year ==="
cat > "$SCRIPT_DIR/../.tier670-probe.ts" <<'TS'
import { sparerPauschbetragFor as p } from './src/modules/accounting/anlage-kap.service'
console.log(`amounts=${[p(2022), p(2022, true), p(2023), p(2023, true), p(2026)].join('/')}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier670-probe.ts > "$TMP/probe.txt" 2>&1 )
assert_eq "801 / 1 602 up to 2022, 1 000 / 2 000 from 2023" "$(grep '^amounts=' "$TMP/probe.txt" | cut -d= -f2)" "801/1602/1000/2000/1000"

note "=== 2. what counts as capital income ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier670-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
SQL "INSERT INTO \"BankStatement\" (id, \"companyId\", format, \"fileName\", \"fileSize\", \"rawContent\") VALUES ('$TAG', '$C', 'CAMT053', 'x.xml', 1, 'x')"
tx() { # n date amount purpose [iban]
  SQL "INSERT INTO \"BankTransaction\" (id, \"statementId\", \"companyId\", \"valueDate\", amount, purpose, \"counterpartyIban\") VALUES ('$TAG-$1', '$TAG', '$C', '$2', $3, '$4', '${5:-DE02120300000000202051}')"
}
tx 1 2022-12-30 300 'Habenzinsen 2022'
tx 2 2024-12-30 300 'Habenzinsen 2024'
tx 3 2024-06-30 -45.50 'Sollzinsen Kontokorrent Q2'
tx 4 2024-07-01 1190 'Rechnung INV-12 inkl. Verzugszinsen'
tx 5 2024-08-01 250 'Dividende Musterfonds' LU280019400644750000
tx 6 2024-09-01 900 'Mietzins September'
tx 7 2024-10-01 80 'Zinsgutschrift Festgeld'

kap 2022
assert_eq "2022: 300 € of interest, the allowance is 801 € (was 1 000)" "$(line 7100)|$(field "d['sparerPauschbetrag']['voll']")" "300|801"
assert_eq "… of which 300 € are applied — not more than the income (the line showed 1 000)" "$(line 7300)|$(field "(d['totals']['abzuegeTotal'], d['totals']['zuVersteuern'])")" "300|(300, 0)"
echo "$BODY" | grep -q "801 EUR, bei Zusammenveranlagung 1.602 EUR" && pass "… and the line names the amounts of that year" || fail "line 7300 does not name 801 / 1.602"

kap 2024
assert_eq "2024: the two interest credits, 380 € — not the customer's payment with „Verzugszinsen“, not the „Mietzins“ (was 2 470)" "$(line 7100)" "380"
assert_eq "… the dividend from abroad" "$(line 7130)|$(field "(d['counts']['matchedZinsTransactions'], d['counts']['matchedDividendeTransactions'])")" "250|(2, 1)"
assert_eq "… 630 € in all, below the allowance: nothing taxable, no tax (was 1 720 taxable, 430 tax)" \
  "$(field "(d['totals']['einnahmenTotal'], d['sparerPauschbetrag']['angesetzt'], d['totals']['zuVersteuern'], d['abgeltungssteuer']['expectedSteuer'])")" "(630, 630, 0, 0)"
echo "$BODY" | grep -q "1.000 EUR, bei Zusammenveranlagung 2.000 EUR" && pass "… the line names 1.000 / 2.000" || fail "line 7300 does not name 1.000 / 2.000"

note "=== 3. what is in the books is business income (§ 20 Abs. 8) ==="
tx 8 2024-11-01 2000 'Zinsen Darlehen an Kunde'
kap 2024
assert_eq "a large interest credit, not booked: counted, above the allowance" "$(field "(d['totals']['einnahmenTotal'], d['totals']['zuVersteuern'], d['abgeltungssteuer']['expectedSteuer'], d['abgeltungssteuer']['expectedSoli'])")" "(2630, 1630, 407.5, 22.41)"
# matched to an invoice: the credit pays a receivable of the business
AS POST "/api/v1/customers?companyId=$C" '{"name":"Darlehensnehmer GmbH","type":"business","contact":{"email":"k397@example.test"},"address":{"street":"Hafenweg 3","postalCode":"20457","city":"Hamburg","country":"DE"}}'; K=$(field "d['id']")
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"2024-10-15","dueDate":"2024-11-15","items":[{"description":"Zinsen Darlehen","quantity":1,"unit":"Stk","unitPrice":2000,"vatRate":0}]}'; INV=$(field "d['id']")
SQL "INSERT INTO \"BankReconciliation\" (id, \"bankTransactionId\", \"invoiceId\", \"companyId\", \"appliedAmount\", status, confidence, \"updatedAt\") VALUES ('$TAG-r', '$TAG-8', '$INV', '$C', 2000, 'confirmed', 100, NOW())" >/dev/null
BOOKED=$(SQL "SELECT count(*) FROM \"BankReconciliation\" WHERE id = '$TAG-r'")
assert_eq "fixture: the credit is matched to an invoice" "$BOOKED" "1"
kap 2024
assert_eq "matched to an invoice: in the business's books, not on Anlage KAP (was counted)" "$(field "(d['totals']['einnahmenTotal'], d['totals']['zuVersteuern'], d['counts']['leftOutBooked'])")" "(630, 0, 1)"

note "=== 4. spouses assessed together ==="
AS PUT "/api/v1/accounting/anlage-kap/settings?companyId=$C" '{"zusammenveranlagung":true}'
assert_eq "the choice is saved (there was nothing to choose it with)" "$STATUS|$(field "d['zusammenveranlagung']")" "200|True"
SQL "DELETE FROM \"BankReconciliation\" WHERE id = '$TAG-r'" >/dev/null
kap 2024
assert_eq "2 630 € of income, the joint allowance of 2 000 €: 630 € taxable (1 630 alone)" \
  "$(field "(d['sparerPauschbetrag']['voll'], d['sparerPauschbetrag']['angesetzt'], d['totals']['zuVersteuern'], d['abgeltungssteuer']['expectedSteuer'])")" "(2000, 2000, 630, 157.5)"
kap 2022; assert_eq "2022 together: 1 602 €" "$(field "d['sparerPauschbetrag']['voll']")" "1602"
AS PUT "/api/v1/accounting/anlage-kap/settings?companyId=$C" '{"zusammenveranlagung":"ja"}'
assert_eq "something that is neither yes nor no is refused" "$STATUS" "400"
AS PUT "/api/v1/accounting/anlage-kap/settings?companyId=$C" '{"zusammenveranlagung":false}'
kap 2024; assert_eq "and back: 1 000 €" "$(field "(d['sparerPauschbetrag']['voll'], d['totals']['zuVersteuern'])")" "(1000, 1630)"

note "=== 5. what the form says of itself ==="
echo "$BODY" | grep -q "§ 20 Abs. 8 EStG" && echo "$BODY" | grep -q "Betriebseinnahmen" \
  && pass "a business account's income is business income — said on the form" || fail "the form does not say what belongs on it"
echo "$BODY" | grep -q "Steuerbescheinigung der Bank" && pass "a credit is what is left after the bank's tax — said on the form" || fail "the form does not say that credits are net"
curl -sS -o "$TMP/kap.pdf" "$API/api/v1/accounting/anlage-kap.pdf?companyId=$C&year=2024" -H "x-user-id: $U" -H "x-company-id: $C"
pdf_contains "wenn die Bank nichts einbehalten hat" "$TMP/kap.pdf" && pass "the PDF: the tax shown is what is due if nothing was withheld" || fail "the PDF still calls it the expected tax"
FE="$SCRIPT_DIR/../../frontend"
grep -q 'data-testid="anlage-kap-zusammen"' "$FE/src/app/dashboard/accounting/AnlageKAPSection.tsx" && pass "the page has the choice" || fail "no choice on the page"
for lang in de en zh; do
  python3 - "$FE/messages/$lang.json" <<'PY' && pass "the page's texts: $lang" || fail "texts missing or old: $lang"
import json,sys
a=json.load(open(sys.argv[1],encoding='utf-8'))['anlageKAP']
ok=all(a.get(k) for k in ('zusammenveranlagung','leftOutBooked','abgeltungssteuer','abgeltungHint','subtitle')) and '{n}' in a['leftOutBooked'] and '20' in a['subtitle'] and 'Privatinvestoren' not in a['subtitle']
sys.exit(0 if ok else 1)
PY
done

summary
