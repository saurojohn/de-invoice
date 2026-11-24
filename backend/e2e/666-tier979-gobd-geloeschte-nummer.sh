#!/bin/bash
# Tier 979 — the GoBD export keeps a deleted invoice number traceable
#
# An issued invoice deleted before it went out leaves a gap in the series.
# Measured: INV-…-000002 issued, its PDF made, deleted, INV-…-000003 issued —
# no file of the unpacked export named 000002, though its copy was kept, and
# the audit CSV said "invoice.deleted,Invoice,<id>" with no number, amount or
# customer (oldData / newData were not written for any row).
# § 146 Abs. 4 AO, § 14 Abs. 4 Nr. 4 UStG, GoBD Rz. 107-110.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-666-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
D=$(TZ=Europe/Berlin date +%F)
Y=${D:0:4}

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier979-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde Lücke","type":"business","contact":{"email":"rechnung@kunde-luecke.example"},"address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
inv() { # net
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$D\",\"deliveryDate\":\"$D\",\"items\":[{\"description\":\"L\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
  N=$(json_field "$BODY" invoiceNumber)
}
inv 100
inv 200; B=$I; NB=$N
curl -sS -o "$W/b.pdf" "$API/api/v1/invoices/$B/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
AS DELETE "/api/v1/invoices/$B?companyId=$C"
assert_eq "fixture: $NB issued and deleted before it went out" "$STATUS" "200"
inv 300

curl -sS -o "$W/g.zip" "$API/api/v1/gobd-export?companyId=$C&year=$Y" -H "x-user-id: $U" -H "x-company-id: $C"
mkdir "$W/g" && (cd "$W/g" && unzip -q ../g.zip)
LIST="$W/g/invoices/geloeschte-rechnungsnummern.csv"
assert_eq "the export lists the deleted number (was: no file named it)" \
  "$(python3 -c "
import csv,sys
rows=list(csv.DictReader(open(sys.argv[1],encoding='utf-8-sig'),delimiter=';'))
r=[x for x in rows if x['Rechnungsnummer']==sys.argv[2]]
print(len(r), r[0]['Rechnungsdatum'] if r else '', r[0]['Brutto'] if r else '', r[0]['Kunde'] if r else '', bool(r and r[0]['Protokoll-ID']))" "$LIST" "$NB" 2>&1)" \
  "1 $D 238 Kunde Lücke True"
KEPT=$(python3 -c "
import csv,sys
print([x for x in csv.DictReader(open(sys.argv[1],encoding='utf-8-sig'),delimiter=';') if x['Rechnungsnummer']==sys.argv[2]][0]['Aufbewahrte Kopie'])" "$LIST" "$NB" 2>/dev/null)
assert_eq "…with its kept copy, a PDF in the archive" "$(head -c 4 "$W/g/$KEPT" 2>/dev/null)" "%PDF"
assert_eq "…and in the manifest" "$(python3 -c "import json,sys;print(any(f['path']==sys.argv[2] for f in json.load(open(sys.argv[1]))['files']))" "$W/g/manifest.json" "$KEPT")" "True"
assert_eq "the audit CSV: the deletion row carries the invoice it deleted (was: id only)" \
  "$(python3 -c "
import csv,sys,glob,json
rows=list(csv.DictReader(open(glob.glob(sys.argv[1]+'/audit-logs/*.csv')[0],encoding='utf-8-sig')))
r=[x for x in rows if x['action']=='invoice.deleted']
o=json.loads(r[0]['oldData']) if r and r[0].get('oldData') else {}
print(len(r), o.get('invoiceNumber'), float(o.get('total') or 0), bool(r and r[0].get('hash')))" "$W/g" 2>&1)" \
  "1 $NB 238.0 True"

assert_eq "each issued invoice's kept XRechnung is in the archive (was: PDF only)" \
  "$(ls "$W/g/invoices/" | grep -c '\.xrechnung\.xml$')" "2"

summary
