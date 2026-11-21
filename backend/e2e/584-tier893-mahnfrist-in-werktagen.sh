#!/bin/bash
# Tier 893 — one deadline, in Werktage, in the letter and in the e-mail
#
# Found by reading a Mahnung and the e-mail that carries it:
#   - the letter says „innerhalb der nächsten 7 Werktage“ and names a date
#     that was 7 calendar days on (moved off a weekend): from Saturday 21.11.
#     it named Monday 30.11., where seven Werktage end on Tuesday 01.12.;
#   - the default e-mail texts said „innerhalb von 14 Tagen“ (reminder),
#     „7 Tagen“, „5 Tagen“ — another deadline than the attached letter;
#   - and claimed „trotz unserer ersten Erinnerung“ / „trotz mehrfacher
#     Aufforderung“ whatever had been sent (Tier 892 fixed the letter).
# Now the date is 7 / 5 Werktage of the company's Land, and the texts say
# „bis zum {{neueFrist}}“ — the letter's date.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-584-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier893-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
# no Land: only the nationwide holidays count (werktage.ts)
q "update \"Company\" set bundesland=null where id='$C'" >/dev/null
DIR=$(mktemp -d)
# the server's day (the letter is dated by it) plus N Werktage, nationwide holidays
werktage() { python3 - "$1" <<'PY'
import datetime, sys
n = int(sys.argv[1])
def easter(y):
    a=y%19;b=y//100;c=y%100;d=b//4;e=b%4;f=(b+8)//25;g=(b-f+1)//3;h=(19*a+b-d-g+15)%30;i=c//4;k=c%4
    l=(32+2*e+2*i-h-k)%7;m=(a+11*h+22*l)//451;mo=(h+l-7*m+114)//31;da=((h+l-7*m+114)%31)+1
    return datetime.date(y,mo,da)
def holidays(y):
    e = easter(y)
    return {datetime.date(y,1,1), datetime.date(y,5,1), datetime.date(y,10,3), datetime.date(y,12,25), datetime.date(y,12,26),
            e-datetime.timedelta(days=2), e+datetime.timedelta(days=1), e+datetime.timedelta(days=39), e+datetime.timedelta(days=50)}
ok = lambda d: d.weekday() < 5 and d not in holidays(d.year)
d = datetime.date.today()
while not ok(d): d += datetime.timedelta(days=1)
added = 0
while added < n:
    d += datetime.timedelta(days=1)
    if ok(d): added += 1
print(d.strftime('%d.%m.%Y'))
PY
}
SEVEN=$(werktage 7); FIVE=$(werktage 5)
TODAY=$(TZ=Europe/Berlin date +%F)
OLD=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=60)).isoformat())")
DUE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=30)).isoformat())")
AS POST "/api/v1/customers?companyId=$C" '{"name":"Frist 584 GmbH","type":"business","address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(field id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$OLD\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(field id); AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'

note "=== 1. the letter's deadline ==="
AS POST "/api/v1/reminders/send" "$(printf '{"companyId":"%s","invoiceId":"%s","level":"second","channel":"post"}' "$C" "$I")"
curl -sS "$API/api/v1/reminders/mahnungen/$(field mahnungId)/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$DIR/m.pdf"
assert_eq "„Neue Zahlungsfrist“ = 7 Werktage on (was: 7 calendar days)" "$(pdf_text "$DIR/m.pdf" | grep -o "Neue Zahlungsfrist: [0-9.]*")" "Neue Zahlungsfrist: $SEVEN"

note "=== 2. the e-mail names the same date ==="
for L in first second final; do
  AS GET "/api/v1/reminders/templates/$L/preview?companyId=$C&invoiceId=$I"
  B=$(field body)
  WANT=$([ "$L" = final ] && echo "$FIVE" || echo "$SEVEN")
  assert_eq "$L: „bis zum $WANT“, no „innerhalb von … Tagen“" \
    "$(echo "$B" | grep -c "bis zum $WANT")/$(echo "$B" | grep -c "innerhalb von [0-9]* Tagen")" "1/0"
done
AS GET "/api/v1/reminders/templates/second/preview?companyId=$C&invoiceId=$I"
assert_eq "no claim of an earlier letter in the default texts" "$(field body | grep -c "trotz unserer ersten Erinnerung")" "0"
rm -rf "$DIR"
summary
