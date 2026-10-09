#!/bin/bash
# Tier 611 — time tracking (Zeiterfassung)
#
# Hours worked had no place in the system: a freelancer or an agency kept
# them elsewhere and typed the invoice lines by hand. An entry is now a day,
# a duration in minutes and a description — with or without a customer and an
# hourly rate. The open, billable, priced entries of a customer become the
# lines of an invoice draft; from then on they are "billed" and neither
# changed nor deleted. Deleting the draft or cancelling the invoice opens
# them again. Hours are billed as on the invoice line: with two decimals
# (50 min → 0,83 Std), times the rate.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-366-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}
TODAY_DE="${TODAY:8:2}.${TODAY:5:2}.${TODAY:0:4}"
TOMORROW=$(python3 -c "import datetime,zoneinfo;print((datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date()+datetime.timedelta(days=1)).isoformat())")
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier611-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
te() { AS POST "/api/v1/time-entries?companyId=$C" "$1"; T=$(json_field "$BODY" id); }
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
entries() { q "select count(*) from \"TimeEntry\" where \"companyId\"='$C'"; }
customer() { AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' '$1'","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; json_field "$BODY" id; }

company b; UB=$U; CB=$C; KB=$(customer Fremd)
company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
K=$(customer Kunde); K2=$(customer Zweiter)

note "=== 1. writing hours down ==="
te '{"date":"'$TODAY'","minutes":90,"description":"Beratung","customerId":"'$K'","hourlyRate":100}'; E1=$T
assert_eq "an entry: 201, billable, open (was: 404, no such route)" "$STATUS $(field "d['minutes'], d['billable'], d['invoiceId'], d['customer']['id']=='$K'")" "201 (90, True, None, True)"
for bad in \
  '{"date":"'$TODAY'","minutes":0,"description":"x"}' \
  '{"date":"'$TODAY'","minutes":1441,"description":"x"}' \
  '{"date":"'$TODAY'","minutes":1.5,"description":"x"}' \
  '{"date":"'$TODAY'","minutes":"90","description":"x"}' \
  '{"date":"'$TODAY'","minutes":60,"description":"  "}' \
  '{"date":"'$TODAY'","minutes":60}' \
  '{"date":"'$TOMORROW'","minutes":60,"description":"x"}' \
  '{"date":"2026-02-30","minutes":60,"description":"x"}' \
  '{"minutes":60,"description":"x"}' \
  '{"date":"'$TODAY'","minutes":60,"description":"x","hourlyRate":-1}' \
  '{"date":"'$TODAY'","minutes":60,"description":"x","hourlyRate":10.005}' \
  '{"date":"'$TODAY'","minutes":60,"description":"x","hourlyRate":"90"}' \
  '{"date":"'$TODAY'","minutes":60,"description":"x","billable":"false"}' \
  '{"date":"'$TODAY'","minutes":60,"description":"x","customerId":"'$KB'"}'; do
  te "$bad"; R="${R:-}$STATUS "
done
assert_eq "fourteen entries that are none: 0 / 1441 / 1.5 / \"90\" minutes, no description, a day in the future / that does not exist / missing, a rate of -1 / 10.005 / \"90\", billable \"false\", another company's customer" \
  "$R$(entries)" "400 400 400 400 400 400 400 400 400 400 400 400 400 400 1"

note "=== 2. the list and its sums ==="
te '{"date":"'$TODAY'","minutes":50,"description":"Telefonat","customerId":"'$K'","hourlyRate":90}'; E2=$T
te '{"date":"'$TODAY'","minutes":30,"description":"Recherche","customerId":"'$K'"}'; E3=$T
te '{"date":"'$TODAY'","minutes":60,"description":"Einarbeitung","customerId":"'$K'","hourlyRate":80,"billable":false}'; E4=$T
te '{"date":"'$TODAY'","minutes":120,"description":"Workshop","customerId":"'$K2'","hourlyRate":50}'; E5=$T
te '{"date":"'$TODAY'","minutes":45,"description":"Intern","hourlyRate":100}'; E6=$T
AS GET "/api/v1/time-entries?companyId=$C&customerId=$K&state=open"
assert_eq "the customer's four entries: 3:50 h, 2:50 h open and billable, 224,70 € (1,5 × 100 + 0,83 × 90)" \
  "$(field "len(d['data']), d['summary']['minutes'], d['summary']['openBillableMinutes'], d['summary']['openAmount']")" "(4, 230, 170, 224.7)"
AS GET "/api/v1/time-entries?companyId=$C"
assert_eq "all six, the newest first" "$(field "len(d['data']), d['data'][0]['description'], d['summary']['minutes']")" "(6, 'Intern', 395)"
AS GET "/api/v1/time-entries?companyId=$C&state=nonsense"; A=$STATUS
AS GET "/api/v1/time-entries"
assert_eq "an unknown state: 400; no company: not every company's hours" "$A $([[ "$STATUS" == 4* ]] && echo refused || echo "$STATUS")" "400 refused"

note "=== 3. changing and deleting ==="
AS PUT "/api/v1/time-entries/$E3?companyId=$C" '{"minutes":40,"hourlyRate":60}'
assert_eq "an open entry is changed" "$STATUS $(field "d['minutes'], float(d['hourlyRate']), d['description']")" "200 (40, 60.0, 'Recherche')"
AS PUT "/api/v1/time-entries/$E3?companyId=$C" '{"minutes":30,"hourlyRate":null}'
assert_eq "…and its rate taken away again" "$STATUS $(field "d['minutes'], d['hourlyRate']")" "200 (30, None)"
AS PUT "/api/v1/time-entries/$E3?companyId=$C" '{"minutes":0}'
assert_eq "a change is checked like a new entry" "$STATUS" "400"
AS DELETE "/api/v1/time-entries/$E6?companyId=$C"
assert_eq "an open entry is deleted" "$STATUS $(entries)" "200 5"
UA=$U; CA=$C; U=$UB; C=$CB
AS GET "/api/v1/time-entries?companyId=$C";                                   X1=$(field "len(d['data'])")
AS PUT "/api/v1/time-entries/$E1?companyId=$C" '{"minutes":1}';                X2=$STATUS
AS DELETE "/api/v1/time-entries/$E1?companyId=$C";                             X3=$STATUS
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'"}';      X4=$STATUS
AS GET "/api/v1/time-entries?companyId=$CA";                                   X5=$STATUS
U=$UA; C=$CA
assert_eq "another company: sees none, changes none, deletes none, bills none, and cannot name this company" \
  "$X1 $X2 $X3 $X4 $([[ "$X5" == 40[13] ]] && echo refused || echo "$X5") $(q "select minutes from \"TimeEntry\" where id='$E1'")" "0 404 404 400 refused 90"

