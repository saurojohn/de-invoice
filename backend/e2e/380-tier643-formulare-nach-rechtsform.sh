#!/bin/bash
# Tier 643 — the accounting page's forms, by the company's legal form
#
# The page listed all nineteen forms for every company: a GmbH was offered
# Anlage N, Anlage Kind and Anlage R next to its KSt 1, a freelancer the
# corporation tax return. GET /accounting/forms says which ones a company of
# this legal form files; the page puts those first and the others under a
# line that says so.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-380-$(date +%s%N | cut -c1-13)"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
company() { # name → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$RANDOM@example.test\",\"password\":\"Tier643-e2e\",\"companyName\":\"$1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
forms() { AS GET "/api/v1/accounting/forms?companyId=$C"; }
ALWAYS="'beraterPackager' in d['forms'] and 'ustja' in d['forms'] and 'gobdArchive' in d['forms'] and len(d['forms'])+len(d['other'])==19"

company "$TAG Handel GmbH"
[[ -n "${C:-}" ]] && pass "fixture: a company whose name ends in GmbH" || { fail "register"; summary; exit 1; }
forms
assert_eq "a GmbH (from its name): KSt 1, GewSt, the annual accounts — no annex of a person's return, no EÜR" \
  "$STATUS $(field "d['rechtsform'], d['rechtsformSource'], d['gewinnermittlung'], d['forms']")" \
  "200 ('GmbH', 'abgeleitet', 'bilanz', ['beraterPackager', 'kst1', 'ustja', 'gewst', 'bilanz', 'guv', 'anhang', 'ebilanz', 'gobdArchive'])"
assert_eq "…the other ten are named as the others, and all nineteen are in one list or the other" \
  "$(field "d['other'], $ALWAYS")" "(['euer', 'anlageS', 'anlageV', 'anlageKAP', 'anlageG', 'anlageN', 'anlageR', 'anlageKind', 'anlageSO', 'anlageAUS'], True)"

AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Freiberufler"}'
forms
assert_eq "set to Freiberufler: EÜR, Anlage S and the owner's annexes — no KSt 1, no GewSt, no Anlage G, no balance sheet" \
  "$(field "d['rechtsformSource'], d['gewinnermittlung'], d['forms'], d['other'], $ALWAYS")" \
  "('gesetzt', 'euer', ['beraterPackager', 'euer', 'anlageS', 'anlageV', 'anlageKAP', 'anlageN', 'anlageR', 'anlageKind', 'anlageSO', 'anlageAUS', 'ustja', 'gobdArchive'], ['anlageG', 'kst1', 'gewst', 'bilanz', 'guv', 'anhang', 'ebilanz'], True)"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
forms
assert_eq "a sole trader: Anlage G and GewSt instead of Anlage S" "$(field "'anlageG' in d['forms'], 'gewst' in d['forms'], 'anlageS' in d['other'], 'kst1' in d['other'], 'euer' in d['forms']")" "(True, True, True, True, True)"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"gewinnermittlung":"bilanz"}'
forms
assert_eq "…who keeps books: the balance sheet instead of the EÜR, no Anhang (§ 264 HGB is for corporations)" "$(field "'bilanz' in d['forms'], 'guv' in d['forms'], 'euer' in d['other'], 'anhang' in d['other']")" "(True, True, True, True)"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH & Co. KG","gewinnermittlung":null}'
forms
assert_eq "a GmbH & Co. KG: a partnership — GewSt, balance sheet and Anhang (§ 264a), no KSt 1, no personal annex" \
  "$(field "d['forms'], $ALWAYS")" "(['beraterPackager', 'ustja', 'gewst', 'bilanz', 'guv', 'anhang', 'ebilanz', 'gobdArchive'], True)"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GbR"}'
forms
assert_eq "a GbR: the EÜR; the partners' annexes are theirs" "$(field "d['forms']")" "['beraterPackager', 'euer', 'ustja', 'gobdArchive']"

company "$TAG Werkstatt"
forms
assert_eq "a company whose legal form is not known: all nineteen, as before" "$STATUS $(field "d['rechtsform'], len(d['forms']), d['other']")" "200 (None, 19, [])"
KEEP_U=$U
company "$TAG Fremd GmbH"
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/accounting/forms?companyId=$C" -H "x-user-id: $KEEP_U" -H "x-company-id: $C")
assert_eq "another company's forms are not read" "$STATUS" "401"
summary
