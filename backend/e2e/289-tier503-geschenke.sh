#!/bin/bash
# Tier 503 — business gifts and the 50 € limit
#
# § 4 Abs. 5 Nr. 1 EStG: gifts to a business contact are deductible only if
# all gifts to that recipient in the year cost no more than 50 € (net) —
# above it none of them is, nor its input tax (§ 15 Abs. 1a UStG); the name
# must be recorded (§ 4 Abs. 7 EStG), without it only a Streuartikel (≤ 10 €).
# Measured before: a gift (category "Geschenk…") was an expense like any
# other — deducted in full, its input tax claimed; no recipient could be
# recorded.
#
# Fixture 2025 (19 %): to Frau Meier 30 € (March) + 25 € (November, written
# "frau  meier") = 55 € → both out; to Herr Kurz 45 € → in; without a
# recipient 8 € → in (Streuartikel), 20 € → out.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-289-$(date +%s%N | cut -c1-13)"

company() { # name rechtsform → "U C"
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$2@example.test\",\"password\":\"Tier503-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "{\"rechtsform\":\"$2\"}"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
gift() { # date net [recipient]
  local who=""; [[ -n "${3:-}" ]] && who=",\"giftRecipient\":\"$3\""
  local vat; vat=$(python3 -c "print(round($2*0.19,2))")
  AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"Präsent\",\"category\":\"Geschenke\",\"invoiceDate\":\"$1\",\"paidAt\":\"$1\",\"netAmount\":$2,\"vatRate\":0.19,\"vatAmount\":$vat,\"grossAmount\":$(python3 -c "print(round($2*1.19,2))")$who}"
}

company Handel Einzelunternehmen
[[ -n "${C:-}" ]] && pass "fixture: a sole trader" || { fail "register"; summary; exit 1; }
gift 2025-03-10 30 "Frau Meier"
assert_eq "the recipient is stored (was not accepted)" "$STATUS/$(P "d.get('giftRecipient')")" "201/Frau Meier"
gift 2025-11-10 25 "frau  meier"
gift 2025-06-01 45 "Herr Kurz"
gift 2025-07-01 8
gift 2025-08-01 20

note "=== UStVA: no input tax on a gift over the limit ==="
vst() { AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=$1"; P "float(d['vorsteuer']['from19'])"; }
assert_eq "March: Frau Meier's 30 € (her year total 55 €) — no input tax (was 5,70)" "$(vst 3)" "0.0"
assert_eq "June: Herr Kurz 45 € — input tax 8,55" "$(vst 6)" "8.55"
assert_eq "July: a Streuartikel of 8 € — 1,52" "$(vst 7)" "1.52"
assert_eq "August: 20 € without a recipient — none" "$(vst 8)" "0.0"

note "=== EÜR / Anlage S / Anlage G ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
assert_eq "EÜR: the deductible gifts 45 + 8 = 53 in the expenses (was 128)" "$(P "round(float(d['totals']['ausgabenTotal']) - sum(float(l['amount']) for l in d['ausgaben'] if l['kennziffer']=='5850'), 2)")" "53.0"
assert_eq "…their input tax 8,55 + 1,52 = 10,07 paid (was 24,32)" "$(P "[float(l['amount']) for l in d['ausgaben'] if l['kennziffer']=='5850'][0]")" "10.07"
assert_eq "…non-deductible gifts shown: 35,70 + 29,75 + 23,80 = 89,25" "$(P "float(d['totals'].get('nichtAbziehbareGeschenke', d.get('nichtAbziehbareGeschenke', -1)))")" "89.25"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=2025"
assert_eq "Anlage S: the same 89,25" "$(P "float(d['totals']['nichtAbziehbareGeschenke'])")" "89.25"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=2025"
assert_eq "Anlage G: the same 89,25" "$(P "float(d['totals']['nichtAbziehbareGeschenke'])")" "89.25"

note "=== KSt 1: a GmbH adds them back (Kz 80) ==="
company GmbH GmbH
gift 2025-05-05 60 "Herr Groß"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=2025"
assert_eq "Kz 80: 60 € added back (was nothing)" "$(P "[(float(l['amount']), l['source']) for l in d['corrections'] if l['kennziffer']=='80'][0]")" "(60.0, 'computed')"

summary
