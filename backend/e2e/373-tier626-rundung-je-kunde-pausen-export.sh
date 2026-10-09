#!/bin/bash
# Tiers 626–628 — whose rounding rule; the pauses on the entry; the report as a file
#
# 626: the rounding rule of Tier 624 was the company's alone. A customer and
#      a project can have their own (timeRoundingMinutes / timeRoundingMode;
#      null = inherit, 0 = do not round): the project's goes before the
#      customer's, the customer's before the company's.
# 627: an entry written by a timer keeps its pauses — pauseCount and
#      pausedSeconds — the ones that ended (a stop during a pause ends the
#      work at the pause).
# 628: GET /time-entries/report.csv — the report of Tier 625 as a file; a
#      name that begins like a formula is defused.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-373-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier626-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
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
customer() { # name-suffix [extra json] → id
  AS POST "/api/v1/customers?companyId=$C" '{"name":"'"$1"'","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}'"${2:-}"'}'; json_field "$BODY" id
}
te() { AS POST "/api/v1/time-entries?companyId=$C" '{"date":"'$TODAY'","minutes":'$1',"description":"Arbeit"'"${2:-}"'}'; T=$(json_field "$BODY" id); }
minutes() { q "select minutes from \"TimeEntry\" where id='$1'"; }
timer() { AS POST "/api/v1/time-entries/timer/$1?companyId=$C" "${2:-$EMPTY}"; }

company b; UB=$U; CB=$C
company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }

note "=== 626. whose rule ==="
K=$(customer "$TAG Kunde")
# (not through customer(): its $( ) is a subshell, and the status is asserted here)
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Viertelstunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"timeRoundingMinutes":15,"timeRoundingMode":"up"}'; K15=$(json_field "$BODY" id)
assert_eq "a customer with a rule of its own: 15 minutes, up (was: 400, no such field)" "$STATUS $(q "select \"timeRoundingMinutes\" || '/' || \"timeRoundingMode\" from \"Customer\" where id='$K15'")" "201 15/up"
K0=$(customer "$TAG Minutengenau" ',"timeRoundingMinutes":0')
for bad in '{"timeRoundingMinutes":7}' '{"timeRoundingMinutes":"15"}' '{"timeRoundingMode":"down"}'; do AS PUT "/api/v1/customers/$K?companyId=$C" "$bad"; R="${R:-}$STATUS "; done
assert_eq "not a rule for a customer: 7 minutes, \"15\", a mode 'down'" "$R$(q "select \"timeRoundingMinutes\" is null from \"Customer\" where id='$K'")" "400 400 400 t"
AS POST "/api/v1/time-projects?companyId=$C" '{"name":"Halbe Stunden","customerId":"'$K15'","timeRoundingMinutes":30,"timeRoundingMode":"nearest"}'; P30=$(json_field "$BODY" id)
AS POST "/api/v1/time-projects?companyId=$C" '{"name":"Ohne eigene Regel","customerId":"'$K15'"}'; PX=$(json_field "$BODY" id)
AS POST "/api/v1/time-projects?companyId=$C" '{"name":"Falsch","timeRoundingMinutes":7}'; A=$STATUS
AS POST "/api/v1/time-projects?companyId=$C" '{"name":"Falsch","timeRoundingMinutes":15,"timeRoundingMode":"down"}'
assert_eq "a project with a rule of its own; 7 minutes or a mode 'down' are none" "$(q "select \"timeRoundingMinutes\" || '/' || \"timeRoundingMode\" from \"TimeProject\" where id='$P30'") $A $STATUS" "30/nearest 400 400"
AS PUT "/api/v1/time-entries/settings?companyId=$C" '{"rounding":{"minutes":10}}'
te 37;                               M1=$(minutes $T); E_NONE=$T
te 37 ',"customerId":"'$K'"';        M2=$(minutes $T); E_K=$T
te 37 ',"customerId":"'$K15'"';      M3=$(minutes $T)
te 37 ',"customerId":"'$K0'"';       M4=$(minutes $T)
te 37 ',"projectId":"'$P30'"';       M5=$(minutes $T); E_P=$T
te 37 ',"projectId":"'$PX'"';        M6=$(minutes $T)
assert_eq "37 minutes — the company rounds to 10: nobody's 40, a customer's without a rule 40; the customer with 15: 45; the one with 'do not round': 37; the project with 30 to the nearest: 30; the same customer's project without a rule: 45" \
  "$M1 $M2 $M3 $M4 $M5 $M6" "40 40 45 37 30 45"
