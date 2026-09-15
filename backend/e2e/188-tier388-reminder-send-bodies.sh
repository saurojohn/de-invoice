#!/bin/bash
# Tier 388 — the manual Mahnung is really sent, only open invoices are dunned,
# and the reminder / Mahnungspause bodies are validated
#
# Measured before the change on a fresh company:
#   POST /reminders/send       201 + EmailSend "sent" + Mahnung, but no mail attempt at all
#                              (the invoice page then shows "Mahnung wurde versendet")
#   send / bulk-send on a paid and on a draft invoice → Mahnung with fees (bulk also mailed)
#   level "bogus" → 201, Mahnung level "bogus"; missing invoiceId → 500
#   fees-config null / "abc" / -5 → 0; 5000 → 1000; 99 → 50; "mahngebuehr":"x" → 200
#   templates: 5000-char subject, 200 000-char body stored; subject 123 → 500 (now "123")
#   cancel: 20 000-char reason stored
#   mahnungspausen: pausedUntil "abc" → 500, "2026-02-30" stored, 20 000-char reason,
#                   customerId 123 → 500; PATCH pausedUntil "abc" → 500
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-188-$(date +%s%N | cut -c1-13)"
BACKEND_LOG="${BACKEND_LOG:-/tmp/backend.log}"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

