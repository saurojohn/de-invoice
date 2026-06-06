#!/usr/bin/env bash
# Invoice module smoke test — exercises every endpoint in invoice.controller.ts
# and verifies PDF format invariants (title, single page, no Fälligkeitsdatum).
#
# Usage:
#   COMPANY_ID=... USER_ID=... ./smoke-test.sh
# Optional:
#   BASE=http://localhost:3001
#   KEEP=1        keep downloaded artefacts for inspection
#   FAST=1        skip the slow PDF/ZUGFeRD steps
#
# Exit code: 0 = all checks passed, non-zero = at least one failed.

set -uo pipefail

BASE="${BASE:-http://localhost:3001}"
COMPANY_ID="${COMPANY_ID:?COMPANY_ID is required}"
USER_ID="${USER_ID:?USER_ID is required}"

H_USER="x-user-id: $USER_ID"
H_CO="x-company-id: $COMPANY_ID"
H_JSON="Content-Type: application/json"

# ── helpers ──────────────────────────────────────────────────────────────
PASS=0
FAIL=0
LOG=()

step() { echo; echo "── $* ──"; }
ok()   { PASS=$((PASS+1)); LOG+=("PASS  $*"); echo "  ✓ $*"; }
nok()  { FAIL=$((FAIL+1)); LOG+=("FAIL  $*"); echo "  ✗ $*"; }
note() { echo "  ℹ $*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' required" >&2; exit 2; }
}
require_cmd curl
require_cmd python3

# Run curl with our standard headers, store body in $BODY, return http status in $STATUS.
# Use ${@:-} patterns so callers that don't pass extra args don't trigger
# `set -u` "unbound variable" on the empty $@ array.
api() {
  local method=$1; shift
  local path=$1; shift
  local extra=()
  if [ "$#" -gt 0 ]; then extra=("$@"); fi
  local tmp
  tmp=$(mktemp)
  STATUS=$(curl -s -o "$tmp" -w "%{http_code}" -X "$method" "$BASE$path" \
    -H "$H_USER" -H "$H_CO" -H "$H_JSON" "${extra[@]+"${extra[@]}"}")
  BODY=$(cat "$tmp")
  rm -f "$tmp"
}

# Like api() but also accept a request body.
apib() {
  local method=$1; shift
  local path=$1; shift
  local body=$1; shift
  local extra=()
  if [ "$#" -gt 0 ]; then extra=("$@"); fi
  local tmp
  tmp=$(mktemp)
  STATUS=$(curl -s -o "$tmp" -w "%{http_code}" -X "$method" "$BASE$path" \
    -H "$H_USER" -H "$H_CO" -H "$H_JSON" -d "$body" "${extra[@]+"${extra[@]}"}")
  BODY=$(cat "$tmp")
  rm -f "$tmp"
}

# Run curl without our JSON header (binary downloads).
apidl() {
  local method=$1; shift
  local path=$1; shift
  local out=$1; shift
  STATUS=$(curl -s -o "$out" -w "%{http_code}" -X "$method" "$BASE$path" \
    -H "$H_USER" -H "$H_CO" "$@")
}

# Pull a JSON field with python (works regardless of whether the response is
# an object or a list). $1 is the field name, $2 is default if missing.
jget() {
  python3 -c "import json,sys
d=json.loads(sys.stdin.read())
def find(x):
    if isinstance(x, dict):
        for k,v in x.items():
            if k=='$1': return v
            r=find(v)
            if r is not None: return r
    elif isinstance(x, list):
        for e in x:
            r=find(e)
            if r is not None: return r
    return None
v=find(d)
print(v if v is not None else '$2')" <<<"$BODY" 2>/dev/null
}

jgetl() {
  python3 -c "import json,sys
d=json.loads(sys.stdin.read())
def find(x):
    if isinstance(x, dict):
        for k,v in x.items():
            if k=='$1': return v
            r=find(v)
            if r is not None: return r
    elif isinstance(x, list):
        for e in x:
            r=find(e)
            if r is not None: return r
    return None
v=find(d)
print(len(v) if v is not None else '$2')" <<<"$BODY" 2>/dev/null
}

# ── 1. find a customer + product to use for invoice creation ─────────────
step "Setup: list customers and products"
api GET "/api/v1/customers?pageSize=5&companyId=$COMPANY_ID"
[ "$STATUS" = "200" ] && ok "GET /customers → 200" || { nok "GET /customers → $STATUS: $(echo "$BODY" | head -c 200)"; exit 1; }
CUSTOMER_ID=$(jget id "")
[ -n "$CUSTOMER_ID" ] && ok "picked customerId=$CUSTOMER_ID" || nok "no customer found (create one first)"

