#!/usr/bin/env bash
# e2e 49: ELSTER XML contract
#
# Verifies the UStVA XML output from
# GET /api/v1/ustva/filings/:id/elster-xml
# matches the BMF / ERiC schema contract.
#
# Why this test exists:
#   The elster.service.ts generator
#   produces ERiC-compatible XML.
#   The BMF Anlage UStVA schema changes
#   ~1x/year (the calendar year version).
#   Without this test, a future schema
#   change could break the XML output
#   silently — the Steuerberater
#   downloads the file, uploads to
#   Mein ELSTER, and gets a generic
#   "XML ungültig" error 5 minutes later.
#
#   This test catches regressions in
#   the SHAPE of the XML, not the
#   VALUES (those are tested by the
#   UStVA compute e2e). We check:
#
#   1. Content-Type is application/xml
#   2. Root element is <Datenlieferung>
#   3. <Nutzdatenblock> contains
#      <Umsatzsteuervoranmeldung>
#   4. <Steuernummer> matches the
#      company's normalized tax number
#   5. <DatenLieferant>1</DatenLieferant>
#      (we send from the taxpayer, not
#      the Steuerberater)
#   6. <Erstellungsdatum> matches the
#      filing date
#   7. Each numeric field uses the BMF
#      "B"-prefix format ("B 1234567890123")
#   8. <Kz81> (Verbleibender Betrag) is
#      present — required by the Anlage
#   9. <Vorgang> is present and non-empty

set -uo pipefail
# Tier 355: honour PG_CONTAINER (this script does not source _lib.sh).
PG_CONTAINER="${PG_CONTAINER:-de-invoice-postgres}"
HOST="${HOST:-http://localhost:3001}"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"
PASS=0
FAIL=0

assert() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $label (expected: $expected, got: $actual)"
    FAIL=$((FAIL+1))
  fi
}

if [[ ! -f /tmp/cashbook-e2e-auth.env ]]; then
  echo "FATAL: /tmp/cashbook-e2e-auth.env not found" >&2
  exit 1
fi
source /tmp/cashbook-e2e-auth.env
if [[ -z "${USER_ID:-}" ]]; then
  echo "FATAL: USER_ID not in cache" >&2
  exit 1
fi

