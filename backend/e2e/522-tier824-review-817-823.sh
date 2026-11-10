#!/bin/bash
# Tier 824 — the review of Tiers 817-823
#
#  1. The AfA in the dashboard, the monthly P&L and the BWA. An asset of
#     12 000 € over 60 months from 1 January, AfA booked monthly, measured on
#     10.11.: the dashboard took every AfA row with Math.abs — after „AfA
#     stornieren" the booking and its counter-entry (Tier 746) both counted,
#     „Gewinn YTD" −2 000 → −4 000, booked again −6 000; the BWA's 3100 went
#     2 200 → 4 400 → 6 600 (and stayed „booked" after the storno). Without a
#     booking the dashboard and the P&L had no AfA, the BWA and the GuV the
#     computed. One rule now (booked-afa.ts afaOfYear): the bookings that
#     stand, else computed — the same figure in each state.
#  2. GET /companies/:id answered the operator's invitations (Tier 821, kept
#     in its settings) to every member of its company — a viewer, a
#     Betriebsprüfer saw the invited addresses.
#  3. With the registration open, an invitation was ignored: the company was
#     made, the invitation stayed „offen“, the company counted as registered
#     by itself.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login # the seed admin: the operator
TAG="e2e-522-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}; M=$((10#${TODAY:5:2}))
OP=(-H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
CALL() { # method path [body] [headers…]
  local m=$1 p=$2 b=${3:-}; shift 3 2>/dev/null || shift $#
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$m" "$API$p" -H "Content-Type: application/json" "$@" ${b:+-d "$b"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }

note "=== 1. the AfA: one figure, booked or not, reversed or not ==="
CALL POST /api/v1/auth/register "{\"email\":\"$TAG@example.test\",\"password\":\"Tier824-e2e\",\"companyName\":\"$TAG GmbH\"}"
U=$(py 'print(d["user"]["id"])'); C=$(py 'print(d["user"].get("companyId") or d["company"]["id"])')
[[ -n "$C" ]] && pass "fixture: a fresh company" || { fail "register → $STATUS"; summary; exit 1; }
AS=(-H "x-user-id: $U" -H "x-company-id: $C")
CALL POST "/api/v1/assets?companyId=$C" "{\"type\":\"Maschine\",\"bezeichnung\":\"Maschine\",\"anschaffungsDatum\":\"$Y-01-01\",\"anschaffungsKosten\":12000,\"nutzungsdauerMonate\":60,\"bilanzKonto\":\"0400\"}" "${AS[@]}"
assert_eq "fixture: a machine of 12 000 € over 60 months from 1 January (200 € a month)" "$STATUS" "201"
YTD=$(python3 -c "print('%.2f' % (200*$M))")
state() { # label
  local dash pnl bwa
  CALL GET "/api/v1/reports/dashboard?companyId=$C" "" "${AS[@]}"; dash=$(py 'print("%.2f" % d["ytd"]["net"])')
  CALL GET "/api/v1/reports/pnl?companyId=$C&year=$Y" "" "${AS[@]}"; pnl=$(py 'print("%.2f" % d["ytd"]["operatingResult"])')
  CALL GET "/api/v1/reports/bwa?companyId=$C&year=$Y&month=$M" "" "${AS[@]}"
  bwa=$(py 'l={x["bucket"]:x for x in d["lines"]};print("%.2f/%.2f" % (l["3100"]["monat"], l["3100"]["ytd"]), d["afaSource"])')
  assert_eq "$1: dashboard −AfA to this month's end, P&L −2 400 for the year, BWA 3100 200 / $YTD" \
    "$dash $pnl $bwa" "-$YTD -2400.00 200.00/$YTD $2"
}
state "no AfA booked (computed)" computed
CALL POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=$Y" "" "${AS[@]}"
assert_eq "fixture: AfA booked monthly" "$STATUS" "201"
state "booked monthly" booked
CALL POST "/api/v1/assets/storno-afa?companyId=$C&year=$Y" "" "${AS[@]}"
assert_eq "fixture: the AfA reversed" "$STATUS" "201"
state "reversed (was −2×: the booking and its counter-entry)" computed
CALL POST "/api/v1/assets/book-afa-monthly?companyId=$C&year=$Y" "" "${AS[@]}"
state "booked again (was −3×)" booked

note "=== 2. the operator's invitations stay the operator's ==="
CALL POST /api/v1/auth/registration/invites "{\"email\":\"$TAG-x@example.test\"}" "${OP[@]}"
assert_eq "fixture: an invitation" "$STATUS" "201"
X_ID=$(py 'print(d["id"])')
CALL GET "/api/v1/companies/$COMPANY_ID?companyId=$COMPANY_ID" "" "${OP[@]}"
assert_eq "the company's details carry no invitations (they did, to every member)" \
  "$STATUS $(py 'print("companyInvites" in (d.get("settings") or {}))')" "200 False"
CALL PUT "/api/v1/companies/$COMPANY_ID?companyId=$COMPANY_ID" '{"settings":{"defaultCurrency":"EUR"}}' "${OP[@]}"
assert_eq "…nor the answer to a save" "$STATUS $(py 'print("companyInvites" in (d.get("settings") or {}))')" "200 False"
CALL GET /api/v1/auth/registration/invites "" "${OP[@]}"
assert_eq "…and the save kept them: the operator still lists the invitation" "$(py "print(any(i['id']=='$X_ID' for i in d))")" "True"
CALL DELETE "/api/v1/auth/registration/invites/$X_ID" "" "${OP[@]}"

note "=== 3. an invitation counts with the registration open too ==="
CALL GET /api/v1/auth/registration
assert_eq "fixture: the registration is open" "$(py 'print(d["open"])')" "True"
B="$TAG-b@example.test"
CALL POST /api/v1/auth/registration/invites "{\"email\":\"$B\"}" "${OP[@]}"
TOKEN=$(py 'print(d["link"].split("company-invite=")[1])'); B_ID=$(py 'print(d["id"])')
CALL POST /api/v1/auth/register "{\"email\":\"$TAG-z@example.test\",\"password\":\"Tier824-e2e\",\"companyName\":\"$TAG Z GmbH\",\"companyInvite\":\"$TOKEN\"}"
assert_eq "the link with another address: refused" "$STATUS" "403"
CALL POST /api/v1/auth/register "{\"email\":\"$B\",\"password\":\"Tier824-e2e\",\"companyName\":\"$TAG B GmbH\",\"companyInvite\":\"$TOKEN\"}"
B_C=$(py 'print(d["user"].get("companyId") or d["company"]["id"])')
assert_eq "the invited address with the link: the company is made" "$STATUS" "201"
CALL GET /api/v1/auth/registration/invites "" "${OP[@]}"
assert_eq "…and the invitation is used, by that company (it stayed „offen“)" \
  "$(py "i=[x for x in d if x['id']=='$B_ID'][0];print(i['status'], i.get('companyId')=='$B_C')")" "used True"
CALL GET "/api/v1/admin/companies?q=$TAG%20B" "" "${OP[@]}"
assert_eq "…and the list says it came by invitation" "$(py 'print(d["companies"][0]["origin"], d["companies"][0]["invitedEmail"])')" "invite $B"
CALL POST /api/v1/auth/register "{\"email\":\"$TAG-c@example.test\",\"password\":\"Tier824-e2e\",\"companyName\":\"$TAG C GmbH\",\"companyInvite\":\"not-a-token-not-a-token-x\"}"
assert_eq "an unknown token with the registration open: registered as without one" "$STATUS" "201"
summary