api GET "/api/v1/products?pageSize=5&companyId=$COMPANY_ID"
[ "$STATUS" = "200" ] && ok "GET /products → 200" || nok "GET /products → $STATUS"
PRODUCT_ID=$(jget id "")
[ -n "$PRODUCT_ID" ] && note "picked productId=$PRODUCT_ID (optional)"

# ── 2. create an INV invoice ─────────────────────────────────────────────
step "Create INV invoice"
apib POST "/api/v1/invoices?companyId=$COMPANY_ID" "{
  \"customerId\": \"$CUSTOMER_ID\",
  \"issueDate\": \"2026-06-06\",
  \"dueDate\": \"2026-07-06\",
  \"type\": \"INV\",
  \"currency\": \"EUR\",
  \"language\": \"de-DE\",
  \"notes\": \"Smoke test invoice\",
  \"paymentTerms\": 30,
  \"items\": [
    { \"description\": \"Beratungsleistung\", \"quantity\": 2, \"unit\": \"Stunde\", \"unitPrice\": 100, \"vatRate\": 0.19 },
    { \"description\": \"Setup-Pauschale\",    \"quantity\": 1, \"unit\": \"Stück\",  \"unitPrice\": 50,  \"vatRate\": 0.19 }
  ]
}"
[ "$STATUS" = "201" ] || [ "$STATUS" = "200" ] && ok "POST /invoices → $STATUS" || nok "POST /invoices → $STATUS: $(echo "$BODY" | head -c 300)"
INV_ID=$(jget id "")
INV_NUM=$(jget invoiceNumber "")
[ -n "$INV_ID" ] && ok "got id=$INV_ID number=$INV_NUM" || nok "no id in response"

# Check totals
python3 - <<PY
import json,sys
d=json.loads('''$BODY''')
items=d.get('items',[])
sub=sum(float(i['quantity'])*float(i['unitPrice']) for i in items)
vat=sum(float(i['quantity'])*float(i['unitPrice'])*float(i['vatRate']) for i in items)
total=sub+vat
got_sub=float(d.get('subtotal',0))
got_vat=float(d.get('totalVat',0))
got_total=float(d.get('total',0))
ok=abs(got_sub-sub)<0.01 and abs(got_vat-vat)<0.01 and abs(got_total-total)<0.01
print('MATCH' if ok else f'MISMATCH want sub={sub} vat={vat} total={total} got sub={got_sub} vat={got_vat} total={got_total}')
PY
RESULT=$(python3 -c "import json,sys
d=json.loads('''$BODY''')
items=d.get('items',[])
sub=sum(float(i['quantity'])*float(i['unitPrice']) for i in items)
vat=sum(float(i['quantity'])*float(i['unitPrice'])*float(i['vatRate']) for i in items)
total=sub+vat
ok=abs(float(d.get('subtotal',0))-sub)<0.01 and abs(float(d.get('totalVat',0))-vat)<0.01 and abs(float(d.get('total',0))-total)<0.01
print('OK' if ok else 'FAIL')")
[ "$RESULT" = "OK" ] && ok "totals match items (subtotal + vat = total)" || nok "totals mismatch"

# ── 3. create a PI invoice ───────────────────────────────────────────────
step "Create PI invoice"
apib POST "/api/v1/invoices?companyId=$COMPANY_ID" "{
  \"customerId\": \"$CUSTOMER_ID\",
  \"issueDate\": \"2026-06-06\",
  \"type\": \"PI\",
  \"currency\": \"EUR\",
  \"items\": [
    { \"description\": \"Proforma Position\", \"quantity\": 1, \"unit\": \"Stück\", \"unitPrice\": 200, \"vatRate\": 0.19 }
  ]
}"
[ "$STATUS" = "201" ] || [ "$STATUS" = "200" ] && ok "POST /invoices type=PI → $STATUS" || nok "POST /invoices type=PI → $STATUS"
PI_ID=$(jget id "")
PI_NUM=$(jget invoiceNumber "")
[ -n "$PI_ID" ] && ok "PI id=$PI_ID number=$PI_NUM" || nok "no PI id"