# We need an existing filing. Try to
# find one; if none, the test creates
# one by calling compute + saveFiling.
FILING_ID=$(PGPASSWORD=de_invoice_pass docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"UStvaFiling\" WHERE \"companyId\"='$COMPANY_ID' ORDER BY \"createdAt\" DESC LIMIT 1;" 2>/dev/null | tr -d ' ' | head -1)
if [[ -z "$FILING_ID" ]]; then
  echo "No existing filing — creating one..."
  # First compute the UStVA data
  COMPUTE=$(curl -sS \
    "$HOST/api/v1/ustva/compute?companyId=$COMPANY_ID&year=2026&quarter=1" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
  # Then save it as a filing. The
  # saveFiling body expects a UstvaData
  # shape (outputVat, inputVat, etc. —
  # see ustva.service.ts).
  # We extract the relevant fields
  # from compute's response and wrap
  # them in the saveFiling shape.
  SAVE=$(curl -sS -X POST "$HOST/api/v1/ustva/filings?companyId=$COMPANY_ID" \
    -H "Content-Type: application/json" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -d "$(python3 -c "
import json
d = json.loads('''$COMPUTE''')
# Map compute output → saveFiling
# shape (which is also a UstvaData
# shape — see ustva.service.ts).
# Top-level fields expected by saveFiling:
# Tier 371: SaveUstvaFilingDto is UstvaDataDto (exactly the compute output)
# plus optional taxNumber / notes / status, validated with
# forbidNonWhitelisted. This used to also send outputVat, inputVat,
# payableVat, intraEUSales and intraEUPurchase — fields that no longer exist —
# so every create was rejected with HTTP 400 and the spec skipped. On CI's
# fresh database there is never a pre-existing filing, so this spec had never
# asserted anything in CI.
out = {
  **d,
  'taxNumber': '04424316529',  # SH Leder's tax #
  'status': 'draft',
}
print(json.dumps(out))
")")
  FILING_ID=$(echo "$SAVE" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [[ -z "$FILING_ID" ]]; then
    # Tier 371: was `SKIP … exit 0`. A failed create is a failure — it is how
    # the stale payload above hid for as long as it did: 0 passed, 0 failed,
    # exit 0, counted as a pass by run-all.sh.
    echo "  FAIL: could not create a UStVA filing (response: $SAVE)"
    echo "==== 0 passed, 1 failed ===="
    exit 1
  fi
  echo "Created filing $FILING_ID"
fi
echo "Testing filing $FILING_ID"

# Fetch the XML. Use -D to capture headers
# separately so we can check Content-Type.
HDR_FILE=/tmp/t49_hdr.txt
XML_FILE=/tmp/t49.xml
curl -sS -D "$HDR_FILE" -o "$XML_FILE" \
  "$HOST/api/v1/ustva/filings/$FILING_ID/elster-xml?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID"
CT=$(grep -i "^content-type" "$HDR_FILE" | awk '{print $2}' | tr -d '\r' | head -1)

# 1. Content-Type
assert "Content-Type is application/xml" "application/xml;" "$CT"

# 2. Root element. We strip the
#    xmlns="..." attribute before
#    matching so the test isn't fooled
#    by the namespace declaration.
ROOT=$(head -3 "$XML_FILE" | grep -oE '<[A-Za-z]+' | head -1 | tr -d '<')
assert "root element is <Datenlieferung>" "Datenlieferung" "$ROOT"

# 3. <Umsatzsteuervoranmeldung> inside <Nutzdatenblock>.
#    The elster.service.ts generator may
#    or may not include this for an
#    empty filing (a draft with no
#    Kz values). We only require it if
#    the filing has data; for an empty
#    draft, accept its absence.
KV_COUNT=$(grep -cE '<Kz[0-9]+' "$XML_FILE" || true)
if [[ "$KV_COUNT" -ge "1" ]]; then
  if grep -q "<Umsatzsteuervoranmeldung" "$XML_FILE"; then
    echo "  PASS: <Umsatzsteuervoranmeldung> present (KV count=$KV_COUNT)"
    PASS=$((PASS+1))
  else
    echo "  FAIL: <Umsatzsteuervoranmeldung> missing (KV count=$KV_COUNT > 0)"
    FAIL=$((FAIL+1))
  fi
else
  # Tier 371: the old reason ("no Kz values in this draft") was wrong. This
  # check is gated on <KzNN> elements, and elster.service.ts never emits any —
  # it writes amounts as "B-Kz081=…" lines inside <Kennzahlen>/<Feld>. So this
  # check could never run, with or without data. Whether the generator or this
  # expectation matches the official ELSTER schema is an open question — see
  # HANDOFF §9.
  echo "  SKIP: <Umsatzsteuervoranmeldung> — generator emits no <KzNN> elements (format question, HANDOFF §9)"
fi

# 4. <Steuernummer> — 13 digits. Skip
#    if no Umsatzsteuervoranmeldung
#    (an empty draft has no Steuernummer).
if grep -q "<Steuernummer>" "$XML_FILE"; then
  STEUER=$(grep -oE "<Steuernummer>[^<]+</Steuernummer>" "$XML_FILE" | sed -E 's|<Steuernummer>([^<]+)</Steuernummer>|\1|')
  STEUER_LEN=${#STEUER}
  assert "<Steuernummer> is 13 digits" "13" "$STEUER_LEN"
else
  echo "  SKIP: <Steuernummer> (no data in this draft)"
fi

# 5. <DatenLieferant>1</DatenLieferant>
if grep -q "<DatenLieferant>" "$XML_FILE"; then
  DATEN_LIEF=$(grep -oE "<DatenLieferant>[^<]+</DatenLieferant>" "$XML_FILE" | sed -E 's|<DatenLieferant>([^<]+)</DatenLieferant>|\1|')
  assert "DatenLieferant=1 (taxpayer filing)" "1" "$DATEN_LIEF"
else
  # Tier 371: not a data issue — elster.service.ts never writes a
  # <DatenLieferant> element at all. Format question, see HANDOFF §9.
  echo "  SKIP: <DatenLieferant> — generator never emits this element (format question, HANDOFF §9)"
fi

# 6. <Erstellungsdatum> present
if grep -q "<Erstellungsdatum>" "$XML_FILE"; then
  echo "  PASS: <Erstellungsdatum> present"
  PASS=$((PASS+1))
else
  # The schema uses <Eingangsdatum> or
  # <Erstellungsdatum> depending on
  # the section. Accept either.
  if grep -q "<Eingangsdatum>" "$XML_FILE"; then
    echo "  PASS: <Eingangsdatum> present (acceptable alias for <Erstellungsdatum>)"
    PASS=$((PASS+1))
  else
    echo "  FAIL: <Erstellungsdatum> and <Eingangsdatum> both missing"
    FAIL=$((FAIL+1))
  fi
fi

# 7. B-prefix format for numerics. The
#    BMF Anlage convention is: B followed
#    by a space then digits (per BMF
#    ERiC schema). Only check if Kz
#    fields exist (empty drafts skip).
if [[ "$KV_COUNT" -ge "1" ]]; then
  B_FORMAT=$(grep -cE '>\s*B\s+[0-9]+\s*<' "$XML_FILE" || true)
  if [[ "$B_FORMAT" -ge "1" ]]; then
    echo "  PASS: BMF B-prefix format present ($B_FORMAT occurrences)"
    PASS=$((PASS+1))
  else
    echo "  FAIL: no B-prefix format found (KV count=$KV_COUNT > 0)"
    FAIL=$((FAIL+1))
  fi
else
  # Tier 371: gated on <KzNN> elements, which the generator never emits (it
  # writes "B-Kz081=…" text lines), so this could never run. Format question,
  # see HANDOFF §9.
  echo "  SKIP: B-prefix format — gated on <KzNN> elements the generator never emits (HANDOFF §9)"
fi

# 8. <Kz81> (Verbleibender Betrag) present
if [[ "$KV_COUNT" -ge "1" ]]; then
  if grep -qE "<Kz81>" "$XML_FILE"; then
    echo "  PASS: <Kz81> (Verbleibender Betrag) present"
    PASS=$((PASS+1))
  else
    echo "  FAIL: <Kz81> missing — required by Anlage UStVA"
    FAIL=$((FAIL+1))
  fi
else
  # Tier 371: not a data issue — the generator writes Kz 81 as a "B-Kz081=…"
  # line, never as a <Kz81> element, so this check could never run. Format
  # question, see HANDOFF §9.
  echo "  SKIP: <Kz81> — generator writes Kz 81 as a B-Kz081 text line, not an element (HANDOFF §9)"
fi

# 9. <Vorgang> present and non-empty
VORGANG=$(grep -oE "<Vorgang>[^<]+</Vorgang>" "$XML_FILE" | sed -E 's|<Vorgang>([^<]+)</Vorgang>|\1|')
if [[ -n "$VORGANG" ]]; then
  echo "  PASS: <Vorgang> present (value: $VORGANG)"
  PASS=$((PASS+1))
else
  echo "  FAIL: <Vorgang> missing or empty"
  FAIL=$((FAIL+1))
fi

# 10. XML is well-formed (parseable)
if python3 -c "import xml.etree.ElementTree as ET; ET.parse('$XML_FILE')" 2>/dev/null; then
  echo "  PASS: XML is well-formed (parseable by Python ElementTree)"
  PASS=$((PASS+1))
else
  echo "  FAIL: XML is NOT well-formed"
  FAIL=$((FAIL+1))
fi

rm -f "$HDR_FILE" "$XML_FILE"

echo
echo "==== $PASS passed, $FAIL failed ===="
exit $FAIL
