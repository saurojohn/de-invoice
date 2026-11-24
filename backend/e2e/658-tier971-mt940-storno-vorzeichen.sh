#!/bin/bash
# Tier 971 — MT940: the reversal of a credit (RC) and of a debit (RD)
#
# SWIFT MT940 :61: subfield 3 — C credit, D debit, RC reversal of a credit
# (Storno Haben: the money goes out), RD reversal of a debit (Storno Soll: it
# comes back). RC was read as a credit and RD as a debit: a returned transfer
# was a second receipt (to match an open invoice with), a Rücklastschrift a
# second payment. Measured: opening 1 000, C 200, RC 200, D 50, RD 50,
# closing 1 000 — credits 400, debits 100, „mismatch“, the rows summed +300.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-658-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier971-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
{
  printf ':20:ST1\n:25:DE89370400440532013000\n:28C:1/1\n:60F:C260909EUR1000,00\n'
  printf ':61:2609100910C200,00NTRFNONREF\n:86:166?00GUTSCHRIFT?20Zahlung Rechnung 1?32Kunde A\n'
  printf ':61:2609110911RC200,00NTRFNONREF\n:86:159?00RUECKUEBERWEISUNG?20Storno Gutschrift?32Kunde A\n'
  printf ':61:2609120912D50,00NDDTNONREF\n:86:105?00LASTSCHRIFT?20Beitrag?32Verein\n'
  printf ':61:2609120912RD50,00NDDTNONREF\n:86:109?00RUECKLASTSCHRIFT?20Beitrag zurueck?32Verein\n'
  printf ':62F:C260912EUR1000,00\n-\n'
} > "$W/st.mt940"
R=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/preview?companyId=$C" -F "file=@$W/st.mt940;type=text/plain")
assert_eq "the preview: credits 250, debits 250, the balance checks out (was 400 / 100, mismatch)" \
  "$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print(float(d['totalCredit']), float(d['totalDebit']), d['balanceCheck'])")" "250.0 250.0 ok"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$W/st.mt940;type=text/plain" --form-string "companyId=$C" --form-string "userId=$U")
SID=$(json_field "$UP" id)
assert_eq "imported: the returned transfer −200, the returned debit +50; the rows sum to 0 (was +300)" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "select string_agg(amount::numeric(12,2)::text, ' ' order by \"valueDate\", purpose) || ' = ' || sum(amount)::numeric(12,2) from \"BankTransaction\" where \"statementId\" = '$SID'")" \
  "200.00 -200.00 -50.00 50.00 = 0.00"

summary
