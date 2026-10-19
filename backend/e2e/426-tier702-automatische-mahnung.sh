#!/bin/bash
# Tier 702 — the automatic Mahnung is the Mahnung the company would send by hand
#
# The daily run (and „Jetzt ausführen“, POST /reminders/auto-run) wrote its
# letter with code of its own. Measured with the test mailbox, on a 1 190 €
# invoice overdue since 15.08.2026 with 500 € paid:
#   - the letter demanded 1 190 € — the manual one 690 € (Tier 421);
#   - no Verzugszinsen — the manual one charges them (§ 288 BGB);
#   - its fee came from Einstellungen → Mahnwesen (Company.settings.dunning),
#     the manual one's from Mahnungen → Einstellungen (bankInfo.mahnungConfig):
#     with 7,50 € set on one page and 5 € on the other, the same company
#     charged both;
#   - no Mahnung row: the dunning list, the fees booked, and the rule that no
#     lower level follows a higher one never saw the letter.
# Now the run hands each invoice to the pipeline of the manual and the bulk
# send, and the settings card's fees are the Mahnungen page's.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-426-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
WORK=$(mktemp -d); BOX="$WORK/box"
# (all three streams away from the spec's own: a mailbox that outlived the spec
# would otherwise hold the suite runner's pipe open)
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier702-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
q "update \"Company\" set \"bankInfo\"='{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"bankName\":\"Bank\"}'::jsonb where id='$C'" >/dev/null
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"buchhaltung@kunde.example.test\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-08-01\",\"dueDate\":\"2026-08-15\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
INV=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$INV/payments?companyId=$C" '{"amount":500,"paymentDate":"2026-08-20","paymentMethod":"bank_transfer"}'
assert_eq "fixture: 1 190 € overdue since 15.08., 500 € paid" "$STATUS/$(q "select status from \"Invoice\" where id='$INV'")" "201/sent"

note "=== 1. one fee setting ==="
AS PUT "/api/v1/reminders/dunning-config?companyId=$C" '{"level1Days":1,"level2Days":7,"level3Days":14,"level1Fee":2.5,"level2Fee":7.5,"level3Fee":15}'
assert_eq "Einstellungen → Mahnwesen saved" "$STATUS" "200"
AS GET "/api/v1/reminders/mahnungen/fees-config?companyId=$C"
assert_eq "…the Mahnungen page shows the same fees (was 0 / 5 / 10)" "$(P "d['mahngebuehr']['first'], d['mahngebuehr']['second'], d['mahngebuehr']['final']")" "(2.5, 7.5, 15)"
AS PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"verzugszinsPct":9,"mahngebuehr":{"first":3,"second":7.5,"final":15}}'
AS GET "/api/v1/reminders/dunning-config?companyId=$C"
assert_eq "…and a change there shows on the settings card (was 2.5)" "$(P "d['level1Fee'], d['level1Days']")" "(3, 1)"

note "=== 2. the automatic run ==="
AS POST "/api/v1/reminders/auto-run?companyId=$C" '{}'
assert_eq "auto-run: one letter" "$STATUS/$(P "d.get('sent')")" "201/1"
assert_eq "…in the mailbox, to the customer" "$(ls "$BOX" 2>/dev/null | wc -l | tr -d ' ')/$(grep -l 'buchhaltung@kunde.example.test' "$BOX"/* 2>/dev/null | wc -l | tr -d ' ')" "1/1"
ROW=$(q "select level||'|'||mahngebuehr||'|'||(verzugszins > 0)||'|'||(\"totalDue\" - mahngebuehr - verzugszins) from \"Mahnung\" where \"invoiceId\"='$INV'")
assert_eq "a Mahnung row (was none): level first, fee 3 € (was 0 — the other setting), interest charged, on the open 690 €" "$ROW" "first|3.0000|true|690.0000"
python3 - "$BOX" "$WORK/mahnung.pdf" <<'PY'
import email, os, sys
box, out = sys.argv[1], sys.argv[2]
m = email.message_from_bytes(open(os.path.join(box, sorted(os.listdir(box))[-1]), 'rb').read())
for part in m.walk():
    if part.get_content_type() == 'application/pdf':
        open(out, 'wb').write(part.get_payload(decode=True)); break
PY
T=$(pdf_text "$WORK/mahnung.pdf")
assert_eq "the letter: the payments deducted, 690 € open (was: 1 190 € demanded)" \
  "$(grep -c 'abzüglich Zahlungen und Gutschriften' <<<"$T")/$(grep -c '690,00' <<<"$T")" "1/1"
assert_eq "…and its Verzugszinsen, as the Mahnung row books them (were missing from the letter sent)" "$(grep -c 'Verzugszinsen (' <<<"$T")" "1"

note "=== 3. the run keeps the rules of the manual send ==="
AS POST "/api/v1/reminders/auto-run?companyId=$C" '{}'
assert_eq "a second run the same day: nothing more (was: the Mahnung, level 2, at once)" "$(P "d.get('sent')")/$(q "select count(*) from \"Mahnung\" where \"invoiceId\"='$INV'")/$(ls "$BOX" | wc -l | tr -d ' ')" "0/1/1"

# (the letter's deadline passed: moved back, as if days had gone by)
q "update \"Mahnung\" set \"neueFrist\" = now() - interval '2 days' where \"invoiceId\"='$INV'" >/dev/null
AS POST "/api/v1/reminders/auto-run?companyId=$C" '{}'
assert_eq "its deadline passed: the next level goes out" "$(P "d.get('sent')")/$(q "select string_agg(level, ',' order by \"sentAt\") from \"Mahnung\" where \"invoiceId\"='$INV'")" "1/first,second"

summary