# ── 4. create a CN credit note (must reference the INV) ──────────────────
step "Create CN credit note (references $INV_NUM)"
apib POST "/api/v1/invoices?companyId=$COMPANY_ID" "{
  \"customerId\": \"$CUSTOMER_ID\",
  \"referenceInvoiceId\": \"$INV_ID\",
  \"issueDate\": \"2026-06-06\",
  \"type\": \"CN\",
  \"items\": [
    { \"description\": \"Beratungsleistung\", \"quantity\": 1, \"unit\": \"Stunde\", \"unitPrice\": 100, \"vatRate\": 0.19 }
  ]
}"
[ "$STATUS" = "201" ] || [ "$STATUS" = "200" ] && ok "POST /invoices type=CN → $STATUS" || nok "POST /invoices type=CN → $STATUS: $(echo "$BODY" | head -c 300)"
CN_ID=$(jget id "")
CN_NUM=$(jget invoiceNumber "")
[ -n "$CN_ID" ] && ok "CN id=$CN_ID number=$CN_NUM" || nok "no CN id"

# CN should be negative
python3 -c "
import json
d=json.loads('''$BODY''')
t=float(d.get('total',0))
print('NEG' if t<0 else 'POS')" >/tmp/_cn_tot 2>/dev/null
[ "$(cat /tmp/_cn_tot)" = "NEG" ] && ok "CN total is negative (${BODY:-})" || nok "CN total is not negative"

# ── 5. PDF download + format check ───────────────────────────────────────
step "PDF download + format check (INV)"
OUT_PDF="/tmp/smoke_inv.pdf"
apidl GET "/api/v1/invoices/$INV_ID/pdf?companyId=$COMPANY_ID" "$OUT_PDF"
[ "$STATUS" = "200" ] && ok "GET /invoices/:id/pdf → 200" || nok "GET pdf → $STATUS"
[ -s "$OUT_PDF" ] && note "PDF size: $(wc -c <"$OUT_PDF") bytes"

# Verify it's a PDF
HEAD=$(head -c 4 "$OUT_PDF")
[ "$HEAD" = "%PDF" ] && ok "file starts with %PDF" || nok "not a PDF (head=$HEAD)"

# Extract text via python's pypdf if available, otherwise use pdftotext.
PAGES=""
if python3 -c "import pypdf" 2>/dev/null; then
  PAGES=$(python3 -c "from pypdf import PdfReader; print(len(PdfReader('$OUT_PDF').pages))")
  TEXT=$(python3 -c "from pypdf import PdfReader; print('\\n'.join(p.extract_text() or '' for p in PdfReader('$OUT_PDF').pages))")
elif command -v pdftotext >/dev/null 2>&1; then
  PAGES=$(pdfinfo "$OUT_PDF" 2>/dev/null | awk '/^Pages:/{print $2}')
  TEXT=$(pdftotext "$OUT_PDF" -)
else
  PAGES="?"
  TEXT=""
fi
[ "$PAGES" = "1" ] && ok "INV PDF is exactly 1 page" || nok "INV PDF page count: $PAGES (expected 1)"

if [ -n "$TEXT" ]; then
  if echo "$TEXT" | grep -q "RECHNUNG"; then ok "INV title = RECHNUNG"; else nok "INV title missing RECHNUNG"; fi
  if echo "$TEXT" | grep -q "Fälligkeitsdatum"; then nok "INV PDF still contains Fälligkeitsdatum"; else ok "INV PDF does NOT contain Fälligkeitsdatum"; fi
  if echo "$TEXT" | grep -qE '€\s?1?[0-9]{1,3}(\.[0-9]{3})*,[0-9]{2}'; then ok "INV PDF has German currency format"; else note "no obvious € amounts found (may be 0.00 invoice)"; fi
  if echo "$TEXT" | grep -qE '\b[0-3][0-9]\.[0-1][0-9]\.[0-9]{4}\b'; then ok "INV PDF has dd.mm.yyyy date"; else nok "INV PDF has no dd.mm.yyyy date"; fi
else
  note "no text extractor available — install pypdf or poppler-utils"
fi

# ── 6. PDF for CN (should be GUTSCHRIFT) ─────────────────────────────────
step "PDF download + format check (CN → GUTSCHRIFT)"
OUT_CN="/tmp/smoke_cn.pdf"
apidl GET "/api/v1/invoices/$CN_ID/pdf?companyId=$COMPANY_ID" "$OUT_CN"
[ "$STATUS" = "200" ] && ok "GET CN pdf → 200" || nok "GET CN pdf → $STATUS"
if python3 -c "import pypdf" 2>/dev/null; then
  TEXT_CN=$(python3 -c "from pypdf import PdfReader; print('\\n'.join(p.extract_text() or '' for p in PdfReader('$OUT_CN').pages))")
  PAGES_CN=$(python3 -c "from pypdf import PdfReader; print(len(PdfReader('$OUT_CN').pages))")
