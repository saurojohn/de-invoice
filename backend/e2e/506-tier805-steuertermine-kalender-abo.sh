#!/bin/bash
# Tier 805 — the tax deadlines as a calendar to subscribe to
#
# The deadlines were on the dashboard and in reminder mails (Tiers 801–804);
# a calendar app could not show them. Now an admin makes a link on the UStVA
# page; GET /calendar/<token>.ics serves an iCalendar feed (RFC 5545) without
# a sign-in: the dashboard's rows and what follows within a year. The token is
# shown once, the company keeps its hash; a new link replaces the old one, the
# link can be withdrawn, and it stops when its admin or the company is gone.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-506-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
NB=$(printf '\302\240') # de-DE puts a no-break space before €

# ── the feed's text ───────────────────────────────────────────────────────
RULES=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
const c = require('./src/modules/reports/filing-calendar')
const long = 'DESCRIPTION:' + 'Umsatzsteuer-Voranmeldung für März; ä ö ü ß — '.repeat(6)
const folded = c.foldLine(long)
const parts = folded.split('\r\n')
const rows = [
  { kind: 'gewst', year: 2026, month: null, quarter: 4, dueDate: '2026-11-16', status: 'filed', note: null, amount: 1000 },
  { kind: 'svz', year: 2027, month: null, quarter: null, dueDate: '2027-02-10', status: 'open', note: 'a; b, c', amount: 19 },
  { kind: 'ustva', year: 2026, month: 12, quarter: null, dueDate: '2027-01-11', status: 'running', note: null },
]
const ics = c.buildIcs(rows, { companyId: 'C1', companyName: 'Muster, GmbH', origin: 'https://x.test', now: new Date('2026-11-05T10:00:00Z') })
const ev = ics.split('BEGIN:VEVENT').slice(1)
console.log(JSON.stringify([
  c.icsText('a\\\\b; c, d\ne'),
  parts.every((p) => Buffer.byteLength(p, 'utf8') <= 75) && parts.slice(1).every((p) => p.startsWith(' ')) && parts.map((p, i) => i ? p.slice(1) : p).join('') === long,
  ics.split('\r\n').slice(0, -1).every((l) => !l.includes('\n')) && ics.endsWith('END:VCALENDAR\r\n'),
  /DTSTART;VALUE=DATE:20261116\r\nDTEND;VALUE=DATE:20261117/.test(ev[0]),
  (ev[0].match(/SUMMARY:[^\r]*/) || [''])[0], ev[0].includes('VALARM'),
  (ev[1].match(/SUMMARY:[^\r]*/) || [''])[0], (ev[1].match(/DESCRIPTION:[^\r]*/) || [''])[0],
  (ev[2].match(/SUMMARY:[^\r]*/) || [''])[0], ev[2].includes('TRIGGER:-PT15H'),
  (ics.match(/X-WR-CALNAME:[^\r]*/) || [''])[0], (ev[2].match(/UID:[^\r]*/) || [''])[0],
]))
" 2>&1 | tail -1)
J() { python3 -c "import sys,json;print(json.loads(sys.argv[1])[int(sys.argv[2])])" "$RULES" "$1"; }
assert_eq "TEXT escaped: backslash, semicolon, comma, line break" "$(J 0)" 'a\\b\; c\, d\ne'
assert_eq "long lines folded at 75 octets, never inside a character, unfolded back to the line" "$(J 1)" "True"
assert_eq "CRLF line ends, nothing else breaks a line" "$(J 2)" "True"
assert_eq "an all-day event on the due day, ending the next" "$(J 3)" "True"
assert_eq "paid: ticked, the amount not repeated" "$(J 4)" "SUMMARY:✓ Gewerbesteuer-Vorauszahlung Q4 2026 (gezahlt)"
assert_eq "…and no alarm" "$(J 5)" "False"
assert_eq "the Sondervorauszahlung: an estimate, 'ca.'" "$(J 6)" "SUMMARY:Sondervorauszahlung 2027 fällig — ca. 19\,00${NB}€"
assert_eq "…its note escaped" "$(J 7)" 'DESCRIPTION:a\; b\, c\n\nÜbersicht: https://x.test/dashboard'
assert_eq "a running period" "$(J 8)" "SUMMARY:UStVA Dezember 2026 fällig"
assert_eq "…with an alarm at 09:00 the day before" "$(J 9)" "True"
assert_eq "the calendar is named after the company" "$(J 10)" 'X-WR-CALNAME:Steuertermine — Muster\, GmbH'
assert_eq "a UID fixed by kind, period and company" "$(J 11)" "UID:ustva-2026-12-C1@de-invoice"

