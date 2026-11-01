#!/bin/bash
# Tier 762 — the archives of a year in a container of 1 GiB
#
# Measured with 8 161 invoices and 3 000 receipts of 1 MiB, the production image,
# --memory=1g: GET /accounting/gobd-archive and /gobd-export ended the process
# (exit 137). All documents were held in memory until the ZIP had caught up, the
# export as one Buffer of 3,4 GB; and storage read with readFileSync, which held
# every other request for seconds (/health: 28 s).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
SRC="$SCRIPT_DIR/../src"
TAG="t762-$(date +%s)"
D=$(mktemp -d)
BODY="{\"email\":\"$TAG@example.test\",\"password\":\"Tier762-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$BODY" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['user']['id'], r['company']['id'])")
H=(-H "x-user-id: $U" -H "x-company-id: $C")
YEAR=$(date +%Y)

# what cannot be measured in a spec is kept by the code's shape
assert_eq "storage reads without blocking" "$(sed -n '/async getFile/,/^  }/p' "$SRC/modules/storage/storage.service.ts" | grep -c 'readFileSync')" "0"
assert_eq "storage writes without blocking" "$(grep -c 'writeFileSync' "$SRC/modules/storage/storage.service.ts")" "0"
assert_eq "the Belege come one at a time" "$(grep -c 'export async function\* belegeInPeriod' "$SRC/modules/accounting/gobd-belege.ts")" "1"
assert_eq "the export holds no archive in memory" "$(grep -c 'Buffer.concat(chunks)' "$SRC/modules/gobd-export/gobd-export.service.ts")" "0"
# a listener left on the response holds the document it was added for
assert_eq "the wait for an entry leaves nothing behind" "$(grep -c "reader?.off('close'" "$SRC/common/zip-entry.ts")" "1"
assert_eq "the image limits malloc's arenas" "$(grep -c '^ENV MALLOC_ARENA_MAX=2' "$SCRIPT_DIR/../Dockerfile")" "1"

CUST=$(curl -sS -X POST "$API/api/v1/customers?companyId=$C" "${H[@]}" -H "Content-Type: application/json" \
  -d '{"name":"Kunde 762","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
INV_BODY="{\"customerId\":\"$CUST\",\"issueDate\":\"$YEAR-01-15\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
INV=$(curl -sS -X POST "$API/api/v1/invoices?companyId=$C" "${H[@]}" -H "Content-Type: application/json" -d "$INV_BODY" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
docker exec "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -c "update \"Invoice\" set status='sent' where id='$INV'" >/dev/null

code=$(curl -sS -m 60 -o "$D/a.zip" -w '%{http_code}' "${H[@]}" "$API/api/v1/accounting/gobd-archive?companyId=$C&year=$YEAR")
assert_eq "the archive is delivered" "$code" "200"
assert_eq "the invoice is in it, once" "$(unzip -l "$D/a.zip" | grep -c 'Invoices/.*\.pdf')" "1"
assert_eq "kept as it is, not compressed again" "$(unzip -v "$D/a.zip" | grep 'Invoices/.*\.pdf' | awk '{print $2}')" "Stored"
assert_eq "the manifest counts it" "$(unzip -p "$D/a.zip" MANIFEST.json | python3 -c "import json,sys; print(json.load(sys.stdin)['counts']['invoices'])")" "1"
assert_eq "the manifest's list of problems is there, empty" "$(unzip -p "$D/a.zip" MANIFEST.json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['belegeProblems']))")" "0"

code=$(curl -sS -m 60 -D "$D/h" -o "$D/e.zip" -w '%{http_code}' "${H[@]}" "$API/api/v1/gobd-export?companyId=$C&year=$YEAR")
assert_eq "the export is delivered" "$code" "200"
SIZE=$(grep -i '^content-length' "$D/h" | tr -d '\r' | awk '{print $2}')
assert_eq "its length is the file's" "$SIZE" "$(wc -c < "$D/e.zip" | tr -d ' ')"
assert_eq "its PDF is stored too" "$(unzip -v "$D/e.zip" | grep 'invoices/.*\.pdf' | awk '{print $2}' | head -1)" "Stored"
assert_eq "its text is compressed" "$(unzip -v "$D/e.zip" | grep -E ' manifest.json$' | awk '{print $2}')" "Defl:N"
rm -rf "$D"
summary
