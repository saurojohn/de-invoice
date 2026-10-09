#!/bin/bash
# Tier 616 — projects below the customer; the rate an entry starts with
#
# Tier 611's time entries knew a customer and a rate typed each time. Now:
#   * Customer.defaultHourlyRate — what a new entry for the customer costs
#     when nothing else is said;
#   * TimeProject — a name, a customer (or none: internal), a rate of its
#     own, a budget in hours; hours are logged on it, filtered and billed by
#     it, and its list states what is logged against the budget;
#   * an entry written WITHOUT a rate takes the project's, else the
#     customer's; an explicit null stays "not priced".
# A project with hours is archived, not deleted, and keeps its customer.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-370-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); TODAY_DE="${TODAY:8:2}.${TODAY:5:2}.${TODAY:0:4}"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier616-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
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
project() { AS POST "/api/v1/time-projects?companyId=$C" "$1"; P=$(json_field "$BODY" id); }
te() { AS POST "/api/v1/time-entries?companyId=$C" '{"date":"'$TODAY'","minutes":60,"description":"'"$1"'"'"${2:-}"'}'; T=$(json_field "$BODY" id); }
rate() { q "select coalesce(\"hourlyRate\"::numeric(10,2)::text,'-') || '/' || coalesce(\"customerId\",'-') || '/' || coalesce(\"projectId\",'-') from \"TimeEntry\" where id='$1'"; }

company b; UB=$U; CB=$C; KB=$(customer Fremd); project '{"name":"Fremdprojekt","customerId":"'$KB'"}'; PB=$P
company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }

note "=== 1. the customer's default rate ==="
# (not through customer(): its $( ) is a subshell — the status asserted here was the one of an earlier call)
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"defaultHourlyRate":80}'; K=$(json_field "$BODY" id)
assert_eq "a customer with a default rate of 80 € (was: 400, no such field)" "$STATUS $(q "select \"defaultHourlyRate\"::numeric(10,2) from \"Customer\" where id='$K'")" "201 80.00"
for bad in '{"defaultHourlyRate":-1}' '{"defaultHourlyRate":80.123}' '{"defaultHourlyRate":"achtzig"}' '{"defaultHourlyRate":100001}'; do AS PUT "/api/v1/customers/$K?companyId=$C" "$bad"; R="${R:-}$STATUS "; done
assert_eq "not a rate: -1, three decimals, a word (digits in a string are a number since Tier 633), 100 001" "$R$(q "select \"defaultHourlyRate\"::numeric(10,2) from \"Customer\" where id='$K'")" "400 400 400 400 80.00"
AS PUT "/api/v1/customers/$K?companyId=$C" '{"defaultHourlyRate":null}'; A="$STATUS $(q "select \"defaultHourlyRate\" is null from \"Customer\" where id='$K'")"
AS PUT "/api/v1/customers/$K?companyId=$C" '{"defaultHourlyRate":80}'
assert_eq "null takes it away, a number sets it again" "$A / $STATUS" "200 t / 200"
K2=$(customer Zweiter)

note "=== 2. projects ==="
project '{"name":"Website","customerId":"'$K'"}'; P_WEB=$P; A=$STATUS
project '{"name":"Wartung","customerId":"'$K'","hourlyRate":120,"budgetHours":2}'; P_WART=$P
project '{"name":"Akquise"}'; P_INT=$P
assert_eq "three projects: one at the customer's rate, one with its own rate and a budget, one internal (was: 404, no such route)" "$A $(q "select count(*) from \"TimeProject\" where \"companyId\"='$C'")" "201 3"
LONG=$(python3 -c "print('x'*121)")
for bad in '{"customerId":"'$K'"}' '{"name":"  "}' '{"name":"'$LONG'"}' '{"name":"A","hourlyRate":-1}' '{"name":"A","hourlyRate":"90"}' '{"name":"A","budgetHours":0}' '{"name":"A","budgetHours":"10"}' '{"name":"A","customerId":"'$KB'"}' '{"name":"A","active":"false"}' '{"name":"website","customerId":"'$K'"}'; do
  project "$bad"; R2="${R2:-}$STATUS "
