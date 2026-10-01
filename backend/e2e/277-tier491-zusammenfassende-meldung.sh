#!/bin/bash
# Tier 491 — Zusammenfassende Meldung (§ 18a UStG)
#
# A company with innergemeinschaftliche Lieferungen or B2B services in the
# EU must report them per customer USt-IdNr. (ZM). The app issued such
# invoices (Kz 41 / Kz 21 of the UStVA) but had no ZM at all (GET
# /ustva/zm 404). Now a preview per month or quarter: per USt-IdNr. and
# kind (L / S) the sum in full euros — a credit note in its own period —
# reconciled with
# Kz 41 / Kz 21, and a CSV.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-277-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier491-e2e\",\"companyName\":\"$TAG Handel\"}" \
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
customer() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\",\"vatId\":\"$2\",\"address\":{\"street\":\"Rue 1\",\"postalCode\":\"1010\",\"city\":\"Stadt\",\"country\":\"$3\"}}"; json_field "$BODY" id; }
inv() { # customer flagjson net date
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$4\",$2\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$3,\"vatRate\":0}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
FR=$(customer FR "FR12345678901" FR); AT=$(customer AT "ATU12345678" AT); DE=$(customer DE "DE123456789" DE)
F1=$(inv "$FR" '"euTransaction":true,' 1000.40 2026-07-10)
inv "$FR" '"euTransaction":true,' 500 2026-08-05 >/dev/null
inv "$AT" '"euTransaction":true,' 300 2026-09-01 >/dev/null
inv "$AT" '"reverseCharge":true,' 200 2026-09-02 >/dev/null
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$DE\",\"issueDate\":\"2026-07-11\",\"items\":[{\"description\":\"Inland\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":999,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$F1/credit-note?companyId=$C" '{"amount":100}'
assert_eq "fixture: a credit note of 100 on the first FR delivery (dated today — October)" "$STATUS" "201"

AS GET "/api/v1/ustva/zm?companyId=$C&year=2026&quarter=3"
assert_eq "ZM Q3 (was 404)" "$STATUS" "200"
assert_eq "per USt-IdNr. and kind, in full euros" \
  "$(P "[(r['land'], r['ustIdNr'], r['art'], r['betrag']) for r in d['rows']]")" \
  "[('AT', 'U12345678', 'L', 300), ('AT', 'U12345678', 'S', 200), ('FR', '12345678901', 'L', 1500)]"
assert_eq "reconciled with UStVA Kz 41 / Kz 21" "$(P "(d['abgleich']['kz41'], d['abgleich']['kz21'], d['abgleich']['stimmt'])")" "(1800.4, 200, True)"

AS GET "/api/v1/ustva/zm?companyId=$C&year=2026&month=7"
assert_eq "per month too: July" "$(P "[(r['land'], r['betrag']) for r in d['rows']]")" "[('FR', 1000)]"
MONTH=$(python3 -c "import datetime, zoneinfo;print(datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).month)")
YEAR=$(python3 -c "import datetime, zoneinfo;print(datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).year)")
AS GET "/api/v1/ustva/zm?companyId=$C&year=$YEAR&month=$MONTH"
assert_eq "the credit note reduces the ZM of its own month" "$(P "([(r['land'], r['art'], r['betrag']) for r in d['rows']], d['abgleich']['stimmt'])")" "([('FR', 'L', -100)], True)"

curl -sS -o /tmp/t491.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/ustva/zm.csv?companyId=$C&year=2026&quarter=3"
assert_eq "CSV" "$(tr -d '\r' < /tmp/t491.csv | tr '\n' '|')" \
  "Laenderkennzeichen;USt-IdNr;Betrag(EUR);Art der Leistung|AT;U12345678;300;L|AT;U12345678;200;S|FR;12345678901;1500;L|"

AS GET "/api/v1/ustva/zm?companyId=$C&year=2026"
assert_eq "a period is required" "$STATUS" "400"

summary
