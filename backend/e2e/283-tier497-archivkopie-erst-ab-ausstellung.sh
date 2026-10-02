#!/bin/bash
# Tier 497 — the stored PDF (the archive copy) is the issued invoice
#
# The first download of an invoice's PDF is stored (`pdfPath`) and is what
# the GoBD archive, the GoBD export and the DATEV bundle hand over "as
# issued" (Tier 420). Measured before: downloading a draft stored the draft —
# the invoice was then edited and issued, and the archive still held the old
# draft, with the old amount and (since Tier 496) the ENTWURF watermark. A
# same-day edit of an issued invoice (Tier 477) left the stale copy as well.
#
# Now a draft's PDF is never stored, and an edit drops the stored copy (the
# next download stores the current one).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-283-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier497-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
PDFTXT() { python3 - "$1" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read(); out = []
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', d, re.DOTALL):
    try: dec = zlib.decompress(m.group(1))
    except Exception: continue
    for tj in re.finditer(rb'\[(.*?)\]\s*TJ', dec, re.S):
        out.append(''.join(bytes.fromhex(h.decode()).decode('latin-1') for h in re.findall(rb'<([0-9a-fA-F]+)>', tj.group(1))))
print('\n'.join(out))
PY
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
TODAY=$(date +%Y-%m-%d)
item() { echo "[{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":$2,\"vatRate\":0.19}]"; }
pdf() { curl -sS -o "$2" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$1/pdf?companyId=$C&sign=false"; }

note "=== a draft's PDF is not stored ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":$(item Altposition 100)}"
I=$(json_field "$BODY" id)
pdf "$I" "$WORK/draft.pdf"
assert_eq "downloading the draft stores nothing (was stored)" "$(q "select coalesce(\"pdfPath\",'none') from \"Invoice\" where id='$I'")" "none"

note "=== edited, issued: the archive holds the issued invoice ==="
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"items\":$(item Neuposition 200)}"
assert_eq "the draft is edited" "$STATUS" "200"
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
pdf "$I" "$WORK/issued.pdf"
assert_eq "the issued download is stored" "$(q "select (\"pdfPath\" is not null)::text from \"Invoice\" where id='$I'")" "true"
NO=$(q "select \"invoiceNumber\" from \"Invoice\" where id='$I'")
curl -sS -o "$WORK/a.zip" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/gobd-archive?companyId=$C&year=${TODAY:0:4}"
(cd "$WORK" && unzip -o -q a.zip)
TXT=$(PDFTXT "$WORK/Invoices/$NO.pdf")
assert_eq "archived: the issued line (was the draft's)" "$(echo "$TXT" | grep -c "Neuposition")/$(echo "$TXT" | grep -c "Altposition")" "1/0"
assert_eq "…without ENTWURF" "$(echo "$TXT" | grep -c "ENTWURF")" "0"

note "=== a same-day edit of the issued invoice drops the stale copy ==="
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"items\":$(item Korrigiert 250)}"
assert_eq "edited (same day, no payment — Tier 477)" "$STATUS" "200"
assert_eq "the stored copy is dropped (was kept)" "$(q "select coalesce(\"pdfPath\",'none') from \"Invoice\" where id='$I'")" "none"
pdf "$I" "$WORK/again.pdf"
rm -rf "$WORK/Invoices"; curl -sS -o "$WORK/b.zip" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/gobd-archive?companyId=$C&year=${TODAY:0:4}"
(cd "$WORK" && unzip -o -q b.zip)
assert_eq "the archive has the corrected invoice" "$(PDFTXT "$WORK/Invoices/$NO.pdf" | grep -c "Korrigiert")" "1"

rm -rf "$WORK"
summary