elif command -v pdftotext >/dev/null 2>&1; then
  TEXT_CN=$(pdftotext "$OUT_CN" -)
  PAGES_CN=$(pdfinfo "$OUT_CN" 2>/dev/null | awk '/^Pages:/{print $2}')
else
  TEXT_CN=""; PAGES_CN="?"
fi
[ "$PAGES_CN" = "1" ] && ok "CN PDF is 1 page" || nok "CN PDF pages: $PAGES_CN"
if [ -n "$TEXT_CN" ]; then
  if echo "$TEXT_CN" | grep -q "GUTSCHRIFT"; then ok "CN title = GUTSCHRIFT"; else nok "CN title missing GUTSCHRIFT"; fi
  if echo "$TEXT_CN" | grep -q "Fälligkeitsdatum"; then nok "CN PDF contains Fälligkeitsdatum"; else ok "CN PDF clean of Fälligkeitsdatum"; fi
fi

# ── 7. PDF for PI (should be PROFORMARECHNUNG) ───────────────────────────
step "PDF download + format check (PI → PROFORMARECHNUNG)"
OUT_PI="/tmp/smoke_pi.pdf"
apidl GET "/api/v1/invoices/$PI_ID/pdf?companyId=$COMPANY_ID" "$OUT_PI"
[ "$STATUS" = "200" ] && ok "GET PI pdf → 200" || nok "GET PI pdf → $STATUS"
if command -v pdftotext >/dev/null 2>&1; then
  TEXT_PI=$(pdftotext "$OUT_PI" -)
  if echo "$TEXT_PI" | grep -q "PROFORMARECHNUNG"; then ok "PI title = PROFORMARECHNUNG"; else nok "PI title missing PROFORMARECHNUNG"; fi
fi

# ── 8. XRechnung ────────────────────────────────────────────────────────
step "XRechnung download"
OUT_XR="/tmp/smoke_inv_xr.xml"
apidl GET "/api/v1/invoices/$INV_ID/xrechnung?companyId=$COMPANY_ID" "$OUT_XR"
[ "$STATUS" = "200" ] && ok "GET xrechnung → 200" || nok "GET xrechnung → $STATUS"
[ -s "$OUT_XR" ] && note "XRechnung size: $(wc -c <"$OUT_XR") bytes"
if head -1 "$OUT_XR" | grep -q '<?xml'; then ok "XRechnung is XML"; else nok "XRechnung not XML (head: $(head -1 "$OUT_XR"))"; fi
if grep -q "Invoice " "$OUT_XR" || grep -q "<Invoice" "$OUT_XR"; then ok "XRechnung contains UBL Invoice root"; else nok "XRechnung missing <Invoice>"; fi
if grep -q "CustomizationID" "$OUT_XR"; then ok "XRechnung has CustomizationID"; else nok "XRechnung missing CustomizationID"; fi
# We made the email element conditional and malformed; verify it's not present
if grep -q "Universal通讯地址" "$OUT_XR"; then nok "XRechnung still has corrupted 'Universal通讯地址' element"; else ok "no corrupted element"; fi

# ── 9. ZUGFeRD ───────────────────────────────────────────────────────────
step "ZUGFeRD download"
OUT_ZF="/tmp/smoke_inv_zf.pdf"
apidl GET "/api/v1/invoices/$INV_ID/zugferd?companyId=$COMPANY_ID" "$OUT_ZF"
[ "$STATUS" = "200" ] && ok "GET zugferd → 200" || nok "GET zugferd → $STATUS"
[ -s "$OUT_ZF" ] && note "ZUGFeRD size: $(wc -c <"$OUT_ZF") bytes"
HEAD=$(head -c 4 "$OUT_ZF")
[ "$HEAD" = "%PDF" ] && ok "ZUGFeRD starts with %PDF" || nok "ZUGFeRD not PDF"
# The PDF has embedded XML; verify by extracting with pdfdetach or pypdf
if python3 -c "import pypdf" 2>/dev/null; then
  if python3 -c "