# ── a fresh company ───────────────────────────────────────────────────────
reg() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier805-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(reg "$TAG")
read -r UB CB < <(reg "$TAG-b")
[[ -n "${C:-}" && -n "${CB:-}" ]] && pass "fixture: two fresh companies" || { fail "register"; summary; exit 1; }
AS() { # method path [body] [user company] [extra header]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: ${4:-$U}" -H "x-company-id: ${5:-$C}" \
    -H "Content-Type: application/json" ${6:+-H "$6"} ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
FEED() { # token → $FS (status), $TMP/feed.ics; no credentials at all
  FS=$(curl -sS -o "$TMP/feed.ics" -D "$TMP/feed.h" -w "%{http_code}" "$API/api/v1/calendar/$1.ics")
}

AS GET "/api/v1/ustva/calendar?companyId=$C"
assert_eq "no link yet (GET /ustva/calendar was 404)" "$STATUS/$(P "d['active']")" "200/False"
FEED "$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")"
assert_eq "an unknown token: 404" "$FS" "404"
FEED "abc"
assert_eq "a malformed one: 404" "$FS" "404"

AS POST "/api/v1/ustva/calendar?companyId=$C" '{}' "$U" "$C" "x-readonly: 1"
assert_eq "read-only mode refuses making a link" "$STATUS" "403"
AS POST "/api/v1/ustva/calendar?companyId=$C" '{}' "$UB" "$CB"
assert_eq "another company's admin makes no link for this one" "$(q "select coalesce(settings ? 'kalenderAbo', false) from \"Company\" where id='$C'")" "f"
AS POST "/api/v1/ustva/calendar?companyId=$C" '{}'
assert_eq "POST /ustva/calendar makes the link" "$STATUS/$(P "(d['active'], d['replaced'])")" "201/(True, False)"
URL1=$(P "d['url']"); T1=${URL1##*/}; T1=${T1%.ics}
assert_eq "…<origin>/api/v1/calendar/<43 characters>.ics" "$(python3 -c "import re,sys;print(bool(re.fullmatch(r'https?://[^/]+/api/v1/calendar/[A-Za-z0-9_-]{43}\.ics', sys.argv[1])))" "$URL1")" "True"
assert_eq "the company keeps the token's hash, not the token" \
  "$(q "select settings->'kalenderAbo'->>'tokenHash' = encode(sha256('$T1'::bytea), 'hex'), position('$T1' in settings::text) = 0 from \"Company\" where id='$C'")" "t|t"
AS GET "/api/v1/ustva/calendar?companyId=$C"
assert_eq "GET says a link is active and who made it — not the link" "$(P "(d['active'], d['createdBy'], 'url' in d)")" "(True, '$TAG@example.test', False)"

FEED "$T1"
assert_eq "the feed, without credentials" "$FS" "200"
assert_eq "…as text/calendar" "$(grep -i '^content-type' "$TMP/feed.h" | tr -d '\r' | cut -d' ' -f2-)" "text/calendar; charset=utf-8"
assert_eq "…never passed on as a Referer" "$(grep -ci '^referrer-policy: no-referrer' "$TMP/feed.h")" "1"
assert_eq "…named after the company" "$(grep -c "X-WR-CALNAME:Steuertermine — $TAG GmbH" "$TMP/feed.ics")" "1"
N_USTVA=$(grep -c '^UID:ustva-' "$TMP/feed.ics")
[[ $N_USTVA -ge 12 ]] && pass "a year of UStVA deadlines ($N_USTVA), not only the dashboard's next ones" || fail "UStVA events: $N_USTVA"
assert_eq "every event has its own UID" "$(grep '^UID:' "$TMP/feed.ics" | sort | uniq -d | wc -l | tr -d ' ')" "0"
assert_eq "the annual returns of the running year are in it" "$(grep -c '^SUMMARY:Jahreserklärungen' "$TMP/feed.ics")" "$(grep -c '^UID:annual-' "$TMP/feed.ics")"

