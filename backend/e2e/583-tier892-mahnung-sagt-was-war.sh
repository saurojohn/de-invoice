#!/bin/bash
# Tier 892 — the Mahnung says what happened before it
#
# Found by reading a Mahnung at level 2 that was the first letter for its
# invoice (one may start at level 2): it said „trotz unserer früheren
# Erinnerung“ — a reminder that never went out. The final level said
# „trotz mehrfacher Aufforderung“ after one letter. The fee line read
# „Mahngebühr (Stufe 2 (1. Mahnung))“.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-583-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier892-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
DIR=$(mktemp -d)
TODAY=$(TZ=Europe/Berlin date +%F)
OLD=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=60)).isoformat())")
DUE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=30)).isoformat())")
AS POST "/api/v1/customers?companyId=$C" '{"name":"Säumig 583 GmbH","type":"business","address":{"street":"Weg 1","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(field id)
overdue() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$OLD\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  I=$(field id); AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
letter() { # invoice level → the letter's text
  AS POST "/api/v1/reminders/send" "$(printf '{"companyId":"%s","invoiceId":"%s","level":"%s","channel":"post"}' "$C" "$1" "$2")"
  curl -sS "$API/api/v1/reminders/mahnungen/$(field mahnungId)/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -o "$DIR/m.pdf"
  pdf_text "$DIR/m.pdf"
}

note "=== 1. level 2 as the first letter ==="
overdue; A=$I
T=$(letter "$A" second)
assert_eq "no „früheren Erinnerung“ that never went out" \
  "$(echo "$T" | grep -c "früheren Erinnerung")/$(echo "$T" | grep -c "ist trotz Fälligkeit weiterhin unbeglichen. Wir fordern Sie hiermit zur Zahlung auf.")" "0/1"
assert_eq "the fee line without nested parentheses (was: Stufe 2 (1. Mahnung))" "$(echo "$T" | grep -c "Mahngebühr (Stufe 2 – 1. Mahnung)")" "1"
T=$(letter "$A" final)
assert_eq "the final letter after one: „trotz unserer Aufforderung“ (was: mehrfacher)" \
  "$(echo "$T" | grep -c "trotz mehrfacher")/$(echo "$T" | grep -c "trotz unserer Aufforderung bleibt")" "0/1"

note "=== 2. after a reminder ==="
overdue; B=$I
letter "$B" first >/dev/null
T=$(letter "$B" second)
assert_eq "level 2 after a reminder: „trotz unserer früheren Erinnerung“ as before" "$(echo "$T" | grep -c "trotz unserer früheren Erinnerung")" "1"
T=$(letter "$B" final)
assert_eq "the final letter after two: „trotz mehrfacher Aufforderung“" "$(echo "$T" | grep -c "trotz mehrfacher Aufforderung")" "1"
rm -rf "$DIR"
summary
