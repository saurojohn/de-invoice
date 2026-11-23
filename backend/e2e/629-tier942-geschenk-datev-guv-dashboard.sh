#!/bin/bash
# Tier 941 / 942 — a gift over the 50 € limit outside the UStVA
#
# § 15 Abs. 1a UStG: a gift that is no Betriebsausgabe (§ 4 Abs. 5 Satz 1
# Nr. 1 EStG: over 50 € for one recipient in the year) gives no input tax —
# its tax is part of its cost. § 4 Abs. 7 EStG: gifts are recorded apart
# from the other costs (R 4.11 EStR: on accounts of their own), or even those
# within the limit lose the deduction.
# Measured before Tier 941: DATEV booked such a gift with the input-tax key
# 9, the GuV and KSt 1 counted it net, the dashboard showed its VAT as
# Vorsteuer. Before Tier 942: a deductible gift went to 4900 among the other
# costs; a company with its own default account got SKR03's 4635; a
# Kleinunternehmer's gift was judged against the limit net (45 € net /
# 53,55 € gross passed); the dashboard's result counted the gift net
# (−95,00 instead of −105,45) and a Kleinunternehmer's bills showed their VAT
# as Vorsteuer.
#
# Fixture, dated today (the dashboard counts the year so far), a GmbH:
# Frau Lang 30 € + 25 € = 55 € → both out; Herr Kurz 40 € → in.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-629-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

company() { # name rechtsform [extra json]
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier942-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "{\"rechtsform\":\"$2\"${3:+,$3}}"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
bill() { # number category net [recipient]
  local who=""; [[ -n "${4:-}" ]] && who=",\"giftRecipient\":\"$4\""
  local vat gross; vat=$(python3 -c "print(round($3*0.19,2))"); gross=$(python3 -c "print(round($3*1.19,2))")
  AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"Präsent\",\"category\":\"$2\",\"invoiceNumber\":\"$1\",\"invoiceDate\":\"$TODAY\",\"netAmount\":$3,\"vatRate\":0.19,\"vatAmount\":$vat,\"grossAmount\":$gross$who}"
  [[ "$STATUS" == 201 ]] || fail "bill $1: $STATUS $BODY"
}
# The gift rows of today's Buchungsstapel: number:Gegenkonto:amount:tax key
rows() {
  curl -sS -o "$WORK/s.csv" -H "x-user-id: $U" -H "x-company-id: $C" \
    "$API/api/v1/reports/datev-export?companyId=$C&startDate=$TODAY&endDate=$TODAY"
  datev_rows "$WORK/s.csv" | awk -F'\t' '$1 ~ /^G-/ {print $1":"$4":"$5":"$7}' | sort | paste -sd' ' -
}

company Handel GmbH
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
bill G-LANG-1 Geschenke 30 "Frau Lang"
bill G-LANG-2 Geschenke 25 "Frau Lang"
bill G-KURZ Geschenke 40 "Herr Kurz"

note "=== DATEV ==="
# Tier 941: gross without a key (was key 9 on the net); Tier 942: Herr Kurz's
# gift on 4630, not 4900 among the other costs
assert_eq "Frau Lang's gifts gross on 4635 without a key, Herr Kurz's on 4630 with key 9" \
  "$(rows)" "G-KURZ:4630:47.60:9 G-LANG-1:4635:35.70: G-LANG-2:4635:29.75:"
curl -sS -o "$WORK/b.zip" -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-buchungsliste?companyId=$C&year=$Y"
unzip -o -q "$WORK/b.zip" Kontenplan.csv -d "$WORK" 2>/dev/null
assert_eq "Kontenplan: 4630 and 4635 with their names" \
  "$(grep -E '^46(30|35);' "$WORK/Kontenplan.csv" 2>/dev/null | head -2 | paste -sd'|' -)" \
  "4630;Geschenke abzugsfähig ohne § 37b EStG;Geschenke an Geschäftsfreunde, abzugsfähig|4635;Geschenke nicht abzugsfähig ohne § 37b EStG;Geschenke an Geschäftsfreunde, nicht abzugsfähig"

note "=== GuV / KSt 1 ==="
AS GET "/api/v1/accounting/guv?companyId=$C&year=$Y"
assert_eq "GuV 8: 35,70 + 29,75 + 40 = 105,45 (was 95,00 — the gifts' VAT left out)" \
  "$(P "[l['amount'] for l in d['cost']['lines'] if l['position']=='8'][0]")" "105.45"
assert_eq "…Jahresfehlbetrag 105,45" "$(P "d['totals']['jahresueberschuss']")" "-105.45"
AS GET "/api/v1/accounting/kst1?companyId=$C&year=$Y"
assert_eq "KSt 1 Kz 80: 65,45 added back (was 55,00 net)" \
  "$(P "[l['amount'] for l in d['corrections'] if l['kennziffer']=='80'][0]")" "65.45"

note "=== Dashboard ==="
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "year so far: costs 105,45, Vorsteuer only Herr Kurz's 7,60, result −105,45 (was −95,00)" \
  "$(P "(d['ytd']['expenses'], d['ytd']['vorsteuer'], d['ytd']['net'])")" "(105.45, 7.6, -105.45)"

note "=== A company with its own accounts ==="
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"accounts":{"expenseDefault":"6300"}}'
assert_eq "its own default account is kept" "$STATUS" "200"
# Tier 832: 4630 / 4635 need not exist in its chart (SKR04: revenue accounts)
assert_eq "…the gifts go to it, Frau Lang's still without a key (was 4635)" \
  "$(rows)" "G-KURZ:6300:47.60:9 G-LANG-1:6300:35.70: G-LANG-2:6300:29.75:"
AS PUT "/api/v1/companies/$C/datev-config?companyId=$C" '{"accounts":{"expenseDefault":"6300","giftDeductible":"6610","giftNonDeductible":"6620"}}'
AS GET "/api/v1/companies/$C/datev-config?companyId=$C"
assert_eq "the gift accounts are settings of their own" \
  "$(P "(d['overrides'].get('giftDeductible'), d['overrides'].get('giftNonDeductible'), d['defaults'].get('giftDeductible'), d['defaults'].get('giftNonDeductible'))")" \
  "('6610', '6620', '4630', '4635')"
assert_eq "…and used" "$(rows)" "G-KURZ:6610:47.60:9 G-LANG-1:6620:35.70: G-LANG-2:6620:29.75:"

note "=== A Kleinunternehmer ==="
company Klein Einzelunternehmen '"defaultVatMode":"kleinunternehmer"'
bill G-WEISS Geschenke 45 "Herr Weiß"
bill B-PAPIER Bürobedarf 100
# § 19: no input tax — the limit is gross; 53,55 € is over it (was judged at 45 € net)
assert_eq "his 45 € net / 53,55 € gross gift is over the limit: 4635" "$(rows)" "G-WEISS:4635:53.55:"
AS GET "/api/v1/reports/dashboard?companyId=$C"
assert_eq "dashboard: costs gross 53,55 + 119, no Vorsteuer (was 145 / 27,55)" \
  "$(P "(d['ytd']['expenses'], d['ytd']['vorsteuer'], d['ytd']['net'])")" "(172.55, 0, -172.55)"

summary
