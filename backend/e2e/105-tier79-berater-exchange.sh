#!/usr/bin/env bash
# e2e 105: Tier 79 — Berater Document Exchange
# (Steuerberater write-back channel to Mandant).
#
# Validates the new /api/v1/berater/notes endpoints
# that give a Steuerberater (UserCompany.role='berater')
# a way to leave notes + upload supporting documents
# on specific records. The Mandant sees the queue
# and can acknowledge or dismiss.
#
# Tests:
#   1. Berater creates a note (no file) — 201
#   2. Berater creates a note with a file — 201 +
#      attachment is downloadable.
#   3. Berater cannot acknowledge their own note
#      (role boundary: only Mandant can act).
#   4. Mandant lists the queue (sees both notes).
#   5. Mandant acknowledges one note.
#   6. Mandant dismisses the other note.
#   7. Mandant cannot create a Berater note
#      (role boundary: only Berater can post).
#   8. Bad entityId → 400.
#   9. Empty message → 400.
#  10. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"             # primary Mandant user (admin)
COMPANY_ID="$COMPANY_ID"

# A second test user that will be the Berater.
# Tier 66 requires role='berater' on UserCompany
# for the write-back to work.
TS="$(date +%s)-$$"
TEST_BERATER_EMAIL="berater-tier79-${TS}@example.com"
TEST_PW="Test1234!"
TEST_BERATER_ID="user-berater-tier79-${TS}"
echo "=== Test: Berater Document Exchange (berater: $TEST_BERATER_EMAIL) ==="

# Cleanup hook (run on exit)
cleanup() {
  docker exec de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null 2>&1
DELETE FROM "BeraterNote" WHERE "companyId" = '$COMPANY_ID' AND "createdById" = '$TEST_BERATER_ID';
DELETE FROM "Attachment"  WHERE "companyId" = '$COMPANY_ID' AND "uploadedById" = '$TEST_BERATER_ID';
DELETE FROM "UserCompany" WHERE "companyId" = '$COMPANY_ID' AND "userId" = '$TEST_BERATER_ID';
DELETE FROM "User"        WHERE id = '$TEST_BERATER_ID';
SQL
}
trap cleanup EXIT

# Seed the test Berater user + UserCompany grant
# with role='berater' (tier 66 permission boundary).
SEED_HASH=$(node -e "console.log(require('bcrypt').hashSync('${TEST_PW}', 10))")
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
INSERT INTO "User" (id, "companyId", email, "passwordHash", role, status, "createdAt")
VALUES ('$TEST_BERATER_ID'::text, '$COMPANY_ID', '$TEST_BERATER_EMAIL',
        '$SEED_HASH', 'berater', 'active', now());

INSERT INTO "UserCompany" ("userId", "companyId", role, "grantedAt", "grantedById")
VALUES ('$TEST_BERATER_ID', '$COMPANY_ID', 'berater', now(), '$TEST_BERATER_ID')
ON CONFLICT ("userId", "companyId") DO UPDATE SET role='berater';
SQL

# Pick an existing invoice to attach notes to
# (any non-draft invoice works). Fall back to
# seeding a fresh test invoice if the dev DB
# has no paid invoices.
INV_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
  "SELECT id FROM \"Invoice\" WHERE \"companyId\"='$COMPANY_ID' AND status IN ('paid','sent','overdue') LIMIT 1;" \
  2>&1 | tr -d ' ' | head -1)
if [[ -z "$INV_ID" ]]; then
  # Fall back: seed a minimal invoice via SQL.
  CUST_ID=$(docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -tA -c \
    "SELECT id FROM \"Customer\" WHERE \"companyId\"='$COMPANY_ID' LIMIT 1;" \
    2>&1 | tr -d ' ' | head -1)
  INV_ID="inv-tier79-${TS}"
  docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
INSERT INTO "Invoice" (id, "companyId", "customerId", "invoiceNumber", "type", "status",
                       "issueDate", "subtotal", "totalVat", "total", "currency", "language",
                       "reverseCharge", "euTransaction", "customerName", "createdAt", "updatedAt")