note "=== 4. billing ==="
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'","entryIds":["'$E1'","'$E3'"]}'
assert_eq "a chosen entry without a rate: 400, nothing invoiced" "$STATUS/$(echo "$BODY" | grep -c 'keinen Stundensatz')/$(q "select count(*) from \"Invoice\" where \"companyId\"='$C'")" "400/1/0"
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'","entryIds":["'$E1'","'$E5'"]}'; A=$STATUS
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'","entryIds":["'$E1'","'$E4'"]}'
assert_eq "a chosen entry of another customer, or one that is not billable: 400" "$A $STATUS $(q "select count(*) from \"Invoice\" where \"companyId\"='$C'")" "400 400 0"
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'"}'; INV=$(json_field "$BODY" invoiceId)
assert_eq "the customer's open hours: two entries invoiced, the one without a rate left open — 224,70 € net, 267,39 € gross" \
  "$STATUS $(field "d['entries'], d['skipped'], d['net'], d['total']")" "201 (2, 1, 224.7, 267.39)"
assert_eq "an invoice draft dated today, one line per entry: day and activity, hours, rate" \
  "$(q "select type || '|' || status || '|' || \"issueDate\"::date from \"Invoice\" where id='$INV'") $(q "select string_agg(description || '|' || quantity::numeric(10,2) || '|' || unit || '|' || \"unitPrice\"::numeric(10,2), ' ; ' order by \"sortOrder\") from \"InvoiceItem\" where \"invoiceId\"='$INV'")" \
  "INV|draft|$TODAY $TODAY_DE Beratung|1.50|Std|100.00 ; $TODAY_DE Telefonat|0.83|Std|90.00"
