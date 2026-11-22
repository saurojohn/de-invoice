#!/bin/bash
# Tier 918 — the EÜR of the first year after a Bilanz carries the Übergangsergebnis
#
# Tier 915 put the Übergangsgewinn of a change of the Gewinnermittlung into
# Anlage G. The EÜR of the first EÜR year after a Bilanz (filed as Anlage EÜR
# beside Anlage G, line „Hinzurechnungen und Abrechnungen bei Wechsel der
# Gewinnermittlungsart“) did not have it: measured, a receivable of last year's
# Bilanz paid this year was this year's EÜR profit again (800 € — the Anlage G
# said 0).
#
# The figures: 1 000 + 190 VAT invoiced in November, 200 + 38 billed in
# December, both paid this year; last year's VAT (152) paid this year.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-606-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; LY=$((Y - 1))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
company() { # suffix method
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier918-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"rechtsform\":\"Einzelunternehmen\",\"gewinnermittlung\":\"$2\",\"besteuerungsart\":\"soll\"}"
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 606","type":"business","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"}}'
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
euer() { AS GET "/api/v1/accounting/euer?companyId=$C&year=$1"; P "f\"{d['totals']['gewinn']:g}\""; }
anlageg() { AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$1"; P "f\"{d['totals']['gewinnVorKorrektur']:g}\""; }

note "=== Bilanz → EÜR from this year ==="
company b bilanz
[[ -n "${C:-}" ]] && pass "fixture: a sole trader (Bilanz), an invoice and a bill of last year, paid this year" || { fail "register"; summary; exit 1; }
for m in 11 12; do
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$LY&month=$m"
  AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
  AS PUT "/api/v1/ustva/filings/$(json_field "$BODY" id)/payment?companyId=$C" "{\"paidAt\":\"$TODAY\"}"
done
AS PUT "/api/v1/companies/$C?companyId=$C" '{"gewinnermittlung":"euer"}'
assert_eq "the change from $Y" "$STATUS" "200"
assert_eq "EÜR $Y: 1 190 − 238 − 152 paid less the Übergangsverlust 800 = 0 (was 800 — counted twice)" "$(euer $Y)" "0"
assert_eq "…as its Anlage G" "$(anlageg $Y)" "0"
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "…shown as such" "$(P "(d['uebergang']['forderungen'], d['uebergang']['verbindlichkeiten'], d['uebergang']['umsatzsteuer'], d['totals']['uebergangsgewinn'])")" "(1190, 238, 152, -800)"
AS GET "/api/v1/accounting/euer.pdf?companyId=$C&year=$Y"
assert_eq "the PDF renders" "$STATUS" "200"

note "=== EÜR → Bilanz: the EÜR of the Bilanz year has no such line ==="
company a euer
AS PUT "/api/v1/companies/$C?companyId=$C" '{"gewinnermittlung":"bilanz"}'
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "no Übergang in the EÜR (it is the Bilanz's, in Anlage G)" "$(P "(d['uebergang'], d['totals']['uebergangsgewinn'])")" "(None, 0)"

summary
