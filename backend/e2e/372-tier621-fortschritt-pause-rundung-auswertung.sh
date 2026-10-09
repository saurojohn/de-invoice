#!/bin/bash
# Tiers 621–625 — five things Tiers 614–618 had listed as "not built"
#
# 621: a quote / order confirmation / invoice says in a word how far it has
#      been invoiced and delivered — progress: { INV, DN } = none | partial |
#      full — on GET /invoices/:id and on every row of the list.
# 622: the invoice e-mail of an invoice over logged hours carries the
#      Stundennachweis as a second PDF (attachTimesheet: false leaves it out).
# 623: the timer pauses — POST /time-entries/timer/pause | resume; the pause
#      is not counted.
# 624: a rounding rule per company (GET/PUT /time-entries/settings): a
#      duration is written rounded to 5 / 6 / 10 / 15 / 30 / 60 minutes, up
#      or to the nearest step.
# 625: GET /time-entries/report?groupBy=user|customer|project&from&to — the
#      hours of a period: all, billable, billed, open, and their value.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-372-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier621-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
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
EMPTY='{}'
te() { AS POST "/api/v1/time-entries?companyId=$C" '{"date":"'${3:-$TODAY}'","minutes":'$1',"description":"Arbeit"'"${2:-}"'}'; T=$(json_field "$BODY" id); }
minutes() { q "select minutes from \"TimeEntry\" where id='$1'"; }
convert() { AS POST "/api/v1/invoices/$1/convert?companyId=$C" "$2"; N=$(json_field "$BODY" id); }
progress() { AS GET "/api/v1/invoices/$1?companyId=$C"; field "d['progress']"; }
row() { AS GET "/api/v1/invoices?companyId=$C&limit=200${2:+&type=$2}"; field "[r.get('progress') for r in d['data'] if r['id']=='$1']"; }

company b; UB=$U; CB=$C
company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","defaultHourlyRate":80,"address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"'$TAG'-kunde@example.test"}}'; K=$(json_field "$BODY" id)

note "=== 621. in a word: how far ==="
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","type":"QU","issueDate":"'$TODAY'","dueDate":"2099-01-31","items":[{"description":"A","quantity":10,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"B","quantity":4,"unit":"Stk","unitPrice":50,"vatRate":0.19}]}'; Q=$(json_field "$BODY" id)
A=$(q "select id from \"InvoiceItem\" where \"invoiceId\"='$Q' and description='A'")
assert_eq "a fresh quote: nothing invoiced, nothing delivered — on the document and on its row in the list (was: no such field)" "$(progress "$Q") $(row "$Q" QU)" "{'INV': 'none', 'DN': 'none'} [{'INV': 'none', 'DN': 'none'}]"
convert "$Q" '{"to":"INV","items":[{"itemId":"'$A'","quantity":4}]}'; P1=$N
assert_eq "4 of 10 invoiced: partly" "$(progress "$Q") $(row "$Q" QU)" "{'INV': 'partial', 'DN': 'none'} [{'INV': 'partial', 'DN': 'none'}]"
convert "$Q" '{"to":"INV"}'; P2=$N
convert "$Q" '{"to":"DN","items":[{"itemId":"'$A'","quantity":1}]}'
assert_eq "the rest invoiced, one piece delivered: invoiced, partly delivered" "$(progress "$Q") $(row "$Q" QU)" "{'INV': 'full', 'DN': 'partial'} [{'INV': 'full', 'DN': 'partial'}]"
AS PUT "/api/v1/invoices/$P1/status?companyId=$C" '{"status":"cancelled"}'
assert_eq "the first invoice cancelled: partly again" "$(progress "$Q")" "{'INV': 'partial', 'DN': 'partial'}"
AS PUT "/api/v1/invoices/$P2/status?companyId=$C" '{"status":"sent"}'
assert_eq "an issued invoice says how far it is delivered; in the list too" "$(progress "$P2") $(row "$P2")" "{'DN': 'none'} [{'DN': 'none'}]"
AS PUT "/api/v1/invoices/$Q/status?companyId=$C" '{"status":"offered"}'; AS PUT "/api/v1/invoices/$Q/status?companyId=$C" '{"status":"cancelled"}'
assert_eq "a cancelled quote has no progress to report" "$(progress "$Q") $(row "$Q" QU)" "{} [None]"

