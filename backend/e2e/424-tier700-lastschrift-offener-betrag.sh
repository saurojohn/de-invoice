#!/bin/bash
# Tier 700 — a SEPA direct debit collects what is open
#
# The direct-debit batch (pain.008) took each invoice's total. Measured: an
# invoice of 1 190 € with a 119 € credit note, and one of 1 190 € with a
# 500 € part payment — both listed as 1 190 € to collect, both debited
# 1 190 € from the customer's account in the generated XML (1 309 € too
# much); an invoice in USD went into the file as Ccy="USD", which no bank
# takes (SEPA is euros only).
# Now the list and the batch take the open amount — the total less the
# payments booked on the invoice, a credit note's „Gutschrift“ among them —
# an invoice with nothing open is refused, and one in another currency too.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-424-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
EXEC=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=20)).isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier700-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
q "update \"Company\" set \"bankInfo\"='{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"bankName\":\"Bank\"}'::jsonb where id='$C'" >/dev/null
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/payments/mandates?companyId=$C" "{\"companyId\":\"$C\",\"customerId\":\"$K\",\"dateOfSignature\":\"2026-07-20\",\"type\":\"CORE\",\"iban\":\"DE02120300000000202051\",\"bic\":\"BYLADEM1001\",\"debitorName\":\"$TAG Kunde AG\"}"
M=$(json_field "$BODY" id)
[[ -n "$M" ]] && pass "fixture: a CORE mandate" || fail "mandate: $BODY"
issued() { # [currency] → id, 1 000 net + 19 %
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\"${1:+,\"currency\":\"$1\",\"exchangeRate\":1.1},\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
CREDITED=$(issued); PART=$(issued); FULL=$(issued); SETTLED=$(issued); USD=$(issued USD)
AS POST "/api/v1/invoices/$CREDITED/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'
AS POST "/api/v1/invoices/$PART/payments?companyId=$C" '{"amount":500,"paymentDate":"2026-10-05","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$SETTLED/credit-note?companyId=$C" '{"reason":"Storno"}'

note "=== 1. the list of invoices to collect ==="
AS GET "/api/v1/payments/direct-debit/open?companyId=$C"
open_of() { P "[(i['total'], i.get('openAmount')) for i in d if i['id']=='$1']"; }
assert_eq "credited 119 €: 1 071 € to collect (was 1 190)" "$(open_of "$CREDITED")" "[(1190, 1071)]"
assert_eq "paid 500 €: 690 € to collect (was 1 190)" "$(open_of "$PART")" "[(1190, 690)]"
assert_eq "untouched: 1 190 €" "$(open_of "$FULL")" "[(1190, 1190)]"
assert_eq "cancelled by its Storno: not offered" "$(open_of "$SETTLED")" "[]"

note "=== 2. the batch ==="
batch() { AS POST "/api/v1/payments/direct-debit/batches?companyId=$C" "{\"companyId\":\"$C\",\"executionDate\":\"$EXEC\",\"collections\":[$1]}"; }
pair() { echo "{\"invoiceId\":\"$1\",\"mandateId\":\"$M\"}"; }
batch "$(pair "$USD")"
assert_eq "an invoice in USD: refused (was: Ccy=\"USD\" in the file)" "$STATUS/$(grep -c 'nur Euro' <<<"$BODY")" "400/1"
batch "$(pair "$CREDITED"),$(pair "$PART"),$(pair "$FULL")"
assert_eq "the batch: 201, 2 951 € (was 3 570)" "$STATUS/$(P "d['totalAmount']")" "201/2951"
XML=$(P "d['xmlContent']")
amounts() { python3 -c "
import re,sys
x=sys.argv[1]
for tx in re.findall(r'<DrctDbtTxInf>(.*?)</DrctDbtTxInf>', x, re.S):
    nr=re.search(r'<Ustrd>RE ([^\s<]+)', tx).group(1); amt=re.search(r'<InstdAmt[^>]*>([^<]+)<', tx).group(1)
    print(nr, amt)
print('CtrlSum', re.search(r'<GrpHdr>.*?<CtrlSum>([^<]+)<', x, re.S).group(1))" "$XML" | sort | tr '\n' ' '; }
NR_C=$(q "select \"invoiceNumber\" from \"Invoice\" where id='$CREDITED'"); NR_P=$(q "select \"invoiceNumber\" from \"Invoice\" where id='$PART'"); NR_F=$(q "select \"invoiceNumber\" from \"Invoice\" where id='$FULL'")
assert_eq "pain.008: each debit is the open amount" "$(amounts)" "$(printf '%s\n' "CtrlSum 2951.00" "$NR_C 1071.00" "$NR_P 690.00" "$NR_F 1190.00" | sort | tr '\n' ' ')"
assert_eq "…and so are the collections" "$(q "select string_agg(trim(trailing '.' from trim(trailing '0' from amount::text)), ',' order by amount) from \"SepaDirectDebitCollection\" where \"companyId\"='$C'")" "690,1071,1190"

summary
