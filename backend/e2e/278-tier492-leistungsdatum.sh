#!/bin/bash
# Tier 492 — the Leistungsdatum on the invoice PDF (§ 14 Abs. 4 Nr. 6 UStG)
#
# The date of supply is a mandatory invoice field, also when it equals the
# issue date. Measured before: an invoice without a recorded deliveryDate
# (created through the API, a recurring invoice) had none on its PDF, and a
# recorded one was labelled "Liefertermin" (an appointment). XRechnung /
# ZUGFeRD already stated the issue date as BT-72.
#
# Now: "Leistungsdatum:" with the recorded date, or the issue date; a
# Proforma (no supply yet) shows a recorded date only.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-278-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier492-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
pdf_text() { python3 - "$1" <<'PY'
import sys, re, zlib
raw = open(sys.argv[1], 'rb').read()
out = []
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', raw, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: continue
    for tj in re.finditer(rb'\[(.*?)\]\s*TJ', data, re.S):
        out.append(''.join(bytes.fromhex(h.decode()).decode('latin-1') for h in re.findall(rb'<([0-9a-fA-F]+)>', tj.group(1))))
print('\n'.join(out))
PY
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
doc() { # type issueDate [deliveryDate] → text of its PDF
  local extra=""; [[ -n "${3:-}" ]] && extra=",\"deliveryDate\":\"$3\""
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"$1\",\"issueDate\":\"$2\"$extra,\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  curl -sS -o /tmp/t492.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$id/pdf?companyId=$C&sign=false"
  pdf_text /tmp/t492.pdf
}

note "=== an invoice without a recorded date states the issue date ==="
TXT=$(doc INV 2026-03-05)
assert_eq "the PDF has a Leistungsdatum row" "$(echo "$TXT" | grep -c "^Leistungsdatum:$")" "1"
assert_eq "its value is the issue date (twice: Ausstellungs- and Leistungsdatum)" "$(echo "$TXT" | grep -c "^05.03.2026$")" "2"

note "=== a recorded date is stated as Leistungsdatum, not Liefertermin ==="
TXT=$(doc INV 2026-03-05 2026-02-27)
assert_eq "Leistungsdatum row" "$(echo "$TXT" | grep -c "^Leistungsdatum:$")" "1"
assert_eq "with the recorded date" "$(echo "$TXT" | grep -c "^27.02.2026$")" "1"
assert_eq "no 'Liefertermin' label" "$(echo "$TXT" | grep -c "Liefertermin")" "0"

note "=== a Proforma shows a recorded date only ==="
TXT=$(doc PI 2026-03-05)
assert_eq "no Leistungsdatum on a Proforma without one" "$(echo "$TXT" | grep -c "^Leistungsdatum:$")" "0"

summary