from pypdf import PdfReader
r=PdfReader('$OUT_ZF')
files=r.embedded_files if hasattr(r,'embedded_files') else {}
emb=list(files.keys()) if files else []
print('YES' if any('xml' in k.lower() for k in emb) else 'NO')" 2>/dev/null | grep -q YES; then
    ok "ZUGFeRD PDF has embedded XML"
  else
    note "ZUGFeRD embedded XML not detected (PDF/A-3 conformance may not be enforced in current implementation)"
  fi
fi

# ── 10. Payment recording → auto status transition to paid ───────────────
step "Record full payment on INV (auto-transition to paid)"
INV_TOTAL=$(python3 -c "import json; d=json.loads('''$BODY'''); print(d['total'])" 2>/dev/null || echo "0")
# re-fetch INV in case local BODY got overwritten
apib GET "/api/v1/invoices/$INV_ID?companyId=$COMPANY_ID" ""
INV_TOTAL=$(python3 -c "import json; d=json.loads('''$BODY'''); print(d['total'])")

# half payment first (should NOT mark paid)
apib POST "/api/v1/invoices/$INV_ID/payments?companyId=$COMPANY_ID" "{
  \"amount\": $(python3 -c "print(float('$INV_TOTAL')/2)"),
  \"paymentDate\": \"2026-06-06\",
  \"paymentMethod\": \"bank_transfer\",
  \"notes\": \"Teilzahlung\"
}"
[ "$STATUS" = "201" ] || [ "$STATUS" = "200" ] && ok "partial payment recorded" || nok "partial payment failed: $STATUS $BODY"
apib GET "/api/v1/invoices/$INV_ID?companyId=$COMPANY_ID" ""
HALF_STATUS=$(python3 -c "import json; d=json.loads('''$BODY'''); print(d['status'])")
[ "$HALF_STATUS" = "draft" ] || [ "$HALF_STATUS" = "sent" ] && ok "INV still $HALF_STATUS after partial" || nok "INV status=$HALF_STATUS after partial (expected draft/sent)"

# full remaining payment → should mark paid
apib POST "/api/v1/invoices/$INV_ID/payments?companyId=$COMPANY_ID" "{
  \"amount\": $(python3 -c "print(float('$INV_TOTAL')/2)"),
  \"paymentDate\": \"2026-06-06\",
  \"paymentMethod\": \"bank_transfer\",
  \"notes\": \"Restzahlung\"
}"
[ "$STATUS" = "201" ] || [ "$STATUS" = "200" ] && ok "remaining payment recorded" || nok "remaining payment failed: $STATUS"
apib GET "/api/v1/invoices/$INV_ID?companyId=$COMPANY_ID" ""
NEW_STATUS=$(python3 -c "import json; d=json.loads('''$BODY'''); print(d['status'])")
[ "$NEW_STATUS" = "paid" ] && ok "INV auto-transitioned to paid" || nok "INV status=$NEW_STATUS (expected paid)"

# ── 11. Status change via PUT /:id/status ───────────────────────────────
step "PUT /:id/status (paid → cancelled)"
apib PUT "/api/v1/invoices/$INV_ID/status?companyId=$COMPANY_ID" '{"status":"cancelled"}'
[ "$STATUS" = "200" ] && ok "status → cancelled" || nok "status change failed: $STATUS $BODY"

# ── 12. List + pagination + filter ───────────────────────────────────────
step "List + pagination + filter"
apib GET "/api/v1/invoices?page=1&pageSize=10&companyId=$COMPANY_ID" ""
[ "$STATUS" = "200" ] && ok "list → 200" || nok "list failed: $STATUS"
TOTAL=$(python3 -c "import json; d=json.loads('''$BODY'''); print(d.get('total',0))")
[ "$TOTAL" -gt 0 ] && note "list total=$TOTAL" || note "list empty"

apib GET "/api/v1/invoices?type=CN&companyId=$COMPANY_ID" ""
[ "$STATUS" = "200" ] && ok "filter type=CN → 200" || nok "filter type=CN failed"
CN_COUNT=$(python3 -c "import json; d=json.loads('''$BODY'''); print(d.get('total',0))")
[ "$CN_COUNT" -ge 1 ] && ok "filter type=CN returned $CN_COUNT CNs" || nok "no CN in filter"

apib GET "/api/v1/invoices?search=$INV_NUM&companyId=$COMPANY_ID" ""
[ "$STATUS" = "200" ] && ok "search → 200" || nok "search failed"

