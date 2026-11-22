#!/bin/bash
# Tier 915 — the Gewinnermittlung by year, with the Übergangsgewinn
#
# `gewinnermittlung` was one column read for every year. Measured: a sole
# trader (EÜR) with an invoice of November last year, paid this year, set
# 'bilanz' (books from this year on, § 141 AO) — last year's Anlage G, an EÜR
# already filed, went from 0 to 1 000 € profit; and this year's (Bilanz) did
# not have the 1 000 € either: no year counted it.
#
# Now a change applies from a year on (`gewinnermittlungAb`, default this one,
# at most the next); the years before keep their method. The first year of
# the new method carries the Übergangsgewinn (R 4.6 EStR): the receivables
# open at its start less the unpaid expenses and the Umsatzsteuer still owed
# (gross: the EÜR counts the VAT with the money) — added on the way to the
# Bilanz, taken off on the way to the EÜR.
#
# The figures: 1 000 + 190 VAT invoiced in November, 200 + 38 billed in
# December, both paid this year; the VAT of last year, 152, unpaid at 31.12.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-603-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; LY=$((Y - 1))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company() { # suffix method
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier915-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"rechtsform\":\"Einzelunternehmen\",\"gewinnermittlung\":\"$2\",\"besteuerungsart\":\"soll\"}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 603","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
  K=$(json_field "$BODY" id)
  # an invoice of 10.11. last year (1 000 net), paid today
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  q "update \"Invoice\" set \"issueDate\"='$LY-11-10', \"dueDate\"='$LY-11-24' where id='$I'" >/dev/null
  AS POST "/api/v1/invoices/$I/payments?companyId=$C" "{\"amount\":1190,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
  # a bill of 01.12. last year (200 net), paid today
  AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"$TAG\",\"invoiceDate\":\"$LY-12-01\",\"netAmount\":200,\"vatRate\":0.19,\"vatAmount\":38,\"grossAmount\":238}"
  q "update \"Expense\" set \"paidAt\"='$TODAY' where id='$(json_field "$BODY" id)'" >/dev/null
}
gewinn() { AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$1"; P "f\"{d['gewinnermittlung']} {d['totals']['gewinnVorKorrektur']:g}\""; }

note "=== EÜR → Bilanz from this year ==="
company a euer
[[ -n "${C:-}" ]] && pass "fixture: a sole trader (EÜR), an invoice and a bill of last year, paid this year" || { fail "register"; summary; exit 1; }
assert_eq "before: $LY EÜR 0 (nothing paid), $Y EÜR 1 190 − 238 = 952" "$(gewinn $LY) / $(gewinn $Y)" "euer 0 / euer 952"
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"gewinnermittlung\":\"bilanz\",\"gewinnermittlungAb\":$((Y + 2))}"
assert_eq "a change from the year after next: 400" "$STATUS" "400"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"gewinnermittlung":"bilanz"}'
assert_eq "books from this year on" "$STATUS" "200"
assert_eq "$LY stays an EÜR: 0 (was bilanz 800)" "$(gewinn $LY)" "euer 0"
assert_eq "$Y: Bilanz with the Übergangsgewinn 1 190 − 238 − 152 = 800 (was 0 — the invoice in no year)" "$(gewinn $Y)" "bilanz 800"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
assert_eq "…shown as such" "$(P "(d['uebergang']['forderungen'], d['uebergang']['verbindlichkeiten'], d['uebergang']['umsatzsteuer'], d['totals']['uebergangsgewinn'])")" "(1190, 238, 152, 800)"
AS GET "/api/v1/accounting/forms?companyId=$C"
assert_eq "the forms: the EÜR (last year's) and the Bilanz (this year's)" "$(P "('euer' in d['forms'], 'bilanz' in d['forms'])")" "(True, True)"
AS GET "/api/v1/accounting/anlage-g.pdf?companyId=$C&year=$Y"
assert_eq "the PDF renders" "$STATUS" "200"

note "=== Bilanz → EÜR from this year ==="
company b bilanz
assert_eq "before: $LY Bilanz 800" "$(gewinn $LY)" "bilanz 800"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"gewinnermittlung":"euer"}'
assert_eq "$LY stays a Bilanz: 800 (was euer 0)" "$(gewinn $LY)" "bilanz 800"
# the returns of November and December last year, settled this year
for m in 11 12; do
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$LY&month=$m"
  AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
  AS PUT "/api/v1/ustva/filings/$(json_field "$BODY" id)/payment?companyId=$C" "{\"paidAt\":\"$TODAY\"}"
done
assert_eq "the VAT of last year (190 − 38) paid this year" "$STATUS" "200"
assert_eq "$Y: 1 190 − 238 − 152 received and paid, less the Übergangsverlust 800 = 0 — counted once (was 800, twice)" "$(gewinn $Y)" "euer 0"

note "=== a change announced for next year ==="
company c euer
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"gewinnermittlung\":\"bilanz\",\"gewinnermittlungAb\":$((Y + 1))}"
assert_eq "accepted" "$STATUS" "200"
assert_eq "this year stays an EÜR" "$(gewinn $Y)" "euer 952"
assert_eq "…stored from $((Y + 1))" "$(q "select settings->'gewinnermittlungWechsel' from \"Company\" where id='$C'")" "[{\"ab\": $((Y + 1)), \"art\": \"bilanz\", \"vorher\": \"euer\"}]"

note "=== a company with nothing booked before changes as a whole ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-d@example.test\",\"password\":\"Tier915-e2e\",\"companyName\":\"$TAG d\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","gewinnermittlung":"bilanz"}'
assert_eq "no switch recorded" "$(q "select coalesce(settings->>'gewinnermittlungWechsel','[]') from \"Company\" where id='$C'")" "[]"

summary