REG=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier388-e2e\",\"companyName\":\"$TAG\"}")
read -r U C < <(echo "$REG" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fresh company" || { fail "register failed"; summary; exit 1; }
TMPD=$(mktemp -d)
req() { # method path [body-file]
  local resp
  if [[ -n "${3:-}" ]]; then
    resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" --data-binary "@$3")
  else
    resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C")
  fi
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
# JSON bodies go through printf into files (a \" inside $(...) keeps the backslash).
json() { local name="$1" fmt="$2"; shift 2; printf "$fmt" "$@" > "$TMPD/$name.json"; echo "$TMPD/$name.json"; }
Q="companyId=$C"
MAIL="kunde-$TAG@example.test"

f=$(json cust '{"name":"%s Kunde","type":"business","contact":{"email":"%s"}}' "$TAG" "$MAIL")
req POST "/api/v1/customers?$Q" "$f"; CUST=$(json_field "$BODY" id)
invoice() { # status
  local f id
  f=$(json "inv-$1" '{"customerId":"%s","issueDate":"2026-01-01T00:00:00Z","dueDate":"2026-01-31T00:00:00Z","items":[{"description":"%s","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}' "$CUST" "$TAG")
  req POST "/api/v1/invoices?$Q" "$f"; id=$(json_field "$BODY" id)
  if [[ "$1" != draft ]]; then
    f=$(json "st-$1" '{"status":"%s"}' "$1"); req PUT "/api/v1/invoices/$id/status?$Q" "$f"
  fi
  echo "$id"
}
OPEN=$(invoice sent); PAID=$(invoice paid); DRAFT=$(invoice draft)
[[ -n "$CUST" && -n "$OPEN" && -n "$PAID" && -n "$DRAFT" ]] && pass "customer with e-mail, overdue open / paid / draft invoices" || { fail "fixtures"; summary; exit 1; }
OPEN_NO=$(sql "SELECT \"invoiceNumber\" FROM \"Invoice\" WHERE id = '$OPEN';")
MAHNUNGEN() { sql "SELECT count(*) FROM \"Mahnung\" WHERE \"invoiceId\" = '$1';"; }
mails_to() { sed 's/\x1b\[[0-9;]*m//g' "$BACKEND_LOG" 2>/dev/null | grep -E "NO-SMTP|Email sent" | grep -c "$MAIL"; }

note "=== 1. the invoice page's manual send sends the letter ==="
BEFORE=$(mails_to)
# invoice detail page shape: the modal's preview travels along
f=$(json send-open '{"companyId":"%s","invoiceId":"%s","recipientEmail":"%s","recipientName":"%s Kunde","subject":"Vorschau","body":"Vorschau","level":"first","createdById":"%s"}' "$C" "$OPEN" "$MAIL" "$TAG" "$U")
req POST "/api/v1/reminders/send" "$f"
assert_status 201 "send (invoice page shape)"
[[ -n "$(json_field "$BODY" mahnungId)" ]] && pass "…mahnungId returned" || fail "…no mahnungId"
sleep 1
AFTER=$(mails_to)
[[ -f "$BACKEND_LOG" ]] && { [[ "$AFTER" -gt "$BEFORE" ]] && pass "…a mail to the customer was attempted (none before)" || fail "…no mail attempt to $MAIL in $BACKEND_LOG"; } || note "no backend log at $BACKEND_LOG — mail attempt not checked"
assert_eq "…one Mahnung" "$(MAHNUNGEN "$OPEN")" "1"
assert_eq "…EmailSend with the company's subject" "$(sql "SELECT count(*) FROM \"EmailSend\" WHERE \"invoiceId\" = '$OPEN' AND subject LIKE '%$OPEN_NO%';")" "1"
req POST "/api/v1/reminders/send" "$f"
assert_status 409 "same level again today → 409 (was 201)"
assert_eq "…still one Mahnung" "$(MAHNUNGEN "$OPEN")" "1"

note "=== 2. only open invoices are dunned ==="
for t in "paid $PAID" "draft $DRAFT"; do
  read -r st id <<< "$t"
  f=$(json "send-$st" '{"companyId":"%s","invoiceId":"%s","level":"second"}' "$C" "$id")
  req POST "/api/v1/reminders/send" "$f"
  assert_status 400 "send on a $st invoice (was 201 with fees)"
done
f=$(json bulk '{"companyId":"%s","invoiceIds":["%s","%s"],"level":"final"}' "$C" "$PAID" "$DRAFT")
req POST "/api/v1/reminders/bulk-send?$Q" "$f"
assert_status 201 "bulk send (invoices list shape)"
assert_eq "…both refused (were sent)" "$(json_field "$BODY" failed)" "2"
assert_eq "…no Mahnung for paid / draft" "$(( $(MAHNUNGEN "$PAID") + $(MAHNUNGEN "$DRAFT") ))" "0"

note "=== 3. send / bulk bodies ==="
f=$(json lvl '{"companyId":"%s","invoiceId":"%s","level":"bogus"}' "$C" "$OPEN"); req POST /api/v1/reminders/send "$f"
assert_status 400 "level bogus (was 201, stored)"
f=$(json noinv '{"companyId":"%s","level":"first"}' "$C"); req POST /api/v1/reminders/send "$f"
assert_status 400 "missing invoiceId (was 500)"
f=$(json unk '{"companyId":"%s","invoiceId":"00000000-0000-0000-0000-000000000000","level":"first"}' "$C"); req POST /api/v1/reminders/send "$f"
assert_status 404 "unknown invoice"
f=$(json many '{"companyId":"%s","invoiceIds":%s,"level":"first"}' "$C" "$(python3 -c "import json;print(json.dumps(['x%d'%i for i in range(101)]))")"); req POST "/api/v1/reminders/bulk-send?$Q" "$f"
assert_status 400 "bulk with 101 invoices (were cut to 100)"
f=$(json num '{"companyId":"%s","invoiceIds":[123],"level":"first"}' "$C"); req POST "/api/v1/reminders/bulk-send?$Q" "$f"
assert_status 400 "bulk invoiceIds [123]"

note "=== 4. fee config ==="
f=$(json fees '{"verzugszinsPct":9,"mahngebuehr":{"first":0,"second":2.5,"final":5}}'); req PUT "/api/v1/reminders/mahnungen/fees-config?$Q" "$f"
assert_status 200 "fees (settings page shape)"
STORED=$(sql "SELECT \"bankInfo\"->'mahnungConfig' FROM \"Company\" WHERE id = '$C';")
for b in '{"verzugszinsPct":null}' '{"verzugszinsPct":"abc"}' '{"verzugszinsPct":-5}' '{"verzugszinsPct":99}' '{"mahngebuehr":{"final":5000}}' '{"mahngebuehr":{"second":null}}' '{"mahngebuehr":"x"}'; do
  printf '%s' "$b" > "$TMPD/fb.json"; req PUT "/api/v1/reminders/mahnungen/fees-config?$Q" "$TMPD/fb.json"
  assert_status 400 "fees $b (was 200, coerced)"
done
assert_eq "…stored config unchanged" "$(sql "SELECT \"bankInfo\"->'mahnungConfig' FROM \"Company\" WHERE id = '$C';")" "$STORED"

