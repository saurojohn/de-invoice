#!/bin/bash
# Tiers 617–618 — the timer; the time sheet
#
# 617: a running timer per user and company, kept on the server
#   (RunningTimer): start, look, stop — which writes the time entry, dated
#   the day the timer was started, in whole minutes, at least one and at
#   most 24 hours (`capped`) — or discard. A second start is refused.
# 618: GET /time-entries/timesheet.pdf — the Stundennachweis of a filter or
#   of the hours billed with an invoice (`invoiceId`); GET /invoices/:id
#   says how many entries an invoice has (`timeEntryCount`).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-371-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier617-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
customer() { AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' '$1'","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}'"${2:-}"'}'; json_field "$BODY" id; }
EMPTY='{}'
start() { AS POST "/api/v1/time-entries/timer/start?companyId=$C" "${1:-$EMPTY}"; }
stop() { AS POST "/api/v1/time-entries/timer/stop?companyId=$C" "${1:-$EMPTY}"; }
ago() { q "update \"RunningTimer\" set \"startedAt\" = now() - interval '$1' where \"companyId\"='$C'"; }
entries() { q "select count(*) from \"TimeEntry\" where \"companyId\"='$C'"; }
timers() { q "select count(*) from \"RunningTimer\" where \"companyId\"='$C'"; }
pdf() { # query → CODE, /tmp/$TAG.pdf, /tmp/$TAG.hdr
  CODE=$(curl -sS -o "/tmp/$TAG.pdf" -D "/tmp/$TAG.hdr" -w "%{http_code}" "$API/api/v1/time-entries/timesheet.pdf?companyId=$C&$1" -H "x-user-id: $U" -H "x-company-id: $C")
}
hdr() { grep -i "^$1:" "/tmp/$TAG.hdr" | tr -d '\r' | sed 's/^[^:]*: *//'; }

company b; UB=$U; CB=$C; KB=$(customer Fremd)
company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
K=$(customer Kunde ',"defaultHourlyRate":80'); K2=$(customer Zweiter)
AS POST "/api/v1/time-projects?companyId=$C" '{"name":"Wartung","customerId":"'$K'","hourlyRate":120}'; P=$(json_field "$BODY" id)

note "=== 1. start, look, stop ==="
AS GET "/api/v1/time-entries/timer?companyId=$C"
assert_eq "no timer runs at first (was: 404 — 'timer' was looked up as an entry id by PUT/DELETE only, GET had no such route)" "$STATUS $BODY" '200 {"running":null}'
start '{"customerId":"'$K'","description":"Analyse"}'
assert_eq "a timer is started for the customer" "$STATUS $(field "d['running']['customerId']=='$K', d['running']['description'], d['running']['elapsedSeconds'] < 5")" "201 (True, 'Analyse', True)"
start '{}'
assert_eq "a second start: 400 — one clock, not two" "$STATUS/$(echo "$BODY" | grep -c 'läuft bereits ein Timer')/$(timers)" "400/1/1"
ago '95 minutes'
AS GET "/api/v1/time-entries/timer?companyId=$C"
assert_eq "95 minutes later it shows 95 minutes" "$(field "d['running']['elapsedSeconds'] // 60")" "95"
stop
assert_eq "stopping writes the entry: 95 minutes today, the timer's customer and note, the customer's rate" \
  "$STATUS $(field "d['entry']['minutes'], d['entry']['date'][:10], d['entry']['description'], d['entry']['customerId']=='$K', float(d['entry']['hourlyRate']), d['capped']")" \
  "201 (95, '$TODAY', 'Analyse', True, 80.0, False)"
stop
assert_eq "…and the timer is gone: a second stop is 400" "$STATUS $(timers) $(entries)" "400 0 1"

note "=== 2. what the stop can say ==="
start '{"projectId":"'$P'"}'
assert_eq "a timer on a project takes the project's customer" "$STATUS $(field "d['running']['customerId']=='$K', d['running']['projectId']=='$P'")" "201 (True, True)"
stop
assert_eq "no activity named at start or stop: 400, and the timer keeps running" "$STATUS/$(echo "$BODY" | grep -c 'beschreiben Sie die Tätigkeit')/$(timers) $(entries)" "400/1/1 1"
stop '{"description":"Update eingespielt","hourlyRate":50,"billable":false}'
assert_eq "stopped with an activity, a rate and 'not billable': a minute at least, on the project" \
  "$STATUS $(field "d['entry']['minutes'], d['entry']['description'], float(d['entry']['hourlyRate']), d['entry']['billable'], d['entry']['projectId']=='$P'")" "201 (1, 'Update eingespielt', 50.0, False, True)"
start '{"customerId":"'$K'","description":"für den Falschen"}'
stop '{"customerId":null,"projectId":null,"description":"doch intern"}'
assert_eq "the stop can take the customer away" "$STATUS $(field "d['entry']['customerId'], d['entry']['hourlyRate'], d['entry']['description']")" "201 (None, None, 'doch intern')"

