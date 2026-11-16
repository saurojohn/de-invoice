#!/bin/bash
# Tier 847 — a restore from the kept copy that cannot issue leaves nothing
# behind; and no spec writes to a database nobody named.
#
# Measured before:
#  - an invoice a restore lost, entered again while the company had no
#    Steuernummer: refused (mandatory details), but the draft made for it
#    stayed under the lost number. The next attempt answered 500 — the
#    invoice could not be restored from the page any more;
#  - PG_CONTAINER defaulted to `de-invoice-postgres` everywhere. In CI that
#    is the throwaway container; on the developer's machine it is the
#    development database. A local Playwright run without the variable
#    deleted two rows there (16.11.2026).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
OP_U=$USER_ID; OP_C=$COMPANY_ID
Y=$(TZ=Europe/Berlin date +%Y); TODAY=$(TZ=Europe/Berlin date +%F)
TAG="e2e-541-$(date +%s%N | cut -c1-13)"
STORE="${STORAGE_PATH:-}"
case "$STORE" in ""|"$HOME/data/"*|/data/*) fail "this spec needs a throwaway STORAGE_PATH (got „$STORE“)"; summary; exit 1 ;; esac
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
company() { # name → U C K
  local reg="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier847-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$reg" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
  local co='{"vatId":"DE123456789","phone":"+49 30 1","email":"info@t541.example.test","address":{"street":"Altstraße 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"bankName":"Testbank","iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
  AS PUT "/api/v1/companies/$C?companyId=$C" "$co"
  local cu='{"name":"Kunde Nord GmbH","type":"business","vatId":"DE987654321","address":{"street":"Ring 2","postalCode":"20095","city":"Hamburg","country":"DE"},"contact":{"email":"ap@nord541.example.test"}}'
  AS POST "/api/v1/customers?companyId=$C" "$cu"; K=$(json_field "$BODY" id)
}
issue() { # net → I N
  local b="{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  AS POST "/api/v1/invoices?companyId=$C" "$b"; I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
path() { PSQL "select \"pdfPath\" from \"Invoice\" where id='$1'"; }

note "=== 1. a restore that cannot issue: nothing stays, and the next attempt works ==="
company Y; issue 10; issue 250
SRC="$STORE/$(path "$I")"
company X; issue 10
XDIR="$STORE/$(dirname "$(path "$I")")"; T=$(date +%s000); NUM="INV-$Y-000002"
cp "$SRC" "$XDIR/$((T + 1))_$NUM.pdf"; cp "${SRC%.pdf}.xrechnung.xml" "$XDIR/$((T + 1))_$NUM.xrechnung.xml"
XU=$U; XC=$C
U=$OP_U; C=$OP_C; AS GET "/api/v1/admin/backups/status" # (the check, as at the start after a restore)
U=$XU; C=$XC
with_number() { PSQL "select count(*)||' '||coalesce(string_agg(status, ','), '-') from \"Invoice\" where \"companyId\"='$C' and \"invoiceNumber\"='$NUM'"; }
retired() { PSQL "select reason||' '||(\"resolvedAt\" is not null)::text from \"RetiredInvoiceNumber\" where \"companyId\"='$C' and \"invoiceNumber\"='$NUM'"; }
assert_eq "fixture: $NUM is lost — its copy is there, its row is not" "$(with_number) / $(retired)" "0 - / restore false"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"","taxId":""}'
assert_status 200 "fixture: the company without a Steuernummer or USt-IdNr."
AS POST "/api/v1/invoices/retired-numbers/$NUM/restore?companyId=$C" '{}'
assert_status 400 "the restore is refused: the invoice cannot be issued without them"
assert_eq "…and no draft stays under the lost number, which is still blocked (was: 1 draft)" "$(with_number) / $(retired)" "0 - / restore false"
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789"}'
AS POST "/api/v1/invoices/retired-numbers/$NUM/restore?companyId=$C" '{}'
assert_status 200 "with the USt-IdNr. back, the next attempt restores it (was: 500)"
assert_eq "…issued under its number, the number resolved" "$(with_number) / $(retired)" "1 sent / restore true"

note "--- a draft an attempt of the old code left is cleared by the next one ---"
company Z; issue 10
ZDIR="$STORE/$(dirname "$(path "$I")")"; T=$(date +%s000)
cp "$SRC" "$ZDIR/$((T + 1))_$NUM.pdf"; cp "${SRC%.pdf}.xrechnung.xml" "$ZDIR/$((T + 1))_$NUM.xrechnung.xml"
ZU=$U; ZC=$C
U=$OP_U; C=$OP_C; AS GET "/api/v1/admin/backups/status"
U=$ZU; C=$ZC
PSQL "insert into \"Invoice\" (id, \"companyId\", \"customerId\", \"invoiceNumber\", type, status, \"issueDate\", \"dueDate\", subtotal, \"totalVat\", total, currency, language, \"createdAt\", \"updatedAt\") values ('left-$TAG', '$C', '$K', '$NUM', 'INV', 'draft', '$TODAY', '$TODAY', 250, 47.5, 297.5, 'EUR', 'de-DE', now(), now())" >/dev/null
assert_eq "fixture: a draft under the lost number, as a failed attempt left it" "$(with_number)" "1 draft"
AS POST "/api/v1/invoices/retired-numbers/$NUM/restore?companyId=$C" '{}'
assert_status 200 "the restore goes through (was: 500)"
assert_eq "…one invoice under the number, issued; the leftover is gone" "$(with_number) / $(PSQL "select count(*) from \"Invoice\" where id='left-$TAG'")" "1 sent / 0"
AS POST "/api/v1/invoices/retired-numbers/$NUM/restore?companyId=$C" '{}'
assert_eq "a second restore of the same number: it is no lost invoice any more" "$STATUS" "404"

note "=== 2. no spec starts against a database nobody named ==="
ROOT="$SCRIPT_DIR/../.."
lib() { # env settings… → exit status and whether the message names the variable
  local out rc
  out=$(cd "$SCRIPT_DIR" && env -u CI -u PG_CONTAINER "$@" bash -c 'source ./_lib.sh; echo "container=$PG_CONTAINER"' 2>&1); rc=$?
  echo "$rc $(echo "$out" | grep -c 'PG_CONTAINER is not set') $(echo "$out" | grep -o 'container=.*')"
}
assert_eq "_lib.sh without PG_CONTAINER on a developer's machine: it does not start (was: the development database)" "$(lib API="$API")" "2 1 "
assert_eq "…with the container named: it starts" "$(lib API="$API" PG_CONTAINER=tmp-ci-pg)" "0 0 container=tmp-ci-pg"
assert_eq "…in CI: the default, its throwaway container" "$(lib CI=true)" "0 0 container=de-invoice-postgres"
for f in backend/e2e/ci-seed.sh backend/e2e/run-all.sh frontend/scripts/run-all.sh; do
  assert_eq "$f: the same check before its default" "$(grep -c 'PG_CONTAINER is not set' "$ROOT/$f")" "1"
done
ts() { (cd "$SCRIPT_DIR/.." && env -u CI -u PG_CONTAINER "$@" npx ts-node --transpile-only -e "console.log('container=' + require('../frontend/e2e/fixtures/test-env').PG_CONTAINER)" 2>&1) | grep -oE "PG_CONTAINER is not set|container=.*" | head -1; }
assert_eq "the Playwright specs' test-env.ts without it: it does not load (was: the development database)" "$(ts)" "PG_CONTAINER is not set"
assert_eq "…with the container named" "$(ts PG_CONTAINER=tmp-ci-pg)" "container=tmp-ci-pg"
assert_eq "…in CI: the default" "$(ts CI=true)" "container=de-invoice-postgres"
# (spec 341 greps a README for such a line; it runs none)
assert_eq "no spec names the development database's container itself" \
  "$(grep -lE "docker exec[^\$]*de-invoice-postgres" "$ROOT"/frontend/e2e/*.ts "$ROOT"/backend/e2e/*.sh 2>/dev/null | grep -vE '541-tier847|341-tier561' | wc -l | tr -d ' ')" "0"
summary