AS PUT "/api/v1/time-entries/$E_K?companyId=$C" '{"minutes":37,"customerId":"'$K15'"}'; A=$(minutes $E_K)
AS PUT "/api/v1/time-entries/$E_P?companyId=$C" '{"minutes":50}'; B=$(minutes $E_P)
AS PUT "/api/v1/time-entries/$E_NONE?companyId=$C" '{"minutes":31}'
assert_eq "a changed duration is rounded by the rule of where the entry then is: moved to the customer with 15 → 45; on the project 50 → 60; nobody's 31 → 40" "$A $B $(minutes $E_NONE)" "45 60 40"
AS PUT "/api/v1/time-projects/$P30?companyId=$C" '{"timeRoundingMinutes":null,"timeRoundingMode":null}'
te 37 ',"projectId":"'$P30'"'
assert_eq "the project's rule taken away: its customer's applies" "$STATUS $(minutes $T)" "201 45"
AS PUT "/api/v1/time-projects/$P30?companyId=$C" '{"timeRoundingMinutes":30,"timeRoundingMode":"nearest"}'
timer start '{"projectId":"'$P30'","description":"Timer auf dem Projekt"}'
q "update \"RunningTimer\" set \"startedAt\" = now() - interval '37 minutes' where \"companyId\"='$C'"
timer stop
assert_eq "a timer on the project writes by the project's rule: 37 → 30" "$STATUS $(field "d['entry']['minutes']")" "201 30"
AS GET "/api/v1/time-projects?companyId=$C"
assert_eq "the project list names each project's own rule" "$(field "sorted((p['name'], p['timeRoundingMinutes'], p['timeRoundingMode']) for p in d['data'])")" "[('Halbe Stunden', 30, 'nearest'), ('Ohne eigene Regel', None, None)]"