VALUES ('$INV_ID'::text, '$COMPANY_ID', '$CUST_ID', 'TIER79-${TS}', 'INV', 'paid',
        '2026-04-15'::date, 100, 19, 119, 'EUR', 'de-DE',
        false, false, 'OSSTest', now(), now());
SQL
fi
echo "  Using invoice: $INV_ID"

# ── 1. Berater creates a note (no file) ──
echo
note "=== 1. Berater creates note (no file) ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  -X POST "$API/api/v1/berater/notes" \
  -H "x-user-id: $TEST_BERATER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"entityType\":\"invoice\",\"entityId\":\"$INV_ID\",\"message\":\"Bitte Kategorie pruefen — sieht nach Material aus.\"}")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "create (no file) 201" "$STATUS" "201"

NOTE1_ID=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
NOTE1_STATUS=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
assert_eq "note 1 status=open" "$NOTE1_STATUS" "open"
NOTE1_MSG=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['message'])")
assert_eq "note 1 message preserved" "$NOTE1_MSG" "Bitte Kategorie pruefen — sieht nach Material aus."

# ── 2. Berater creates a note with a file ──
echo
note "=== 2. Berater creates note with file ==="
# Use a real (multi-line) minimal PDF — the
# storage service's magic-byte check rejects
# one-line PDF files. A 200-byte minimal
# valid PDF is enough.
# macOS mktemp: the template's XXXXXX is the
# placeholder; the suffix after XXXXXX is
# preserved verbatim. So 'XXXXXX.pdf' gives
# 'random6chars.pdf'.
TMP_PDF=$(mktemp -t berater-tier79.XXXXXX).pdf
cat > "$TMP_PDF" <<'PDFEOF'
%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Count 0>>
endobj
xref
0 3
0000000000 65535 f
0000000009 00000 n
0000000051 00000 n
trailer
<</Size 3/Root 1 0 R>>
startxref
90
%%EOF
PDFEOF
# Sanity check: the file MUST have a .pdf extension
# or the storage service rejects it as "Dateityp nicht
# erlaubt". (mktemp -t on macOS appends random chars
# after the template, so the suffix '.pdf' on the
# template produces a real .pdf extension.)
ext="${TMP_PDF##*.}"
[[ "$ext" == "pdf" ]] || { echo "FATAL: mktemp produced .$ext, expected .pdf"; exit 2; }

RAW=$(curl -sS -w "\n%{http_code}" \
  -X POST "$API/api/v1/berater/notes" \
  -H "x-user-id: $TEST_BERATER_ID" -H "x-company-id: $COMPANY_ID" \
  -F "companyId=$COMPANY_ID" \
  -F "entityType=invoice" \
  -F "entityId=$INV_ID" \
  -F "message=Korrigierter Beleg anbei (Anlage 1)" \
  -F "file=@$TMP_PDF;type=application/pdf")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "create (with file) 201" "$STATUS" "201"

NOTE2_ID=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
ATT2_ID=$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('attachment',{}).get('id',''))")
test -n "$ATT2_ID" || fail "no attachment id on the note"
ATT2_NAME=$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('attachment',{}).get('originalName',''))")
echo "  Note 2: $NOTE2_ID  attachment: $ATT2_ID ($ATT2_NAME)"

# ── 2b. Attachment is downloadable ──
echo
note "=== 2b. download attachment ==="
ATT_SIZE=$(curl -sS -o /tmp/berater-tier79-dl.pdf -w "%{size_download}" \
  "$API/api/v1/berater/notes/$NOTE2_ID/attachment?companyId=$COMPANY_ID" \
  -H "x-user-id: $TEST_BERATER_ID" -H "x-company-id: $COMPANY_ID")
test "$ATT_SIZE" -gt 0 || fail "downloaded attachment is empty (size=$ATT_SIZE)"
MAGIC=$(head -c 4 /tmp/berater-tier79-dl.pdf | od -An -tx1 | tr -d ' \n')
assert_eq "downloaded PDF magic bytes" "$MAGIC" "25504446"
rm -f /tmp/berater-tier79-dl.pdf

# ── 3. Berater cannot acknowledge their own note ──
echo
note "=== 3. Berater cannot acknowledge (role boundary) ==="
ST=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/berater/notes/$NOTE1_ID/acknowledge" \
  -H "x-user-id: $TEST_BERATER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\"}")