done
assert_eq "ten that are none: no name, a blank one, 121 characters, a rate of -1 / \"90\", a budget of 0 / \"10\", another company's customer, active \"false\", the customer's 'website' a second time" \
  "$R2$(q "select count(*) from \"TimeProject\" where \"companyId\"='$C'")" "400 400 400 400 400 400 400 400 400 400 3"
project '{"name":"Website","customerId":"'$K2'"}'
assert_eq "the same name for another customer is another project" "$STATUS" "201"
AS GET "/api/v1/time-projects?companyId=$C&customerId=$K"
assert_eq "the list says what an hour costs on each: the customer's 80 €, its own 120 €" "$(field "sorted((p['name'], float(p['effectiveRate'])) for p in d['data'])")" "[('Wartung', 120.0), ('Website', 80.0)]"

note "=== 3. the rate an entry starts with ==="
te "ohne alles" ',"customerId":"'$K'"';                               E1=$T; R1=$(rate $T)
te "auf Wartung" ',"projectId":"'$P_WART'"';                          E2=$T; R2b=$(rate $T)
te "eigener Satz" ',"projectId":"'$P_WART'","hourlyRate":95';         E3=$T; R3=$(rate $T)
te "bewusst ohne Preis" ',"customerId":"'$K'","hourlyRate":null';     E4=$T; R4=$(rate $T)
te "intern" ',"projectId":"'$P_INT'"';                                E5=$T; R5=$(rate $T)
te "intern für Kunde" ',"projectId":"'$P_INT'","customerId":"'$K'"';  E6=$T; R6=$(rate $T)
te "Kunde ohne Satz" ',"customerId":"'$K2'"';                         E7=$T; R7=$(rate $T)
assert_eq "no rate given: the customer's 80 €; on the project its 120 € — and the project brings its customer" "$R1 | $R2b" "80.00/$K/- | 120.00/$K/$P_WART"
assert_eq "a rate given stays; an explicit null stays unpriced" "$R3 | $R4" "95.00/$K/$P_WART | -/$K/-"
assert_eq "an internal project has no rate — unless the entry names a customer who has one; a customer without one: none" "$R5 | $R6 | $R7" "-/-/$P_INT | 80.00/$K/$P_INT | -/$K2/-"
te "falscher Kunde" ',"projectId":"'$P_WART'","customerId":"'$K2'"'; A="$STATUS/$(echo "$BODY" | grep -c 'gehört zu einem anderen Kunden')"
te "fremdes Projekt" ',"projectId":"'$PB'"'
assert_eq "a project of another customer, or of another company: 400" "$A $STATUS" "400/1 400"

note "=== 4. by project ==="
AS GET "/api/v1/time-entries?companyId=$C&projectId=$P_WART"
assert_eq "the entries of one project, each naming it" "$(field "len(d['data']), sorted(set(e['project']['name'] for e in d['data'])), d['summary']['minutes']")" "(2, ['Wartung'], 120)"
te "noch eine Stunde" ',"projectId":"'$P_WART'"'; E8=$T
AS GET "/api/v1/time-projects?companyId=$C&customerId=$K"
assert_eq "the project list: 3 h logged against a budget of 2 h" "$(field "[(p['minutes'], p['openMinutes'], float(p['budgetHours'])) for p in d['data'] if p['name']=='Wartung']")" "[(180, 180, 2.0)]"
AS PUT "/api/v1/time-entries/$E8?companyId=$C" '{"customerId":"'$K2'"}'
assert_eq "an entry moved to another customer leaves the first customer's project" "$STATUS $(rate "$E8")" "200 120.00/$K2/-"
AS PUT "/api/v1/time-entries/$E8?companyId=$C" '{"customerId":"'$K'","projectId":"'$P_WEB'"}'
assert_eq "…and is put on a project again" "$STATUS $(rate "$E8")" "200 120.00/$K/$P_WEB"
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'","projectId":"'$P_WART'"}'; INV=$(json_field "$BODY" invoiceId)
assert_eq "billing one project: its two entries — 120 € and 95 € — and nothing of the customer's other hours" \
  "$STATUS $(field "d['entries'], d['net']") $(q "select count(*) from \"TimeEntry\" where \"companyId\"='$C' and \"invoiceId\" is not null and \"projectId\"<>'$P_WART'")" "201 (2, 215) 0"