note "=== 624. the rounding rule ==="
AS GET "/api/v1/time-entries/settings?companyId=$C"
assert_eq "no rule at first (was: 404 — 'settings' was no route)" "$STATUS $BODY" '200 {"rounding":{"minutes":0,"mode":"up"}}'
te 37 ',"customerId":"'$K'"'; E0=$T
q "update \"Company\" set settings = coalesce(settings,'{}'::jsonb) || '{\"leitwegId\":\"991-12345-67\"}'::jsonb where id='$C'"
for bad in '{"rounding":{"minutes":7}}' '{"rounding":{"minutes":"15"}}' '{"rounding":{"minutes":15,"mode":"down"}}' '{}'; do AS PUT "/api/v1/time-entries/settings?companyId=$C" "$bad"; R="${R:-}$STATUS "; done
assert_eq "not a rule: 7 minutes, \"15\", a mode 'down', nothing" "$R" "400 400 400 400 "
AS PUT "/api/v1/time-entries/settings?companyId=$C" '{"rounding":{"minutes":15}}'
assert_eq "to 15 minutes, up — and the company's other settings are still there" "$STATUS $BODY $(q "select settings->>'leitwegId' from \"Company\" where id='$C'")" '200 {"rounding":{"minutes":15,"mode":"up"}} 991-12345-67'
te 37; E1=$T; te 45; E2=$T; te 1; E3=$T; te 1430; E4=$T
assert_eq "37 → 45, 45 stays, 1 → 15, 1430 → 1440 (a day at most); the entry from before the rule keeps its 37" "$(minutes $E1) $(minutes $E2) $(minutes $E3) $(minutes $E4) $(minutes $E0)" "45 45 15 1440 37"
AS PUT "/api/v1/time-entries/$E0?companyId=$C" '{"minutes":61}'; A1=$(minutes $E0)
AS PUT "/api/v1/time-entries/$E0?companyId=$C" '{"description":"nur der Text"}'
assert_eq "a changed duration is rounded (61 → 75); a change of the text leaves it" "$A1 $(minutes $E0)" "75 75"
AS PUT "/api/v1/time-entries/settings?companyId=$C" '{"rounding":{"minutes":15,"mode":"nearest"}}'
te 37; N1=$T; te 38; N2=$T; te 5; N3=$T
assert_eq "to the nearest: 37 → 30, 38 → 45, 5 → 15 (never nothing)" "$(minutes $N1) $(minutes $N2) $(minutes $N3)" "30 45 15"
UA=$U; CA=$C; U=$UB; C=$CB
te 37; X=$(minutes $T)
AS PUT "/api/v1/time-entries/settings?companyId=$CA" '{"rounding":{"minutes":60}}'
U=$UA; C=$CA
AS GET "/api/v1/time-entries/settings?companyId=$C"
assert_eq "another company rounds nothing, and does not set this company's rule" "$X $(field "d['rounding']['minutes']")" "37 15"

note "=== 623. the timer pauses ==="
AS PUT "/api/v1/time-entries/settings?companyId=$C" '{"rounding":{"minutes":0}}'
AS POST "/api/v1/time-entries/timer/pause?companyId=$C" "$EMPTY"
assert_eq "nothing to pause: 400" "$STATUS" "400"
AS POST "/api/v1/time-entries/timer/start?companyId=$C" '{"description":"mit Pause"}'
AS POST "/api/v1/time-entries/timer/pause?companyId=$C" "$EMPTY"; A="$STATUS $(field "d['running']['paused']")"
AS POST "/api/v1/time-entries/timer/pause?companyId=$C" "$EMPTY"
assert_eq "a timer is paused (was: 404, no such route) — once" "$A / $STATUS" "201 True / 400"
q "update \"RunningTimer\" set \"startedAt\" = now() - interval '60 minutes', \"pausedAt\" = now() - interval '20 minutes' where \"companyId\"='$C'"
AS GET "/api/v1/time-entries/timer?companyId=$C"
assert_eq "started an hour ago, paused for twenty minutes: the clock stands at 40 minutes" "$(field "d['running']['elapsedSeconds'] // 60, d['running']['paused']")" "(40, True)"
AS POST "/api/v1/time-entries/timer/resume?companyId=$C" "$EMPTY"; A="$STATUS $(field "d['running']['paused'], d['running']['elapsedSeconds'] // 60")"
AS POST "/api/v1/time-entries/timer/resume?companyId=$C" "$EMPTY"
assert_eq "it resumes at 40 minutes — once" "$A / $STATUS $(q "select \"pausedSeconds\" / 60 from \"RunningTimer\" where \"companyId\"='$C'")" "201 (False, 40) / 400 20"
AS POST "/api/v1/time-entries/timer/stop?companyId=$C" "$EMPTY"
assert_eq "stopped: 40 minutes are written, not 60" "$STATUS $(field "d['entry']['minutes']")" "201 40"
AS POST "/api/v1/time-entries/timer/start?companyId=$C" '{"description":"in der Pause gestoppt"}'
AS POST "/api/v1/time-entries/timer/pause?companyId=$C" "$EMPTY"
q "update \"RunningTimer\" set \"startedAt\" = now() - interval '30 minutes', \"pausedAt\" = now() - interval '10 minutes' where \"companyId\"='$C'"
AS POST "/api/v1/time-entries/timer/stop?companyId=$C" "$EMPTY"
assert_eq "stopped while paused: the time up to the pause" "$STATUS $(field "d['entry']['minutes']")" "201 20"
AS PUT "/api/v1/time-entries/settings?companyId=$C" '{"rounding":{"minutes":15}}'
AS POST "/api/v1/time-entries/timer/start?companyId=$C" '{"description":"gerundet"}'
q "update \"RunningTimer\" set \"startedAt\" = now() - interval '37 minutes' where \"companyId\"='$C'"
AS POST "/api/v1/time-entries/timer/stop?companyId=$C" "$EMPTY"
assert_eq "with the rule, a timer of 37 minutes writes 45" "$STATUS $(field "d['entry']['minutes']")" "201 45"
AS PUT "/api/v1/time-entries/settings?companyId=$C" '{"rounding":{"minutes":0}}'