note "=== 3. discard; a forgotten timer ==="
start '{"description":"verworfen"}'
AS DELETE "/api/v1/time-entries/timer?companyId=$C"
assert_eq "discarding writes nothing" "$STATUS $BODY $(timers) $(entries)" '200 {"discarded":true} 0 3'
AS DELETE "/api/v1/time-entries/timer?companyId=$C"
assert_eq "discarding nothing is no error" "$STATUS $BODY" '200 {"discarded":false}'
start '{"description":"vergessen"}'; ago '30 hours'
STARTED=$(q "select (\"startedAt\" at time zone 'UTC' at time zone 'Europe/Berlin')::date from \"RunningTimer\" where \"companyId\"='$C'")
stop
assert_eq "a timer forgotten for 30 hours: 24 hours are written, on the day it was started, and the answer says it was cut" \
  "$STATUS $(field "d['entry']['minutes'], d['entry']['date'][:10], d['capped']")" "201 (1440, '$STARTED', True)"

note "=== 4. whose timer ==="
start '{"customerId":"'$KB'"}'; A=$STATUS
start '{"projectId":"'$P'","customerId":"'$K2'"}'
assert_eq "not for another company's customer, not on a project of another customer" "$A $STATUS $(timers)" "400 400 0"
start '{"description":"A läuft"}'
UA=$U; CA=$C; U=$UB; C=$CB
AS GET "/api/v1/time-entries/timer?companyId=$C";     X1=$BODY
start '{"description":"B läuft"}';                     X2=$STATUS
AS GET "/api/v1/time-entries/timer?companyId=$CA";    X3=$STATUS
U=$UA; C=$CA
AS GET "/api/v1/time-entries/timer?companyId=$C"
assert_eq "another company has its own clock and cannot look at this one" "$X1 $X2 $([[ "$X3" == 40[13] ]] && echo refused || echo "$X3") $(field "d['running']['description']")" '{"running":null} 201 refused A läuft'
AS DELETE "/api/v1/time-entries/timer?companyId=$C"

note "=== 5. the time sheet ==="
for i in 1 2 3; do AS POST "/api/v1/time-entries?companyId=$C" '{"date":"'$TODAY'","minutes":50,"description":"Arbeit '$i'","projectId":"'$P'"}'; done
pdf "customerId=$K&state=open"
assert_eq "the customer's open hours as a PDF: five entries (the stopped minute among them), 246 minutes (was: 404, no such route)" \
  "$CODE/$(head -c 4 "/tmp/$TAG.pdf")/$(hdr content-type)/$(hdr x-timesheet-entries)/$(hdr x-timesheet-minutes)" "200/%PDF/application/pdf/5/246"
pages() { grep -ac '/Type /Page$' "/tmp/$TAG.pdf"; }
pdf "projectId=$P"
assert_eq "…by project: the three and the one stopped on it — on one page (the page number does not start a second)" "$CODE/$(hdr x-timesheet-entries)/$(hdr x-timesheet-minutes)/$(pages)" "200/4/151/1"
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'"}'; INV=$(json_field "$BODY" invoiceId); NUM=$(json_field "$BODY" invoiceNumber)
AS GET "/api/v1/invoices/$INV?companyId=$C"
assert_eq "the invoice over the hours says how many entries it has" "$(field "d['timeEntryCount']")" "4"
pdf "invoiceId=$INV"
assert_eq "its time sheet: those four entries, named after the invoice" "$CODE/$(hdr x-timesheet-entries)/$(hdr content-disposition | grep -c "Stundennachweis_$NUM.pdf")" "200/4/1"
pdf "invoiceId=00000000-0000-0000-0000-000000000000"; A=$CODE
pdf "customerId=$KB"; B=$CODE
pdf "state=nonsense"; D=$CODE
UA=$U; CA=$C; U=$UB; C=$CB
pdf "invoiceId=$INV"
U=$UA; C=$CA
assert_eq "an unknown invoice, another company's customer, an unknown state, this invoice asked for by another company: 404 404 400 404" "$A $B $D $CODE" "404 404 400 404"
for i in $(seq 1 70); do
  curl -sS -o /dev/null -X POST "$API/api/v1/time-entries?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
    -d '{"date":"'$TODAY'","minutes":15,"description":"Eintrag '$i' mit einer längeren Beschreibung der Tätigkeit, damit die Zeile umbricht und die Seite sich füllt","customerId":"'$K2'"}'
done
pdf "customerId=$K2"
assert_eq "seventy entries of two lines each: three pages, and every entry on the sheet" "$CODE/$(hdr x-timesheet-entries)/$(pages)" "200/70/3"
rm -f "/tmp/$TAG.pdf" "/tmp/$TAG.hdr"
summary