note "=== 627. the pauses stay on the entry ==="
timer start '{"description":"zwei Pausen"}'
timer pause
q "update \"RunningTimer\" set \"startedAt\" = now() - interval '60 minutes', \"pausedAt\" = now() - interval '30 minutes' where \"companyId\"='$C'"
timer resume
timer pause
q "update \"RunningTimer\" set \"pausedAt\" = now() - interval '10 minutes' where \"companyId\"='$C'"
timer resume
assert_eq "two pauses taken and ended: 30 and 10 minutes" "$(q "select \"pauseCount\" || ' ' || \"pausedSeconds\" / 60 from \"RunningTimer\" where \"companyId\"='$C'")" "2 40"
timer stop; PE=$(field "d['entry']['id']")
assert_eq "the entry: 20 minutes of work, 2 pauses, 40 minutes of them (was: nothing of the pauses)" "$STATUS $(field "d['entry']['minutes'], d['entry']['pauseCount'], d['entry']['pausedSeconds'] // 60")" "201 (20, 2, 40)"
AS GET "/api/v1/time-entries?companyId=$C"
assert_eq "…and the list says so; an entry typed by hand has none" "$(field "[(e['pauseCount'], e['pausedSeconds'] // 60) for e in d['data'] if e['id']=='$PE'], sorted(set(e['pauseCount'] for e in d['data'] if e['id']!='$PE'))")" "([(2, 40)], [0])"
timer start '{"description":"in der Pause beendet"}'
timer pause
timer stop
assert_eq "stopped during a pause: the work ended there — no pause in it" "$STATUS $(field "d['entry']['pauseCount'], d['entry']['pausedSeconds']")" "201 (0, 0)"

note "=== 628. the report as a file ==="
EVIL=$(customer '=SUMME(A1:A9)'); SEMI=$(customer "$TAG Müller; Söhne")
te 60 ',"customerId":"'$EVIL'","hourlyRate":100'; te 30 ',"customerId":"'$SEMI'","hourlyRate":80'
CODE=$(curl -sS -o "/tmp/$TAG.csv" -D "/tmp/$TAG.hdr" -w "%{http_code}" "$API/api/v1/time-entries/report.csv?companyId=$C&groupBy=customer&from=$TODAY&to=$TODAY" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "the report by customer as a CSV for Excel: a BOM, semicolons, named after grouping and period (was: 404, no such route)" \
  "$CODE/$(grep -ci '^content-type: text/csv' "/tmp/$TAG.hdr")/$(head -c 3 "/tmp/$TAG.csv" | od -An -tx1 | tr -d ' \n')/$(grep -c "filename=\"Zeitauswertung_customer_${TODAY}_${TODAY}.csv\"" "/tmp/$TAG.hdr")/$(sed -n 1p "/tmp/$TAG.csv" | sed 's/^\xef\xbb\xbf//')" \
  "200/1/efbbbf/1/Kunde;Einträge;Stunden;davon abrechenbar;davon abgerechnet;davon offen;abgerechnet EUR;offen EUR"
assert_eq "a customer called like a formula is written as text; a name with a semicolon is quoted" \
  "$(grep -c "^'=SUMME(A1:A9);1;1.00;1.00;0.00;1.00;0.00;100.00$" "/tmp/$TAG.csv")/$(grep -c "^\"$TAG Müller; Söhne\";1;0.50;0.50;0.00;0.50;0.00;40.00$" "/tmp/$TAG.csv")/$(grep -c '^=' "/tmp/$TAG.csv")" "1/1/0"
AS GET "/api/v1/time-entries/report?companyId=$C&groupBy=customer&from=$TODAY&to=$TODAY"
TOTAL=$(field "'%d;%.2f;%.2f;%.2f;%.2f;%.2f;%.2f' % (d['total']['entries'], d['total']['minutes']/60, d['total']['billableMinutes']/60, d['total']['billedMinutes']/60, d['total']['openMinutes']/60, d['total']['billedAmount'], d['total']['openAmount'])")
assert_eq "the last line is the sum, as the report on the page has it; every customer of the day has a line" "$(tail -n 1 "/tmp/$TAG.csv") $(($(wc -l < "/tmp/$TAG.csv") - 2))" "Summe;$TOTAL $(field "len(d['rows'])")"
AS GET "/api/v1/time-entries/report.csv?companyId=$C&groupBy=rate"; A=$STATUS
UA=$U; CA=$C; U=$UB; C=$CB
CODE=$(curl -sS -o "/tmp/$TAG.csv" -w "%{http_code}" "$API/api/v1/time-entries/report.csv?companyId=$C&groupBy=customer" -H "x-user-id: $U" -H "x-company-id: $C")
AS GET "/api/v1/time-entries/report.csv?companyId=$CA"
U=$UA; C=$CA
assert_eq "an unknown grouping: 400; another company's file has its own (empty) sum and none of these names, and it cannot ask for this company's" \
  "$A $CODE/$(wc -l < "/tmp/$TAG.csv" | tr -d ' ')/$(grep -c 'SUMME\|Müller' "/tmp/$TAG.csv") $([[ "$STATUS" == 40[13] ]] && echo refused || echo "$STATUS")" "400 200/2/0 refused"
rm -f "/tmp/$TAG.csv" "/tmp/$TAG.hdr"
summary