# the prepayments entered appear with their amounts
Y=$(TZ=Europe/Berlin date +%Y)
for y in $Y $((Y + 1)); do AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" "{\"year\":$y,\"q1\":1000,\"q2\":1000,\"q3\":1000,\"q4\":1000}"; done
FEED "$T1"
N_GEWST=$(grep -c '^UID:gewst-' "$TMP/feed.ics")
[[ $N_GEWST -ge 3 && $N_GEWST -le 5 ]] && pass "the GewSt prepayments of the coming year ($N_GEWST)" || fail "GewSt events: $N_GEWST"
assert_eq "…with the Bescheid's amount" "$(grep -c "^SUMMARY:Gewerbesteuer-Vorauszahlung Q[1-4] [0-9]* fällig — 1\\.000\\\\,00${NB}€" "$TMP/feed.ics")" "$N_GEWST"

# a new link replaces the old
AS POST "/api/v1/ustva/calendar?companyId=$C" '{}'
assert_eq "a new link" "$STATUS/$(P "d['replaced']")" "201/True"
URL2=$(P "d['url']"); T2=${URL2##*/}; T2=${T2%.ics}
FEED "$T1"; assert_eq "the old link no longer works" "$FS" "404"
FEED "$T2"; assert_eq "the new one does" "$FS" "200"
# (by action, not by time: an audit row's createdAt is cut to the second, and
# both rows can fall in the same one — CI run 42099331247 had them the other way)
assert_eq "the audit trail has both" \
  "$(q "select string_agg(action, ',' order by action) from \"AuditLog\" where \"companyId\"='$C' and action like 'company.calendar_link.%'")" \
  "company.calendar_link.created,company.calendar_link.replaced"

# the link is its admin's, and the company's while it is open
q "update \"User\" set status='inactive' where id='$U'" >/dev/null
FEED "$T2"; assert_eq "its admin deactivated: the link stops" "$FS" "404"
q "update \"User\" set status='active' where id='$U'" >/dev/null
q "update \"UserCompany\" set role='viewer' where \"userId\"='$U' and \"companyId\"='$C'" >/dev/null
FEED "$T2"; assert_eq "its admin made a viewer: the link stops" "$FS" "404"
q "update \"UserCompany\" set role='admin' where \"userId\"='$U' and \"companyId\"='$C'" >/dev/null
FEED "$T2"; assert_eq "an admin again: it works again" "$FS" "200"
q "update \"Company\" set \"closedAt\"=now() where id='$C'" >/dev/null
FEED "$T2"; assert_eq "the company closed: the link stops" "$FS" "404"
q "update \"Company\" set \"closedAt\"=null where id='$C'" >/dev/null

# withdrawn
AS DELETE "/api/v1/ustva/calendar?companyId=$C" "" "$UB" "$CB"
assert_eq "another company's admin cannot withdraw it" "$(q "select coalesce(settings ? 'kalenderAbo', false) from \"Company\" where id='$C'")" "t"
AS DELETE "/api/v1/ustva/calendar?companyId=$C"
assert_eq "DELETE /ustva/calendar withdraws it" "$STATUS/$(P "(d['active'], d['revoked'])")" "200/(False, True)"
FEED "$T2"; assert_eq "…and the feed is gone" "$FS" "404"
assert_eq "…in the audit trail" "$(q "select count(*) from \"AuditLog\" where \"companyId\"='$C' and action='company.calendar_link.revoked'")" "1"
AS DELETE "/api/v1/ustva/calendar?companyId=$C"
assert_eq "withdrawing nothing is no error, and no audit row" "$STATUS/$(P "d['revoked']")/$(q "select count(*) from \"AuditLog\" where \"companyId\"='$C' and action='company.calendar_link.revoked'")" "200/False/1"

summary
