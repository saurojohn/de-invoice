#!/bin/bash
# Tier 731e — the findings of the review of Tiers 566–731
#
#   - printing one invoice went through bulk-print, limited to 10 a minute:
#     the eleventh invoice printed in a minute was refused (429);
#   - the totals block was kept above the footer only, not above the lines
#     on its left (footer text, payment line, Skonto, tax note): a long
#     payment line ran through the totals labels;
#   - the hourly file mirror stopped at the first file it could not read —
#     no record of the run, the freshness check called the backup stale;
#   - an AG whose legal form stood in the old settings field: „Vorstand:“
#     on the invoice, „Geschäftsführer:“ on its statement and in BT-33.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-449-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'chmod -R u+rw "$WORK" "${STORAGE_PATH:-/nonexistent}/$TAG" 2>/dev/null; rm -rf "$WORK" "${STORAGE_PATH:-/nonexistent}/$TAG"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier731e-e2e\",\"companyName\":\"$TAG Werke\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
ADMIN() { # method path [body] — the operator (backup routes)
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
pos() { node "$SCRIPT_DIR/fixtures/pdf-text.mjs" "$1" --pos; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","registerEntry":"Amtsgericht München, HRB 98765","managingDirector":"Dr. Anna Beispiel","address":{"street":"Hauptstr. 5","postalCode":"80331","city":"München","country":"DE"},"bankInfo":{"bankName":"Testbank","iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
assert_eq "fixture: the company" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde GmbH\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"contact\":{\"email\":\"ap@kunde.example.test\"}}"
K=$(json_field "$BODY" id)
inv() { # n items, payment method → I
  local items; items=$(python3 -c "import json,sys;print(json.dumps([{'description':f'Leistung {i}','quantity':1,'unit':'Stk','unitPrice':10,'vatRate':0.19} for i in range(int(sys.argv[1]))]))" "$1")
  local b="{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"paymentMethod\":\"$2\",\"skontoPercent\":2,\"skontoDays\":10,\"items\":$items}"
  AS POST "/api/v1/invoices?companyId=$C" "$b"; I=$(json_field "$BODY" id)
}

note "=== 1. printing one invoice: not the bulk job's limit ==="
inv 1 bank_transfer; ONE=$I
CODES=""
for _ in $(seq 1 12); do
  CODES="$CODES $(curl -sS -o "$WORK/one.pdf" -w "%{http_code}" -X POST "$API/api/v1/invoices/$ONE/print?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C")"
done
assert_eq "12 prints in a row: all 200 (bulk-print refused the 11th)" "$(echo $CODES | tr ' ' '\n' | sort -u | tr '\n' ' ')" "200 "
assert_eq "…a PDF at its actual size" "$(head -c 4 "$WORK/one.pdf")/$(node -e "const L=require('pdf-lib');L.PDFDocument.load(require('fs').readFileSync(process.argv[1])).then(d=>console.log(String(d.catalog.lookup(L.PDFName.of('ViewerPreferences'))).replace(/\s+/g,' ')))" "$WORK/one.pdf")" "%PDF/<< /PrintScaling /None >>"
FOREIGN=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/invoices/$ONE/print?companyId=$COMPANY_ID" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "another company's invoice: 404" "$FOREIGN" "404"

note "=== 2. the totals never over the lines on their left ==="
OVER=""
for n in $(seq 8 26); do
  inv "$n" ec_card
  curl -sS -o "$WORK/t.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C&format=pdf"
  BAD=$(pos "$WORK/t.pdf" | python3 -c "
import json,sys
for pg in json.load(sys.stdin):
    totals=[r for r in pg if r['x']>80 and r['s'].rstrip(':') in ('Zwischensumme (Netto)','USt 19 %','Gesamtbetrag')]
    left=[r for r in pg if r['x']<20 and (r['s'].startswith('Zahlbar') or r['s'].startswith('Vielen Dank'))]
    if totals and left and max(t['y'] for t in totals) > min(l['y'] for l in left) - 3: print('x')
")
  [[ -n "$BAD" ]] && OVER="$OVER $n"
done
assert_eq "8 … 26 lines, a long payment line: the totals end above it on every invoice" "${OVER:-none}" "none"

note "=== 3. the file mirror goes on past a file it cannot read ==="
throwaway() { case "$1" in ""|"$HOME/data/"*|/data/*) return 1 ;; esac; return 0; }
case "$(throwaway "${STORAGE_PATH:-}" && throwaway "${BACKUP_FILES_DIR:-}" && echo yes)" in
  "") note "  (skipped: needs throwaway STORAGE_PATH / BACKUP_FILES_DIR, as spec 438)" ;;
  *)
    S="$STORAGE_PATH/$TAG"; mkdir -p "$S"
    printf 'lesbar' > "$S/a.pdf"; printf 'gesperrt' > "$S/b.pdf"; chmod 000 "$S/b.pdf"
    ADMIN POST "/api/v1/admin/backups/files/run" '{}'
    assert_eq "the run ends (it stopped at the first file it could not read): 200, one skipped" \
      "$STATUS/$(json_field "$BODY" skipped)" "200/1"
    assert_eq "…the readable one copied, the run recorded" \
      "$(cat "$BACKUP_FILES_DIR/mirror/$TAG/a.pdf")/$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['skipped'])" "$BACKUP_FILES_DIR/last-run.json")" "lesbar/1"
    chmod 600 "$S/b.pdf"
    ;;
esac

note "=== 4. an AG by the old settings field: „Vorstand:“ everywhere ==="
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qc "update \"Company\" set rechtsform = null, \"legalName\" = null, name = '$TAG Werke', settings = coalesce(settings, '{}'::jsonb) || '{\"rechtsform\":\"AG\"}'::jsonb where id = '$C'" >/dev/null
inv 1 bank_transfer
curl -sS -o "$WORK/x.xml" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/xrechnung?companyId=$C"
curl -sS -o "$WORK/st.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/customers/$K/statement.pdf?companyId=$C&from=2026-09-01&to=2026-10-31"
curl -sS -o "$WORK/inv.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C&format=pdf"
assert_eq "invoice / statement / BT-33: „Vorstand:“ (statement and BT-33 said „Geschäftsführer:“)" \
  "$(pdf_text "$WORK/inv.pdf" | grep -c 'Vorstand: Dr. Anna Beispiel')/$(pdf_text "$WORK/st.pdf" | grep -c 'Vorstand: Dr. Anna Beispiel')/$(grep -c 'Vorstand: Dr. Anna Beispiel' "$WORK/x.xml")" "1/1/1"

summary