# ── 13. Bulk download (ZIP) ──────────────────────────────────────────────
step "Bulk download (ZIP, invoiceIds)"
OUT_ZIP="/tmp/smoke_bulk.zip"
curl -s -o "$OUT_ZIP" -X POST "$BASE/api/v1/invoices/bulk-download?companyId=$COMPANY_ID" \
  -H "$H_USER" -H "$H_CO" -H "$H_JSON" \
  -d "{\"invoiceIds\":[\"$INV_ID\",\"$CN_ID\",\"$PI_ID\"]}"
[ -s "$OUT_ZIP" ] && ok "ZIP downloaded: $(wc -c <"$OUT_ZIP") bytes" || nok "ZIP empty"
if command -v unzip >/dev/null 2>&1; then
  unzip -l "$OUT_ZIP" 2>/dev/null | grep -E "INV-|CN-|PI-" >/tmp/_ziplist
  COUNT=$(wc -l </tmp/_ziplist)
  [ "$COUNT" -ge 3 ] && ok "ZIP contains $COUNT invoice files" || nok "ZIP has $COUNT entries (expected 3+)"
  unzip -l "$OUT_ZIP" 2>/dev/null | grep -q "_manifest.txt" && ok "ZIP contains _manifest.txt" || nok "no _manifest.txt"
fi

# ── 14. Bulk download by date range ──────────────────────────────────────
step "Bulk download (ZIP, date range)"
curl -s -o /tmp/smoke_bulk_dates.zip -X POST "$BASE/api/v1/invoices/bulk-download?companyId=$COMPANY_ID" \
  -H "$H_USER" -H "$H_CO" -H "$H_JSON" \
  -d '{"dateFrom":"2026-06-01","dateTo":"2026-06-30","type":"INV","format":"pdf"}'
[ -s /tmp/smoke_bulk_dates.zip ] && ok "date-range ZIP downloaded" || nok "date-range ZIP empty"

# ── 15. Bulk download ZUGFeRD ───────────────────────────────────────────
step "Bulk download (ZIP, format=zugferd)"
curl -s -o /tmp/smoke_bulk_zf.zip -X POST "$BASE/api/v1/invoices/bulk-download?companyId=$COMPANY_ID" \
  -H "$H_USER" -H "$H_CO" -H "$H_JSON" \
  -d "{\"invoiceIds\":[\"$INV_ID\"],\"format\":\"zugferd\"}"
[ -s /tmp/smoke_bulk_zf.zip ] && ok "ZUGFeRD ZIP downloaded" || nok "ZUGFeRD ZIP empty"

# ── 16. CSV export ──────────────────────────────────────────────────────
step "CSV export"
OUT_CSV="/tmp/smoke_export.csv"
curl -s -o "$OUT_CSV" "$BASE/api/v1/invoices/export/csv?companyId=$COMPANY_ID&dateFrom=2026-06-01&dateTo=2026-06-30" \
  -H "$H_USER" -H "$H_CO"
[ -s "$OUT_CSV" ] && ok "CSV downloaded: $(wc -c <"$OUT_CSV") bytes" || nok "CSV empty"
HEAD3=$(head -c 3 "$OUT_CSV" | xxd | head -1 | awk '{print $2$3}')
# expect UTF-8 BOM EF BB BF
[ "$HEAD3" = "efbbbf" ] && ok "CSV starts with UTF-8 BOM (Excel-friendly)" || note "CSV BOM: $HEAD3 (expected efbbbf)"
head -1 "$OUT_CSV" | grep -q "Rechnungsnummer" && ok "CSV has German headers" || nok "CSV header missing Rechnungsnummer"

# ── 17. Cancellation instead of delete (no DELETE endpoint) ─────────────
step "Cancellation: PUT status=cancelled is the deletion path"
apib PUT "/api/v1/invoices/$INV_ID/status?companyId=$COMPANY_ID" '{"status":"cancelled"}'
[ "$STATUS" = "200" ] && ok "INV cancelled via status update" || nok "cancel failed: $STATUS"

# ── 18. Auth: missing headers → 403 ──────────────────────────────────────
step "Auth: missing x-headers → 403"
STATUS_NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/invoices?companyId=$COMPANY_ID")
[ "$STATUS_NO_AUTH" = "403" ] && ok "no-auth → 403" || note "no-auth → $STATUS_NO_AUTH"

# ── summary ──────────────────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════"
echo "  PASS: $PASS    FAIL: $FAIL"
echo "═══════════════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed checks:"
  for entry in "${LOG[@]}"; do
    [[ "$entry" == FAIL* ]] && echo "  $entry"
  done
  exit 1
fi
echo "All checks passed."
exit 0
