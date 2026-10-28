#!/bin/bash
# Tier 733 — an invoice issued after the database dump keeps its number after a restore
#
# The restore drill of 28.10.2026 (a stack like the production one, dumped,
# server lost, files and database restored as the RUNBOOK says): the database
# is dumped on the hour, the files mirrored at :20. The invoice issued after
# the dump came back as its kept copy only — and the next invoice got its
# number, INV-2026-000004, a second time. The customer holds the first one.
#
# Here, on a fresh company, what a restore leaves: one invoice issued (in the
# database, its kept copy in the storage) and the kept copies of two more
# that the database — and its audit log, which a dump takes along — has never
# heard of. The backup page's check finds them and blocks their numbers; the
# next invoice and a deleted draft do not reuse them; once an invoice with
# such a number is in the database again, it is no longer reported. An
# invoice deleted on its issue day leaves its copy too — the audit log knows
# it, so it is not reported; its number is retired as well: a draft deleted
# after it wound the sequence back below it, and the next invoice got it again.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
OP_U=$USER_ID; OP_C=$COMPANY_ID
TAG="t451-$(date +%s%N | cut -c1-13)"
YEAR=$(TZ=Europe/Berlin date +%Y); TODAY=$(TZ=Europe/Berlin date +%F)
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() { # user company method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }

REG_BODY="{\"email\":\"$TAG@example.test\",\"password\":\"Tier733-e2e\",\"companyName\":\"$TAG GmbH\"}"
AS x x POST "/api/v1/auth/register" "$REG_BODY"
U=$(P "d['user']['id']"); C=$(P "d['user'].get('companyId') or d['company']['id']"); q="companyId=$C"
COMPANY_BODY='{"vatId":"DE123456789","phone":"+49 30 1","email":"info@t451.example.test","address":{"street":"Altstraße 1","city":"Berlin","postalCode":"10115","country":"DE"}}'
AS "$U" "$C" PUT "/api/v1/companies/$C?$q" "$COMPANY_BODY"
CUSTOMER_BODY='{"name":"Kunde 451 GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"ap@t451.example.test"}}'
AS "$U" "$C" POST "/api/v1/customers?$q" "$CUSTOMER_BODY"; K=$(P "d['id']")
ISSUE='{"status":"sent"}'
new_invoice() { # [status] → ID, NUM
  local body="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  AS "$U" "$C" POST "/api/v1/invoices?$q" "$body"; ID=$(P "d['id']"); NUM=$(P "d['invoiceNumber']")
  [ "${1:-}" = sent ] && AS "$U" "$C" PUT "/api/v1/invoices/$ID/status?$q" "$ISSUE"
}

STORE="${STORAGE_PATH:-}"
case "$STORE" in ""|"$HOME/data/"*|/data/*) fail "this spec needs a throwaway STORAGE_PATH (got „$STORE“)"; summary; exit 1 ;; esac

note "=== 1. one invoice issued, with its kept copy ==="
new_invoice sent; I1=$ID; N1=$NUM
assert_eq "numbered 1" "$N1" "INV-$YEAR-000001"
COPY=$(PSQL "select \"pdfPath\" from \"Invoice\" where id='$I1'")
assert_eq "its kept copy is in the storage" "$(test -f "$STORE/$COPY" && echo yes)" "yes"

note "=== 2. what a restore leaves: the copies of two invoices the database never heard of ==="
N2="INV-$YEAR-000002"; N3="INV-$YEAR-000003"
DIR=$(dirname "$STORE/$COPY"); T=$(date +%s000)
cp "$STORE/$COPY" "$DIR/$((T + 1))_$N2.pdf"; cp "$STORE/$COPY" "$DIR/$((T + 2))_$N3.pdf"
# (the backend checks when it starts — after a restore that is before the first request)
AS "$OP_U" "$OP_C" GET "/api/v1/admin/backups/status"
# and one deleted on its issue day: its copy stays, the audit log knows it
new_invoice sent; DEL=$ID; NDEL=$NUM
AS "$U" "$C" DELETE "/api/v1/invoices/$DEL?$q"
assert_eq "an invoice issued and deleted the same day ($NDEL)" "$STATUS/$(PSQL "select count(*) from \"Invoice\" where id='$DEL'")" "200/0"
assert_eq "…its number retired as deleted" "$(PSQL "select reason from \"RetiredInvoiceNumber\" where \"companyId\"='$C' and \"invoiceNumber\"='$NDEL'")" "deleted"

note "=== 3. the check finds the two copies ==="
AS "$OP_U" "$OP_C" GET "/api/v1/admin/backups/status"
assert_eq "the backup page: both numbers, as not in the database — not the deleted one" \
  "$STATUS/$(P "sorted(l['invoiceNumber'] for l in d.get('restore', {}).get('lost', []) if l['companyId'] == '$C')")" "200/['$N2', '$N3']"
assert_eq "…with the company and the kept copy" \
  "$(P "[(l['companyName'], l['pdfPath'].endswith('_$N2.pdf')) for l in d['restore']['lost'] if l['invoiceNumber'] == '$N2' and l['companyId'] == '$C']")" "[('$TAG GmbH', True)]"
AS "$OP_U" "$OP_C" POST "/api/v1/admin/backups/status/check" '{}'
assert_eq "the hourly check reports them (409, the numbers named)" "$STATUS/$(P "'$N2' in d.get('message','') and 'nur als Kopie' in d.get('message','')")" "409/True"

note "=== 4. their numbers are not handed out again ==="
new_invoice; D5=$ID; N5=$NUM
EXPECT=$(printf "INV-$YEAR-%06d" $(( 10#${NDEL##*-} + 1 )))
assert_eq "the next invoice: after the blocked ones and the deleted one — not $N2 (before: $N2)" "$N5" "$EXPECT"
AS "$U" "$C" DELETE "/api/v1/invoices/$D5?$q"
assert_eq "the newest draft deleted" "$STATUS" "200"
new_invoice; R2=$ID
assert_eq "…its number goes back to the series — not below the blocked ones, not to the deleted issued one (before: $NDEL again)" "$NUM" "$EXPECT"

note "=== 5. an invoice with the number in the database again: no longer reported ==="
PSQL "update \"Invoice\" set \"invoiceNumber\" = '$N2' where id = '$R2'"
AS "$OP_U" "$OP_C" GET "/api/v1/admin/backups/status"
assert_eq "only $N3 left" "$(P "sorted(l['invoiceNumber'] for l in d['restore']['lost'] if l['companyId'] == '$C')")" "['$N3']"
assert_eq "$N2 marked as back in the books" "$(PSQL "select (\"resolvedAt\" is not null)::text from \"RetiredInvoiceNumber\" where \"companyId\"='$C' and \"invoiceNumber\"='$N2'")" "true"
new_invoice; R3=$ID
PSQL "update \"Invoice\" set \"invoiceNumber\" = '$N3' where id = '$R3'"
AS "$OP_U" "$OP_C" GET "/api/v1/admin/backups/status"
assert_eq "none left for this company (nothing stays red for the specs after this one)" "$(P "[l for l in d['restore']['lost'] if l['companyId'] == '$C']")" "[]"

note "=== 6. the restore procedure ==="
ROOT="$SCRIPT_DIR/../.."
assert_eq "restore.sh: applies the migrations before the backend starts again" "$(grep -c 'run --rm --no-deps backend npx prisma migrate deploy' "$ROOT/infra/prod/restore.sh")" "1"
assert_eq "restore.sh --list: all four directories" "$(grep -c '/backups/last /backups/daily /backups/weekly /backups/monthly' "$ROOT/infra/prod/restore.sh")" "1"
assert_eq "RUNBOOK: the files first, then the database" "$(grep -c '1. \*\*The files first\*\*' "$ROOT/infra/prod/RUNBOOK.md")" "1"

summary
