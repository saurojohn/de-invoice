#!/bin/bash
# Tier 421 — Verzugszinsen at the statutory rate, on what is still open
#
# § 288 BGB: Basiszinssatz + 9 percentage points between businesses (Abs. 2),
# + 5 points when the debtor is a consumer (Abs. 1). Measured before, on a
# 1 190 € invoice 100 days overdue with 500 € already paid:
#   business and consumer alike: a flat 9 % a year, on 1 190 €
#   → Verzugszins 29,34, totalDue 1 224,34 (the paid 500 demanded again)
#   letter: "9.00 % über Basiszinssatz" — while a flat 9 % was charged
# From 1 July 2026 (Basiszinssatz 1,52 %) the rate is 10,52 % for a business
# and 6,52 % for a consumer; 9 % overcharged consumers.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-210-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier421-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"email":"info@t421.example","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"}}'
DUE=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=100)).isoformat())")
ISS=$(python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=130)).isoformat())")
overdue() { # customer-type → invoice id (1 190 €, 500 paid)
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"$1\",\"contact\":{\"email\":\"$1-$TAG@example.test\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
  local k; k=$(json_field "$BODY" id)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$k\",\"issueDate\":\"$ISS\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/invoices/$id/payments?companyId=$C" "{\"amount\":500,\"paymentDate\":\"$ISS\",\"paymentMethod\":\"bank_transfer\"}"
  echo "$id"
}
# The expected interest, from the Bundesbank table (same values as basiszinssatz.ts).
expected() { # surcharge → interest on 690 for every day after the due date, today included
  python3 - "$DUE" "$1" <<'PY'
import datetime, sys
table = [('2016-07-01', -0.88), ('2023-01-01', 1.62), ('2023-07-01', 3.12), ('2024-01-01', 3.62),
         ('2024-07-01', 3.37), ('2025-01-01', 2.27), ('2025-07-01', 1.27), ('2026-01-01', 1.27), ('2026-07-01', 1.52)]
def basis(d):
    r = table[0][1]
    for f, v in table:
        if f <= d.isoformat(): r = v
    return r
due = datetime.date.fromisoformat(sys.argv[1]); s = float(sys.argv[2])
d = due + datetime.timedelta(days=1); total = 0.0
while d <= datetime.date.today():
    total += basis(d) + s; d += datetime.timedelta(days=1)
print(f"{round(690 * total / 365) / 100:.2f}|{basis(datetime.date.today()) + s:.2f}")
PY
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }

note "=== 1. a business: Basiszinssatz + 9, on the open 690 ==="
B=$(overdue business)
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$B&level=second"
IFS='|' read -r EXP_B RATE_B <<<"$(expected 9)"
assert_eq "openBalance 690 (was 1190 — the 500 payment ignored)" "$(P "d['openBalance']")" "690"
assert_eq "rate = Basiszinssatz + 9" "$(P "'%.2f' % d['verzugszinsPct']")" "$RATE_B"
assert_eq "Verzugszins $EXP_B (was 29,34 at a flat 9 % on 1190)" "$(P "'%.2f' % d['verzugszins']")" "$EXP_B"
assert_eq "totalDue = 690 + 5 + interest" "$(P "'%.2f' % d['totalDue']")" "$(python3 -c "print(f'{690+5+$EXP_B:.2f}')")"

note "=== 2. a consumer: Basiszinssatz + 5 ==="
I=$(overdue individual)
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I&level=second"
IFS='|' read -r EXP_I RATE_I <<<"$(expected 5)"
assert_eq "rate = Basiszinssatz + 5 (§ 288 Abs. 1; was a flat 9)" "$(P "'%.2f' % d['verzugszinsPct']")" "$RATE_I"
assert_eq "Verzugszins $EXP_I" "$(P "'%.2f' % d['verzugszins']")" "$EXP_I"
AS PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"verzugszinsPct":12}'
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I&level=second"
assert_eq "a configured 12 points is capped at 5 for a consumer" "$(P "'%.2f' % d['verzugszinsPct']")" "$RATE_I"
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$B&level=second"
assert_eq "…and applies to a business (Basiszinssatz + 12)" "$(P "'%.2f' % d['verzugszinsPct']")" "$(python3 -c "print(f'{$RATE_B + 3:.2f}')")"
AS PUT "/api/v1/reminders/mahnungen/fees-config?companyId=$C" '{"verzugszinsPct":9}'

note "=== 3. the letter ==="
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$I\",\"level\":\"final\"}"
[[ "$STATUS" == 201 || "$STATUS" == 200 ]] && pass "Mahnung sent" || fail "send: $STATUS $BODY"
MID=$(json_field "$BODY" mahnungId)
PDF_STATUS=$(curl -sS -o /tmp/t421-m.pdf -w "%{http_code} %{content_type} %{size_download}" \
  -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reminders/mahnungen/$MID/pdf?companyId=$C")
# Tier 449: pypdf, not a regex over the raw streams. In CI runs 36109905697
# and 36131518196 the text came back empty and all four letter checks failed
# together (never in local runs). One way the regex does that, shown with a
# synthetic stream: it cut each FlateDecode stream at `\r?\n endstream`, so a
# stream whose last compressed byte is 0x0D lost that byte and zlib refused it
# (the error was swallowed). Whether that was CI's cause is not proven — if
# the text is empty again, the note below prints the HTTP status and the
# file's head. Whitespace is collapsed: pypdf breaks lines.
TXT=$(python3 - /tmp/t421-m.pdf <<'PY'
import re, sys, pypdf
try:
    r = pypdf.PdfReader(sys.argv[1])
    print(re.sub(r'\s+', ' ', ' '.join(p.extract_text() or '' for p in r.pages)))
except Exception as e:
    print(f'PDF-ERROR {e}')
PY
)
[[ -n "$TXT" && "$TXT" != PDF-ERROR* ]] || note "letter PDF: HTTP $PDF_STATUS, mahnungId '$MID', extract: ${TXT:0:120}, head: $(head -c 120 /tmp/t421-m.pdf | tr -c '[:print:]' '.')"
grep -q "Offener Betrag: 690,00" <<<"$TXT" && pass "letter: Offener Betrag 690,00 (was 1.190,00)" || fail "letter open amount"
grep -q "abzüglich Zahlungen und Gutschriften: 500,00" <<<"$TXT" && pass "letter: states the payment deducted" || fail "letter payment line"
grep -q "5,00 Prozentpunkte, § 288 Abs. 1 BGB" <<<"$TXT" && pass "letter: Basiszinssatz + 5 points, § 288 Abs. 1" || fail "letter interest basis"
grep -q "5 Prozentpunkten über dem Basiszinssatz (§ 288 Abs. 1 BGB)" <<<"$TXT" && pass "letter: the consumer's legal note (was '9 Prozentpunkten … Abs. 2')" || fail "letter legal note"

summary; exit $?