note "=== 5. templates, cancel ==="
f=$(json tpl '{"subject":"Erinnerung {{invoiceNumber}}","body":"Sehr geehrte Damen und Herren,\\n…"}'); req PUT "/api/v1/reminders/templates/first?$Q" "$f"
assert_status 200 "template (mahnungen/templates page shape)"
f=$(json tpl-s '{"subject":"%s","body":"x"}' "$(printf 'S%.0s' $(seq 1 301))"); req PUT "/api/v1/reminders/templates/first?$Q" "$f"
assert_status 400 "template subject 301 chars (5000 were stored)"
f=$(json tpl-b '{"subject":"ok","body":"%s"}' "$(python3 -c "print('x'*20001)")"); req PUT "/api/v1/reminders/templates/first?$Q" "$f"
assert_status 400 "template body 20001 chars (200 000 were stored)"
# subject 123 was a 500. It is not asserted: the global ValidationPipe's
# enableImplicitConversion turns a number (or an object) into a string before
# @IsString runs, so it is stored as "123" (HANDOFF Tier 388).
MID=$(sql "SELECT id FROM \"Mahnung\" WHERE \"invoiceId\" = '$OPEN' LIMIT 1;")
f=$(json cxl-long '{"reason":"%s"}' "$(printf 'R%.0s' $(seq 1 1001))"); req POST "/api/v1/reminders/mahnungen/$MID/cancel?$Q" "$f"
assert_status 400 "cancel reason 1001 chars (20 000 were stored)"
f=$(json cxl '{"reason":"%s storniert"}' "$TAG"); req POST "/api/v1/reminders/mahnungen/$MID/cancel?$Q" "$f"
assert_status 201 "cancel (mahnungen page shape)"

note "=== 6. Mahnungspausen ==="
UNTIL=$(python3 -c "import datetime;print((datetime.datetime.utcnow()+datetime.timedelta(days=20)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")
f=$(json p-ok '{"customerId":"%s","reason":"%s Ratenplan","pausedUntil":"%s"}' "$CUST" "$TAG" "$UNTIL"); req POST "/api/v1/mahnungspausen?$Q" "$f"
assert_status 201 "pause (customer page shape, toISOString)"
PID=$(json_field "$BODY" id)
PAUSES() { sql "SELECT count(*) FROM \"Mahnungspause\" WHERE \"customerId\" = '$CUST';"; }
BEFORE=$(PAUSES)
f=$(json p-abc '{"customerId":"%s","reason":"r","pausedUntil":"abc"}' "$CUST"); req POST "/api/v1/mahnungspausen?$Q" "$f"
assert_status 400 "pausedUntil abc (was 500)"
f=$(json p-feb '{"customerId":"%s","reason":"r","pausedUntil":"2031-02-30"}' "$CUST"); req POST "/api/v1/mahnungspausen?$Q" "$f"
assert_status 400 "pausedUntil 2031-02-30 (was stored)"
f=$(json p-long '{"customerId":"%s","reason":"%s"}' "$CUST" "$(printf 'R%.0s' $(seq 1 1001))"); req POST "/api/v1/mahnungspausen?$Q" "$f"
assert_status 400 "reason 1001 chars (20 000 were stored)"
f=$(json p-num '{"customerId":123,"reason":"r"}'); req POST "/api/v1/mahnungspausen?$Q" "$f"
assert_status 400 "customerId 123 (was 500)"
assert_eq "…no pause from the invalid requests" "$(PAUSES)" "$BEFORE"
f=$(json pp-abc '{"pausedUntil":"abc"}'); req PATCH "/api/v1/mahnungspausen/$PID?$Q" "$f"
assert_status 400 "PATCH pausedUntil abc (was 500)"
f=$(json pp-null '{"pausedUntil":null}'); req PATCH "/api/v1/mahnungspausen/$PID?$Q" "$f"
assert_status 200 "PATCH pausedUntil null (open-ended)"

rm -rf "$TMPD"
summary
exit $?
