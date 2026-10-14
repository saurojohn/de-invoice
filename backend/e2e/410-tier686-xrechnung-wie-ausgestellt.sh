#!/bin/bash
# Tier 686 — the XRechnung of an issued invoice is kept and handed out as kept
#
# After Tier 685 an issued invoice's PDF was its kept copy; its XRechnung
# (UBL, GET /invoices/:id/xrechnung and /pdf?format=xrechnung) was built again
# from today's master data. Measured: issued at "Altstraße 1"; the company
# moved; the XRechnung named "Neustraße 9" and the new IBAN.
#
# Now it is kept next to the kept PDF (same name, .xrechnung.xml), made in the
# same moment; a draft's is built as it is.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-410-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
KOSIT_ROOT="$(cd "$SCRIPT_DIR/../../infra/kosit" && pwd)"
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier686-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
# which FILE → the seller's street and IBAN in the XML: old / new / neither
which() {
  python3 - "$1" <<'PY'
import sys
x = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
def w(o, n): return 'both' if o in x and n in x else 'old' if o in x else 'new' if n in x else 'neither'
print(w('Altstraße 1', 'Neustraße 9'), w('DE89370400440532013000', 'DE02120300000000202051'))
PY
}

AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t686.example","phone":"+49 30 1","address":{"street":"Altstraße 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Alte Bank"}}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde AG","type":"business","vatId":"DE987654321","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"},"contact":{"email":"k@example.test"}}'
K=$(P "d['id']")
mk() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"; ID=$(P "d['id']"); }
mk "Beratung"; INV=$ID
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: issued at the old address" "$STATUS" "200"
assert_eq "the XRechnung as issued: the old address and IBAN" "$(fetch "/api/v1/invoices/$INV/xrechnung?companyId=$C" "$WORK/first.xml") $(which "$WORK/first.xml")" "200 old old"
mk "Entwurf"; DRAFT=$ID
mk "vor Tier 686 ausgestellt"; LEGACY=$ID
AS PUT "/api/v1/invoices/$LEGACY/status?companyId=$C" '{"status":"sent"}'

note "=== the company moves and changes its bank ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"address":{"street":"Neustraße 9","city":"Hamburg","postalCode":"20095","country":"DE"},"bankInfo":{"iban":"DE02120300000000202051","bic":"BYLADEM1001","bankName":"Neue Bank"}}'

assert_eq "GET …/xrechnung: as issued (was: the new address and IBAN)" "$(fetch "/api/v1/invoices/$INV/xrechnung?companyId=$C" "$WORK/x.xml") $(which "$WORK/x.xml")" "200 old old"
assert_eq "…byte for byte the first one" "$(cmp -s "$WORK/x.xml" "$WORK/first.xml" && echo same || echo differ)" "same"
assert_eq "GET …/pdf?format=xrechnung: the same (was: new)" "$(fetch "/api/v1/invoices/$INV/pdf?companyId=$C&format=xrechnung" "$WORK/y.xml") $(cmp -s "$WORK/y.xml" "$WORK/first.xml" && echo same || echo differ)" "200 same"
assert_eq "the PDF as issued too (Tier 685)" "$(fetch "/api/v1/invoices/$INV/pdf?companyId=$C&sign=false" "$WORK/x.pdf") $(python3 -c "
import re, sys, zlib
d = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.DOTALL):
    try: dec = zlib.decompressobj().decompress(m.group(1))
    except Exception: continue
    if b'CrossIndustryInvoice' in dec: print('Altstra' in dec.decode('utf-8', 'ignore'))
" "$WORK/x.pdf")" "200 True"
assert_eq "a draft's XRechnung is built as it is: the new address" "$(fetch "/api/v1/invoices/$DRAFT/xrechnung?companyId=$C" "$WORK/d.xml") $(which "$WORK/d.xml")" "200 new new"
if [[ -n "$JAVA_BIN" && -x "$JAVA_BIN" ]]; then
  OUT="$WORK/kosit"; mkdir -p "$OUT"
  if (cd "$OUT" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" -s "$KOSIT_ROOT/scenarios.xml" -o "$OUT" "$WORK/x.xml" >/dev/null 2>&1); then
    pass "the kept XRechnung passes KoSIT"
  else
    fail "the kept XRechnung is rejected by KoSIT: $(grep -oh 'failed-assert[^>]*id="[^"]*"' "$OUT"/*.xml 2>/dev/null | head -5 | tr '\n' ' ')"
  fi
else
  fail "no Java for KoSIT"
fi

note "=== a copy kept before this tier: its XRechnung is made once, then kept ==="
FILE=$(q "select \"pdfPath\" from \"Invoice\" where id='$LEGACY'")
STORE="${STORAGE_PATH:-}"
assert_eq "fixture: the legacy invoice has its kept PDF" "$([[ -n "$FILE" ]] && echo yes)" "yes"
# its kept XRechnung lies next to the PDF (the backend's STORAGE_PATH, which
# CI and the local harness both set) — taken away, as if kept before Tier 686
assert_eq "the XRechnung was kept next to the PDF when the invoice was issued" "$([[ -n "$STORE" && -f "$STORE/${FILE%.pdf}.xrechnung.xml" ]] && echo kept || echo none)" "kept"
[[ -n "$STORE" ]] && rm -f "$STORE/${FILE%.pdf}.xrechnung.xml"
fetch "/api/v1/invoices/$LEGACY/xrechnung?companyId=$C" "$WORK/l1.xml" >/dev/null
AS PUT "/api/v1/companies/$C?companyId=$C" '{"address":{"street":"Drittstraße 3","city":"Köln","postalCode":"50667","country":"DE"}}'
assert_eq "asked again after another move: the same file (kept the first time)" \
  "$(fetch "/api/v1/invoices/$LEGACY/xrechnung?companyId=$C" "$WORK/l2.xml") $(cmp -s "$WORK/l1.xml" "$WORK/l2.xml" && echo same || echo differ) $(grep -c 'Drittstraße' "$WORK/l2.xml")" "200 same 0"

summary
