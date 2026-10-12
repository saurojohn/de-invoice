#!/bin/bash
# Tier 673 — Anlage V: a loan's repayment is no Werbungskosten, and each
# expense in the line it belongs to.
#
# Measured with a landlord's usual categories:
#   „Darlehenstilgung“ 9 000 €   counted as Schuldzinsen — the repayment of a
#                                loan is no expense at all; only its
#                                interest is (§ 9 Abs. 1 Satz 3 Nr. 1 EStG)
#   „Hausverwaltung“ 1 200 €,    counted as building INSURANCE: that line
#   „Hausmeister“ 600 €,         took whatever began with „Haus“ or
#   „Gebäudereinigung“ 300 €     „Gebäude“ and stood before the others
# 15 830 € of Werbungskosten where 6 830 € are.
# Labels: rent without VAT was „nach § 19 UStG (Kleinunternehmer)“ — a flat's
# rent is exempt by § 4 Nr. 12 UStG; repairs were „keine Herstellungs-/
# Erhaltungsaufwand“ — they are Erhaltungsaufwand.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-400-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
line() { field "[l['amount'] for l in d['werbungskosten'] if l['kennziffer'] == '$1'][0]"; }
Y=2025

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier673-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Lieferant 400","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'; SUP=$(field "d['id']")
N=0
exp() { # category gross
  N=$((N + 1))
  AS POST "/api/v1/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"V-$N\",\"description\":\"$1\",\"invoiceDate\":\"$Y-05-10\",\"paidAt\":\"$Y-05-12\",\"category\":\"$1\",\"netAmount\":$2,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":$2,\"confirmDuplicate\":true}"
  [[ "$STATUS" == "201" ]] || fail "expense $1 → $STATUS"
}
exp Hausverwaltung 1200; exp Hausmeister 600; exp Gebäudereinigung 300; exp Wohngebäudeversicherung 450
exp Darlehenstilgung 9000; exp Schuldzinsen 2400; exp Grundsteuer 380; exp "Reparatur Dach" 1500
exp "Darlehen Rate Mai" 700; exp Darlehenszinsen 150; exp Haftpflicht 90; exp "Porto" 20
pass "fixture: twelve expenses"

note "=== 1. each expense in its line ==="
AS GET "/api/v1/accounting/anlage-v?companyId=$C&year=$Y"
assert_eq "Schuldzinsen: the interest, 2 550 € — not the repayment (was 12 250 €)" "$(line 8620)" "2550"
assert_eq "insurance: 450 € + 90 € — not the administration, the caretaker, the cleaning (was 2 640 €)" "$(line 8640)" "540"
assert_eq "Hausverwaltung 1 200 € (was 0)" "$(line 8650)" "1200"
assert_eq "Nebenkosten: caretaker and cleaning, 900 €" "$(line 8670)" "900"
assert_eq "Grundsteuer, repairs, the rest" "$(line 8630)|$(line 8660)|$(line 8690)" "380|1500|20"
assert_eq "7 090 € of Werbungskosten (were 16 790 €)" "$(field "(d['totals']['werbungskostenTotal'], d['totals']['ueberschuss'])")" "(7090, -7090)"

note "=== 2. the repayment is reported, not hidden ==="
assert_eq "two expenses left out, 9 700 €" "$(field "(d['counts']['tilgung']['count'], d['counts']['tilgung']['amount'], d['counts']['expenses'])")" "(2, 9700, 12)"
echo "$BODY" | grep -q "2 Ausgabe(n) für Darlehen oder Tilgung (9.700,00 EUR) sind nicht angesetzt" && pass "the line of the Schuldzinsen says so" || fail "no note on line 8620"
curl -sS -o "$TMP/v.pdf" "$API/api/v1/accounting/anlage-v.pdf?companyId=$C&year=$Y" -H "x-user-id: $U" -H "x-company-id: $C"
pdf_contains "die Tilgung ist keine Werbungskosten" "$TMP/v.pdf" && pass "… and the PDF" || fail "the PDF does not say what was left out"

note "=== 3. the labels ==="
echo "$BODY" | grep -q "steuerfrei nach § 4 Nr. 12 UStG oder Kleinunternehmer" && pass "rent without VAT: § 4 Nr. 12 or § 19" || fail "rent without VAT is still only § 19"
echo "$BODY" | grep -q "Erhaltungsaufwand — kein Herstellungsaufwand" && pass "repairs are Erhaltungsaufwand" || fail "repairs: the old label"
echo "$BODY" | grep -q "igL / Ausfuhr" && fail "rent as an intra-Community supply or an export" || pass "no „igL / Ausfuhr“ for rent"

summary