note "=== 622. the time sheet goes out with the invoice ==="
q "delete from \"TimeEntry\" where \"companyId\"='$C'" >/dev/null   # this spec's own entries, to start the next two sections from nothing
te 60 ',"customerId":"'$K'","hourlyRate":100'; te 30 ',"customerId":"'$K'"'
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'"}'; INV=$(json_field "$BODY" invoiceId); NUM=$(json_field "$BODY" invoiceNumber)
AS POST "/api/v1/invoices/$INV/send-email?companyId=$C" '{"attachTimesheet":"nein"}'
assert_eq "attachTimesheet is a boolean" "$STATUS $(q "select count(*) from \"EmailSend\" where \"invoiceId\"='$INV'")" "400 0"
AS POST "/api/v1/invoices/$INV/send-email?companyId=$C" '{}'
assert_eq "the e-mail of an invoice over hours carries two PDFs (was: the invoice only)" \
  "$STATUS $(field "d['attachments']") $(q "select \"attachmentPaths\"->>1 from \"EmailSend\" where \"invoiceId\"='$INV' order by \"sentAt\" desc limit 1")" \
  "201 ['$NUM.pdf', 'Stundennachweis_$NUM.pdf'] Stundennachweis_$NUM.pdf"
AS POST "/api/v1/invoices/$INV/send-email?companyId=$C" '{"attachTimesheet":false}'
assert_eq "…unless it is told not to" "$STATUS $(field "d['attachments']")" "201 ['$NUM.pdf']"
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'; PLAIN=$(json_field "$BODY" id); PNUM=$(json_field "$BODY" invoiceNumber)
AS POST "/api/v1/invoices/$PLAIN/send-email?companyId=$C" '{}'
assert_eq "an invoice without hours goes out as before" "$STATUS $(field "d['attachments']")" "201 ['$PNUM.pdf']"

note "=== 625. who worked how much ==="
AS POST "/api/v1/time-projects?companyId=$C" '{"name":"Wartung","customerId":"'$K'","hourlyRate":120}'; P=$(json_field "$BODY" id)
te 45 ',"projectId":"'$P'"'; te 45 ',"billable":false'; te 600 ',"customerId":"'$K'"' "$YEAR-01-15"
EMAIL="$TAG-a@example.test"
AS GET "/api/v1/time-entries/report?companyId=$C&from=$TODAY&to=$TODAY"
assert_eq "today by employee: 3:00 h, 2:15 billable, 1:30 of it billed for 140 €, 0:45 open for 90 € (was: 404 — 'report' was no route)" \
  "$STATUS $(field "[(r['name'], r['entries'], r['minutes'], r['billableMinutes'], r['billedMinutes'], r['openMinutes'], r['billedAmount'], r['openAmount']) for r in d['rows']]")" \
  "200 [('$EMAIL', 4, 180, 135, 90, 45, 140, 90)]"
AS GET "/api/v1/time-entries/report?companyId=$C&from=$TODAY&to=$TODAY&groupBy=customer"
assert_eq "…by customer: the customer's 2:15, and 0:45 for nobody" "$(field "[(r['name'][-5:], r['minutes']) for r in d['rows']], d['total']['minutes']")" "([('Kunde', 135), ('', 45)], 180)"
AS GET "/api/v1/time-entries/report?companyId=$C&from=$TODAY&to=$TODAY&groupBy=project"
assert_eq "…by project: without one 2:15, on the project 0:45" "$(field "[(r['name'], r['minutes']) for r in d['rows']]")" "[('', 135), ('Wartung', 45)]"
AS GET "/api/v1/time-entries/report?companyId=$C"
assert_eq "without a period: the ten hours of January as well" "$(field "d['total']['minutes'], d['total']['openAmount']")" "(780, 890)"
AS GET "/api/v1/time-entries/report?companyId=$C&groupBy=rate"; A=$STATUS
AS GET "/api/v1/time-entries/report?companyId=$C&from=gestern"; B=$STATUS
UA=$U; CA=$C; U=$UB; C=$CB
AS GET "/api/v1/time-entries/report?companyId=$C"; X1=$(field "d['total']['minutes']")
AS GET "/api/v1/time-entries/report?companyId=$CA"
U=$UA; C=$CA
assert_eq "an unknown grouping, a date that is none: 400; another company reports its own 37 minutes and cannot ask for this company's" "$A $B $X1 $([[ "$STATUS" == 40[13] ]] && echo refused || echo "$STATUS")" "400 400 37 refused"
summary
