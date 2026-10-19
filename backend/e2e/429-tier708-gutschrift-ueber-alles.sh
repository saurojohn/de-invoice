#!/bin/bash
# Tier 708 — a credit note over the whole amount takes the invoice's lines
#
# The invoice page's „Gutschrift“ dialog fills in the open amount; its hint
# says an empty field credits everything with the invoice's lines 1:1.
# Measured: the dialog sent as it opened (the whole 535,50 €) gave a credit
# note with ONE line (the reason as its text, „Erstattung“ without one) — the lines, units and quantities of the
# invoice gone from the document that corrects it. Now an amount equal to the
# invoice's total, with nothing credited before, is the full credit note.
# A smaller amount stays one line per rate, as before.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-429-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier708-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
issued() { # → INV: 450 € Montage (1 Pausch) + 3 Std à 30 € = 540 € net, 642,60 € gross
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Montage Regalsystem\",\"quantity\":1,\"unit\":\"Pausch\",\"unitPrice\":450,\"vatRate\":0.19},{\"description\":\"Anfahrt\",\"quantity\":3,\"unit\":\"Std\",\"unitPrice\":30,\"vatRate\":0.19}]}"
  INV=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
}
lines() { q "select string_agg(description||'|'||trim(trailing '.' from trim(trailing '0' from quantity::text))||'|'||unit, ', ' order by \"sortOrder\") from \"InvoiceItem\" where \"invoiceId\"='$1'"; }

note "=== 1. the dialog as it opens: the whole amount ==="
issued; A=$INV
AS POST "/api/v1/invoices/$A/credit-note?companyId=$C" '{"amount":642.6,"reason":"Auftrag storniert"}'
CN=$(json_field "$BODY" id)
assert_eq "201, the invoice's lines (was: one line, the reason as its text)" "$STATUS/$(lines "$CN")" "201/Montage Regalsystem|1|Pausch, Anfahrt|3|Std"
assert_eq "…over the whole amount" "$(q "select total from \"Invoice\" where id='$CN'")" "-642.6000"

note "=== 2. a part of it: one line per rate, as before ==="
issued; B=$INV
AS POST "/api/v1/invoices/$B/credit-note?companyId=$C" '{"amount":119,"reason":"Preisnachlass"}'
assert_eq "119 €: one line" "$STATUS/$(lines "$(json_field "$BODY" id)")" "201/Preisnachlass|1|Stück"

note "=== 3. the rest after a part: what is left, as before ==="
AS POST "/api/v1/invoices/$B/credit-note?companyId=$C" '{"amount":523.6}'
assert_eq "523,60 € after 119 €: one line (the lines were credited in part already)" "$STATUS/$(lines "$(json_field "$BODY" id)")" "201/Erstattung|1|Stück"

summary