assert_eq "berater acknowledge → 403" "$ST" "403"

# ── 4. Mandant lists the queue ──
echo
note "=== 4. Mandant lists notes (sees both) ==="
RAW=$(curl -sS "$API/api/v1/berater/notes?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
COUNT=$(echo "$RAW" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('total',0))")
test "$COUNT" -ge 2 || fail "expected >=2 notes, got $COUNT"
echo "  Queue size: $COUNT"

# ── 5. Mandant acknowledges note 1 ──
echo
note "=== 5. Mandant acknowledges note 1 ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  -X POST "$API/api/v1/berater/notes/$NOTE1_ID/acknowledge" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\"}")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "acknowledge 200" "$STATUS" "200"
NEW_STATUS=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
assert_eq "note 1 status=acknowledged" "$NEW_STATUS" "acknowledged"
ACK_BY=$(echo "$BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('acknowledgedBy',{}).get('id',''))")
assert_eq "acknowledgedBy = mandant" "$ACK_BY" "$USER_ID"

# ── 6. Mandant dismisses note 2 ──
echo
note "=== 6. Mandant dismisses note 2 ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  -X POST "$API/api/v1/berater/notes/$NOTE2_ID/dismiss" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\"}")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "dismiss 200" "$STATUS" "200"
NEW_STATUS=$(echo "$BODY" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
assert_eq "note 2 status=dismissed" "$NEW_STATUS" "dismissed"

# ── 7. Mandant cannot create a Berater note ──
echo
note "=== 7. Mandant cannot create (role boundary) ==="
ST=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/berater/notes" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"entityType\":\"invoice\",\"entityId\":\"$INV_ID\",\"message\":\"Mandant tries to write a berater note\"}")
# Mandant has ADMIN rank on the same company. The
# @Require('berater.note.create') passes (ADMIN
# >= ADMIN). The service-level role check then
# throws 403.
assert_eq "mandant create → 403" "$ST" "403"

# ── 8. Bad entityId → 400 ──
echo
note "=== 8. bad entityId → 400 ==="
ST=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/berater/notes" \
  -H "x-user-id: $TEST_BERATER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"entityType\":\"invoice\",\"entityId\":\"00000000-0000-0000-0000-000000000000\",\"message\":\"x\"}")
assert_eq "bad entityId → 400" "$ST" "400"

# ── 9. Empty message → 400 ──
echo
note "=== 9. empty message → 400 ==="
ST=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$API/api/v1/berater/notes" \
  -H "x-user-id: $TEST_BERATER_ID" -H "x-company-id: $COMPANY_ID" \
  -H "Content-Type: application/json" \
  -d "{\"companyId\":\"$COMPANY_ID\",\"entityType\":\"invoice\",\"entityId\":\"$INV_ID\",\"message\":\"   \"}")
assert_eq "empty message → 400" "$ST" "400"

# ── 10. Cross-tenant → 401 ──
echo
note "=== 10. cross-tenant → 401 ==="
ST=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/berater/notes?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST" "401"

# ── 11. Filter by status=open (should NOT include the 2 we already acted on) ──
echo
note "=== 11. status=open filter excludes the 2 we already moved ==="
RAW=$(curl -sS "$API/api/v1/berater/notes?companyId=$COMPANY_ID&status=open" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
N_OPEN=$(echo "$RAW" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('total',0))")
# Both notes from this test are now NOT open.
# The total is the number of OPEN notes for
# the company — should be 0 from this test's
# fixtures (we created 2, both acted on).
echo "  Open count after moves: $N_OPEN"
# Not asserting the exact number (the dev DB
# may have other open notes from previous test
# runs) but verify our 2 are NOT in the open
# list.
HAS_OURS=$(echo "$RAW" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ids = [n['id'] for n in d.get('items',[])]
ours = {'$NOTE1_ID','$NOTE2_ID'}
print('true' if not (ours & set(ids)) else 'false')
")
assert_eq "our 2 notes NOT in the open list" "$HAS_OURS" "true"

rm -f "$TMP_PDF"
summary
exit $?