AS GET "/api/v1/time-entries?companyId=$C&customerId=$K&state=billed"
assert_eq "both are billed and name the invoice" "$(field "len(d['data']), sorted(set(e['invoice']['id'] for e in d['data'])) == ['$INV']")" "(2, True)"
AS GET "/api/v1/time-entries?companyId=$C&customerId=$K&state=open"
assert_eq "open: the entry without a rate and the one that is not billable — nothing left to bill" "$(field "len(d['data']), d['summary']['openBillableMinutes'], d['summary']['openAmount']")" "(2, 30, 0)"
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'"}'
assert_eq "billing again: 400, no second invoice" "$STATUS $(q "select count(*) from \"Invoice\" where \"companyId\"='$C'")" "400 1"
AS PUT "/api/v1/time-entries/$E1?companyId=$C" '{"minutes":600}'; A=$STATUS
AS DELETE "/api/v1/time-entries/$E1?companyId=$C"
assert_eq "a billed entry is not changed and not deleted" "$A $STATUS/$(echo "$BODY" | grep -c 'abgerechnet')/$(q "select minutes from \"TimeEntry\" where id='$E1'")" "400 400/1/90"
note "=== 5. opening again ==="
AS DELETE "/api/v1/invoices/$INV?companyId=$C"
assert_eq "the draft is deleted: its entries are open again" "$STATUS $(q "select count(*) from \"TimeEntry\" where id in ('$E1','$E2') and \"invoiceId\" is null")" "200 2"
AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'","entryIds":["'$E1'"]}'; INV2=$(json_field "$BODY" invoiceId)
AS PUT "/api/v1/invoices/$INV2/status?companyId=$C" '{"status":"sent"}'
assert_eq "one entry billed and the invoice issued: still billed" "$STATUS $(q "select \"invoiceId\"='$INV2' from \"TimeEntry\" where id='$E1'")" "200 t"
AS PUT "/api/v1/invoices/$INV2/status?companyId=$C" '{"status":"cancelled"}'
assert_eq "the invoice is cancelled: the entry is open again, to be invoiced anew" "$STATUS $(q "select \"invoiceId\" is null from \"TimeEntry\" where id='$E1'")" "200 t"

AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K'"}'; INV3=$(json_field "$BODY" invoiceId)
(AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K2'"}'; echo "$STATUS" > "/tmp/$TAG.1") &
(AS POST "/api/v1/time-entries/bill?companyId=$C" '{"customerId":"'$K2'"}'; echo "$STATUS" > "/tmp/$TAG.2") &
wait
assert_eq "two clicks at once: one invoice for the other customer's hours, not two" \
  "$(cat "/tmp/$TAG.1" "/tmp/$TAG.2" | sort | tr '\n' ' ')$(q "select count(*) from \"Invoice\" where \"companyId\"='$C' and \"customerId\"='$K2'")" "201 400 1"
rm -f "/tmp/$TAG.1" "/tmp/$TAG.2"

AS DELETE "/api/v1/invoices/$INV3?companyId=$C"; A=$STATUS
AS PUT "/api/v1/invoices/$INV3/status?companyId=$C" '{"status":"cancelled"}'
assert_eq "a draft that is no longer the last invoice cannot be deleted — cancelling it opens its hours as well" \
  "$A $STATUS $(q "select count(*) from \"TimeEntry\" where id in ('$E1','$E2') and \"invoiceId\" is null")" "403 200 2"

note "=== 6. around it ==="
K3=$(customer Dritter)
te '{"date":"'$TODAY'","minutes":15,"description":"Erstgespräch","customerId":"'$K3'"}'
AS DELETE "/api/v1/customers/$K3?companyId=$C"
assert_eq "a customer with hours on record is not deleted" "$STATUS/$(echo "$BODY" | grep -c 'Zeiteintr')/$(q "select count(*) from \"Customer\" where id='$K3'")" "400/1/1"
assert_eq "the audit log has the entries: written, changed, deleted" \
  "$(q "select string_agg(distinct action, ' ' order by action) from \"AuditLog\" where \"companyId\"='$C' and action like 'timeentry.%'")" "timeentry.created timeentry.deleted timeentry.updated"
summary
