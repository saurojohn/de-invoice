#!/bin/bash
# Tier 530 — the structured :86: of a German bank statement is read
#
# German banks write field 86 of an MT940 as a Geschäftsvorfallcode and
# sub-fields: `166?00GUTSCHRIFT?20SVWZ+Rechnung INV-2026-0?21000012?30BIC
# ?31IBAN?32Name`. Measured before: the purpose came out as
# "6?00GUTSCHRIFT?20Zahlung A" (the line read as "sub-tag 16" plus text), the
# payer's name and IBAN were never found, and an invoice number broken over
# two sub-fields was not recognised — so the matching had only the amount.
#
# Now: purpose (after SVWZ+), name (?32 ?33), IBAN (?31), end-to-end
# reference (EREF+); the unstructured form is read as before.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-315-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier530-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
inv() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id); NO=$(json_field "$BODY" invoiceNumber); AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'; }
# Two open invoices of the same amount — only the reference tells them apart.
inv; I1=$I; inv; I2=$I; NO2=$NO
HEAD_=${NO2:0:10}; TAIL_=${NO2:10}

MT=/tmp/t530-$TAG.mt940
{
  printf ':1:F01BANKBICAXXX0000000000\n:20:ST530\n:25:DE89370400440532013000\n:28C:1/1\n:60F:C260901EUR0,00\n'
  printf ':61:2609100910C119,00NTRFNONREF//X\nKunde\n'
  # the invoice number broken over ?21 / ?22 and over a line break
  printf ':86:166?00GUTSCHRIFT?20EREF+E2E-4711?21SVWZ+Rechnung %s?22\n%s Danke?30COBADEFFXXX?31DE89370400440532013000?32Mustermann GmbH?33 und Co\n' "$HEAD_" "$TAIL_"
  printf ':61:2609110911C50,00NTRFNONREF//Y\nKunde\n:86:166?00GUTSCHRIFT?20Zahlung A\n'
  printf ':61:2609120912D20,00NTRFNONREF//Z\nLieferant\n:86:LIEFERANT XYZ\n'
  printf ':62F:C260912EUR149,00\n-\n'
} > "$MT"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
rm -f "$MT"
SID=$(json_field "$UP" id)
[[ -n "$SID" ]] && pass "fixture: a statement in the structured format, two open invoices of 119 €" || { fail "import: $UP"; summary; exit 1; }
col() { q "select coalesce($2,'') from \"BankTransaction\" where \"statementId\"='$SID' and amount=$1"; }

note "=== the structured field ==="
assert_eq "the purpose is the text after SVWZ+, the number in one piece (was 6?00GUTSCHRIFT?20…)" "$(col 119 purpose)" "Rechnung $NO2 Danke"
assert_eq "the payer's name from ?32 ?33 (was empty)" "$(col 119 '"counterpartyName"')" "Mustermann GmbH und Co"
assert_eq "the payer's IBAN from ?31 (was empty)" "$(col 119 '"counterpartyIban"')" "DE89370400440532013000"
assert_eq "the end-to-end reference from EREF+" "$(col 119 '"endToEndId"')" "E2E-4711"
assert_eq "a plain ?20: just the text" "$(col 50 purpose)" "Zahlung A"
assert_eq "the unstructured form is read as before" "$(col -20 '"counterpartyName"')" "LIEFERANT XYZ"

note "=== the matching can use it ==="
TX=$(q "select id from \"BankTransaction\" where \"statementId\"='$SID' and amount=119")
AS GET "/api/v1/bank-statements/$SID/transactions/$TX/candidates?companyId=$C"
assert_eq "of two invoices of 119 €, the one named in the purpose comes first" "$(P "d['candidates'][0]['invoice']['id'] if 'invoice' in d['candidates'][0] else d['candidates'][0].get('invoiceId')")" "$I2"

summary