assert_eq "the invoice lines name the project" "$(q "select string_agg(description, ' ; ' order by \"sortOrder\") from \"InvoiceItem\" where \"invoiceId\"='$INV'")" "$TODAY_DE Wartung: auf Wartung ; $TODAY_DE Wartung: eigener Satz"
AS GET "/api/v1/time-projects?companyId=$C&customerId=$K"
assert_eq "the project: 2 h logged, none of them open any more" "$(field "[(p['minutes'], p['openMinutes']) for p in d['data'] if p['name']=='Wartung']")" "[(120, 0)]"

note "=== 5. keeping a project ==="
AS PUT "/api/v1/time-projects/$P_WART?companyId=$C" '{"name":"Wartung 2026","hourlyRate":130,"budgetHours":null}'
assert_eq "renamed, repriced, the budget taken away — the logged hours keep their rate" "$STATUS $(field "d['name'], float(d['hourlyRate']), d['budgetHours']") $(rate "$E2" | cut -d/ -f1)" "200 ('Wartung 2026', 130.0, None) 120.00"
AS PUT "/api/v1/time-projects/$P_WART?companyId=$C" '{"customerId":"'$K2'"}'; A=$STATUS
AS DELETE "/api/v1/time-projects/$P_WART?companyId=$C"
assert_eq "a project with hours: not given to another customer, not deleted" "$A $STATUS/$(echo "$BODY" | grep -c 'archivieren')/$(q "select count(*) from \"TimeProject\" where id='$P_WART'")" "400 400/1/1"
AS PUT "/api/v1/time-projects/$P_WART?companyId=$C" '{"active":false}'
AS GET "/api/v1/time-projects?companyId=$C&customerId=$K";                       A=$(field "len(d['data'])")
AS GET "/api/v1/time-projects?companyId=$C&customerId=$K&includeInactive=true"
assert_eq "…it is archived: off the list, there when asked for" "$A $(field "len(d['data'])")" "1 2"
project '{"name":"Leer","customerId":"'$K2'"}'; P_EMPTY=$P
AS DELETE "/api/v1/time-projects/$P_EMPTY?companyId=$C"
assert_eq "a project without hours is deleted" "$STATUS $(q "select count(*) from \"TimeProject\" where id='$P_EMPTY'")" "200 0"
UA=$U; CA=$C; U=$UB; C=$CB
AS GET "/api/v1/time-projects?companyId=$C&includeInactive=true";              X1=$(field "[p['name'] for p in d['data']]")
AS PUT "/api/v1/time-projects/$P_WEB?companyId=$C" '{"name":"gekapert"}';       X2=$STATUS
AS DELETE "/api/v1/time-projects/$P_INT?companyId=$C";                          X3=$STATUS
te "auf fremdem Projekt" ',"projectId":"'$P_WEB'"'
U=$UA; C=$CA
assert_eq "another company sees its own project only, changes none, deletes none, logs on none" "$X1 $X2 $X3 $STATUS $(q "select name from \"TimeProject\" where id='$P_WEB'")" "['Fremdprojekt'] 404 404 400 Website"

note "=== 6. around it ==="
K3=$(customer Dritter); project '{"name":"Nur ein Projekt","customerId":"'$K3'"}'; P3=$P
AS DELETE "/api/v1/customers/$K3?companyId=$C"
assert_eq "a customer with a project is not deleted" "$STATUS/$(echo "$BODY" | grep -c 'Projekt')/$(q "select count(*) from \"Customer\" where id='$K3'")" "400/1/1"
K4=$(customer Vierter)
AS POST "/api/v1/customers/merge?companyId=$C" '{"sourceId":"'$K3'","targetId":"'$K4'"}'
assert_eq "merging that customer takes the project along" "$STATUS $(q "select \"customerId\"='$K4' from \"TimeProject\" where id='$P3'")/$(q "select count(*) from \"Customer\" where id='$K3'")" "200 t/0"
assert_eq "the audit log has the projects: created, changed, deleted" \
  "$(q "select string_agg(distinct action, ' ' order by action) from \"AuditLog\" where \"companyId\"='$C' and action like 'timeproject.%'")" "timeproject.created timeproject.deleted timeproject.updated"
summary
