#!/bin/bash
# Tier 707 — a recurring invoice made as a draft is not sent
#
# A template's invoices are drafts by default („Rechnungs-Status: Entwurf“ —
# to be looked at before they go out), and „Rechnung nach Generierung an
# Kunden senden“ was on by default. Measured with the test mailbox: a
# template with the defaults, „Jetzt generieren“ — the invoice was issued
# („sent“: sending a draft issues it, Tier 495) and in the customer's
# mailbox. The draft setting did nothing.
# Now a generated draft is not e-mailed (scheduled or by hand); a new
# template's sendEmail is on only when its invoices are issued directly; the
# form couples the two (ticking „senden“ makes them „Versendet“).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-428-$(date +%s%N | cut -c1-13)"
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
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier707-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
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
template() { # extra-json → T
  AS POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"Wartung\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"$(TZ=Europe/Berlin date +%F)\"$1,\"items\":[{\"description\":\"Wartung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  T=$(json_field "$BODY" id)
}
run() { AS POST "/api/v1/recurring-invoices/$1/run?companyId=$C" '{}'; INV=$(json_field "$BODY" invoiceId); python3 -c "import time; time.sleep(3)"; }
mails() { ls "$BOX" 2>/dev/null | wc -l | tr -d ' '; }
status_of() { q "select status from \"Invoice\" where id='$1'"; }

note "=== 1. the defaults ==="
template ''
assert_eq "a new template: drafts, sendEmail off (was: on)" "$STATUS/$(P "d['invoiceStatus'], d['sendEmail']")" "201/('draft', False)"

note "=== 2. a draft template that says send ==="
template ',"invoiceStatus":"draft","sendEmail":true'; DRAFT=$T
run "$DRAFT"
assert_eq "generated: still a draft, nothing in the mailbox (was: issued and sent)" "$STATUS/$(status_of "$INV")/$(mails)" "201/draft/0"
# (the 06:00 run e-mails through the same check, RecurringService.isDraft)

note "=== 3. a template that issues and sends ==="
template ',"invoiceStatus":"sent","sendEmail":true'
run "$T"
assert_eq "generated: issued and e-mailed, as before" "$STATUS/$(status_of "$INV")/$(mails)" "201/sent/1"
template ',"invoiceStatus":"sent"'
assert_eq "…a template that issues: sendEmail on by default" "$(P "d['sendEmail']")" "True"

PAGE="$SCRIPT_DIR/../../frontend/src/app/dashboard/recurring-invoices/page.tsx"
assert_eq "the form: off by default, ticking it makes Versendet, Entwurf unticks it" \
  "$(grep -c 'useState(false)' <<<"$(grep -n 'setSendEmail\] = useState' "$PAGE")")/$(grep -c 'if (e.target.checked) setInvoiceStatus("sent")' "$PAGE")/$(grep -c 'if (next === "draft") setSendEmail(false)' "$PAGE")" "1/1/1"

summary
