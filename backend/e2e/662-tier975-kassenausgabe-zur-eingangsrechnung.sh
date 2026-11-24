#!/bin/bash
# Tier 975 — a bill paid from the till: its amount, once
#
# A cash expense linked to a bill took any amount and could be made again:
# 1 000 € and 119 € out of the till for a bill of 119 € — the bill paid once,
# 1 000 € gone without a Beleg (GoBD Rz. 77; § 146 Abs. 1 AO).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-662-$(date +%s%N | cut -c1-13)"
D=$(TZ=Europe/Berlin date -v-5d +%F 2>/dev/null || TZ=Europe/Berlin date -d '5 days ago' +%F)
D2=$(TZ=Europe/Berlin date -v-4d +%F 2>/dev/null || TZ=Europe/Berlin date -d '4 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier975-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Baumarkt GmbH"}'
SUP=$(json_field "$BODY" id)
AS POST "/api/v1/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"BM-1\",\"description\":\"Material\",\"invoiceDate\":\"$D\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
X=$(json_field "$BODY" id)
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D\",\"type\":\"eroeffnung\",\"description\":\"AB\",\"amount\":2000}"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D2\",\"type\":\"ausgabe\",\"description\":\"Baumarkt bar\",\"amount\":1000,\"expenseId\":\"$X\"}"
assert_eq "1 000 € from the till for the bill of 119 €: refused (was 201)" "$STATUS" "400"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D2\",\"type\":\"ausgabe\",\"description\":\"Baumarkt bar\",\"amount\":119,\"expenseId\":\"$X\"}"
assert_eq "119 €: paid" "$STATUS" "201"
AS POST "/api/v1/cashbook/entries?companyId=$C" "{\"businessDate\":\"$D2\",\"type\":\"ausgabe\",\"description\":\"Baumarkt bar nochmal\",\"amount\":119,\"expenseId\":\"$X\"}"
assert_eq "…a second time: refused (was 201)" "$STATUS" "400"
AS GET "/api/v1/cashbook/balance?companyId=$C"
assert_eq "the till: 2 000 − 119" "$(echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(float(d.get('balance', d.get('saldo', 0))))")" "1881.0"

summary
