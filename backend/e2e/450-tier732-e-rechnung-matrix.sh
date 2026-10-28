#!/bin/bash
# Tier 732 — the e-invoices of every kind of invoice, by the official validators
#
# The owner, 28.10.2026: „电子发票合规了吗？“ Measured: 16 kinds of invoice
# (domestic, 19 % + 7 % with a discount, Skonto, a service period, the order
# number, cash / card / PayPal, § 13b, an intra-community supply, an export,
# USD, a public client with a Leitweg-ID, a Storno credit note, a
# Kleinunternehmer), each as XRechnung (UBL) and as ZUGFeRD (CII), through
# KoSIT (XRechnung schematron 2.6.0, CEN 1.3.16) — 31 of 32 accepted. The
# XRechnung to a customer without an electronic address was rejected
# (PEPPOL-EN16931-R010: BT-49 is required in XRechnung 3.0), and it was
# produced all the same. The ZUGFeRD PDFs through Mustang (PDF/A-3 + XML),
# and the files back in through the e-invoice import (the duty to receive).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-450-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/files" "$WORK/report" "$WORK/mustang"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KOSIT_ROOT="$ROOT/infra/kosit"
JAVA_BIN="$ROOT/infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
TODAY=$(TZ=Europe/Berlin date +%F)

reg() { # tag name → "U C"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier732-e2e\",\"companyName\":\"$2\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
cii_of() { python3 - "$1" <<'PY'
import re, sys, zlib
pdf = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', pdf, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: data = m.group(1)
    if b'CrossIndustryInvoice' in data[:2000]:
        sys.stdout.write(data.decode('utf-8')); break
PY
}
company() { # tag name extra-json
  read -r U C < <(reg "$1" "$2")
  AS PUT "/api/v1/companies/$C?companyId=$C" "{\"legalName\":\"$2\",\"vatId\":\"DE123456789\",\"taxId\":\"12/345/67890\",\"phone\":\"+49 30 1234567\",\"email\":\"rechnung@matrix.example.test\",\"registerEntry\":\"Amtsgericht Berlin-Charlottenburg, HRB 123456 B\",\"managingDirector\":\"Anna Beispiel\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}$3}"
}
customer() { AS POST "/api/v1/customers?companyId=$C" "$1"; json_field "$BODY" id; }
MADE=""
case_() { # name customerId extra-json items-json → files/<name>.{ubl.xml,zugferd.pdf,cii.xml}
  local name=$1
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$2\",\"issueDate\":\"$TODAY\",\"items\":$4$3}"
  local inv; inv=$(json_field "$BODY" id)
  [[ -z "$inv" ]] && { fail "$name: create → $STATUS ${BODY:0:160}"; return; }
  AS PUT "/api/v1/invoices/$inv/status?companyId=$C" '{"status":"sent"}'
  [[ "$STATUS" == 200 ]] || fail "$name: issue → $STATUS ${BODY:0:160}"
  fetch "/api/v1/invoices/$inv/xrechnung?companyId=$C" "$WORK/files/$name.ubl.xml" > "$WORK/code"
  [[ "$(cat "$WORK/code")" == 200 ]] || rm -f "$WORK/files/$name.ubl.xml"
  fetch "/api/v1/invoices/$inv/zugferd?companyId=$C" "$WORK/files/$name.zugferd.pdf" > /dev/null
  cii_of "$WORK/files/$name.zugferd.pdf" > "$WORK/files/$name.cii.xml"
  LAST=$inv; MADE="$MADE $name"
}
L19='{"description":"Beratung","quantity":2,"unit":"Std","unitPrice":100,"vatRate":0.19}'
L7='{"description":"Fachbuch","quantity":1,"unit":"Stk","unitPrice":40,"vatRate":0.07}'
L0='{"description":"Ware","quantity":3,"unit":"Stk","unitPrice":50,"vatRate":0}'

note "=== the invoices ==="
company "$TAG" "$TAG Werkstatt GmbH" ""
assert_eq "fixture: a GmbH" "$STATUS" "200"
KDE=$(customer '{"name":"Kunde DE GmbH","type":"business","vatId":"DE987654321","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"ap@kunde.example.test","name":"Frau Erika Mustermann"}}')
KFR=$(customer '{"name":"Client SARL","type":"business","vatId":"FR12345678901","address":{"street":"1 Rue de Rivoli","postalCode":"75001","city":"Paris","country":"FR"},"contact":{"email":"ap@client.example.test"}}')
KCH=$(customer '{"name":"Kunde AG Zürich","type":"business","address":{"street":"Bahnhofstr. 1","postalCode":"8001","city":"Zürich","country":"CH"},"contact":{"email":"ap@ch.example.test"}}')
KB2G=$(customer '{"name":"Stadt Musterstadt","type":"business","address":{"street":"Rathausplatz 1","postalCode":"12345","city":"Musterstadt","country":"DE","leitwegId":"04011000-1234512345-06"},"contact":{"email":"rechnung@stadt.example.test"}}')
KPRIV=$(customer '{"name":"Max Privat","type":"individual","address":{"street":"Weg 1","postalCode":"50667","city":"Köln","country":"DE"},"contact":{"email":"max@privat.example.test"}}')
KNONE=$(customer '{"name":"Ohne Adresse GmbH","type":"business","address":{"street":"Weg 3","postalCode":"50667","city":"Köln","country":"DE"}}')

case_ standard "$KDE" "" "[$L19]"
case_ mixed-discount "$KDE" ',"discountPercent":10' "[$L19,$L7]"
case_ skonto "$KDE" ',"skontoPercent":2,"skontoDays":10' "[$L19]"
case_ service-period "$KDE" ",\"servicePeriodStart\":\"2026-09-01\",\"servicePeriodEnd\":\"2026-09-30\"" "[$L19]"
case_ references "$KDE" ',"orderReference":"4500012345","buyerReference":"Projekt Nord"' "[$L19]"
case_ cash "$KPRIV" ',"paymentMethod":"cash"' "[$L19]"
case_ card "$KDE" ',"paymentMethod":"ec_card"' "[$L19]"
case_ paypal "$KDE" ',"paymentMethod":"paypal"' "[$L19]"
case_ reverse-charge "$KDE" ',"reverseCharge":true' "[$L0]"
case_ igl-fr "$KFR" ',"euTransaction":true' "[$L0]"
case_ export-ch "$KCH" '' "[$L0]"
case_ usd "$KDE" ',"currency":"USD","exchangeRate":1.08' "[$L19]"
case_ b2g-leitweg "$KB2G" '' "[$L19]"
case_ storno-base "$KDE" '' "[$L19]"
AS POST "/api/v1/invoices/$LAST/credit-note?companyId=$C" '{"reason":"Storno"}'
CN=$(json_field "$BODY" id)
if [[ -n "$CN" ]]; then
  AS PUT "/api/v1/invoices/$CN/status?companyId=$C" '{"status":"sent"}'
  fetch "/api/v1/invoices/$CN/xrechnung?companyId=$C" "$WORK/files/credit-note.ubl.xml" > /dev/null
  fetch "/api/v1/invoices/$CN/zugferd?companyId=$C" "$WORK/files/credit-note.zugferd.pdf" > /dev/null
  cii_of "$WORK/files/credit-note.zugferd.pdf" > "$WORK/files/credit-note.cii.xml"
  MADE="$MADE credit-note"
else fail "credit note: $STATUS ${BODY:0:160}"; fi
U1=$U; C1=$C
company "$TAG-k" "$TAG Einzelunternehmen" ',"defaultVatMode":"kleinunternehmer","vatId":null'
K=$(customer '{"name":"Kunde DE GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"ap@kunde.example.test"}}')
case_ kleinunternehmer "$K" '' "[$L19]"
U2=$U; C2=$C; U=$U1; C=$C1
assert_eq "16 kinds of invoice, each as XRechnung and ZUGFeRD" "$(ls "$WORK/files"/*.ubl.xml | wc -l | tr -d ' ')/$(ls "$WORK/files"/*.cii.xml | wc -l | tr -d ' ')" "16/16"

note "=== 1. KoSIT: XRechnung 3.0.2 (schematron 2.6.0) and EN 16931 CII ==="
if [[ -z "$JAVA_BIN" ]]; then fail "no Java for KoSIT"; else
  (cd "$WORK/report" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" -s "$KOSIT_ROOT/scenarios.xml" -o . "$WORK/files"/*.xml > "$WORK/kosit.log" 2>&1)
  VERDICTS=$(python3 - "$WORK" <<'PY'
import glob, os, re, sys
w = sys.argv[1]
bad = []
for f in sorted(glob.glob(os.path.join(w, 'files', '*.xml'))):
    base = os.path.basename(f)[:-4]
    rep = os.path.join(w, 'report', base + '-report.xml')
    if not os.path.exists(rep): bad.append(f'{base}: no report'); continue
    x = open(rep, encoding='utf-8').read()
    fatal = sorted(set(re.findall(r'failed-assert flag="fatal" id="([^"]+)"', x)))
    if fatal or re.search(r'<rep:message[^>]*level="error"', x): bad.append(f'{base}: {" ".join(fatal) or "schema"}')
print('; '.join(bad) or 'all accepted')
PY
)
  assert_eq "every file accepted (was: the XRechnung of a buyer without BT-49 rejected — now not produced)" "$VERDICTS" "all accepted"
  assert_eq "…KoSIT's own count" "$(grep -o 'Acceptable: *[0-9]* *Rejected: *[0-9]*' "$WORK/kosit.log" | tr -s ' ')" "Acceptable: 32 Rejected: 0" || tail -5 "$WORK/kosit.log"
fi

note "=== 2. Mustang: the ZUGFeRD PDFs (PDF/A-3 and the XML) ==="
if [[ -n "${MUSTANG_JAR:-}" && -f "$MUSTANG_JAR" && -n "$JAVA_BIN" ]]; then
  BADPDF=""
  for f in "$WORK/files"/*.zugferd.pdf; do
    b=$(basename "$f" .zugferd.pdf)
    (cd "$WORK/mustang" && "$JAVA_BIN" -jar "$MUSTANG_JAR" --action validate --source "$f" --disable-file-logging > "$b.xml" 2>/dev/null)
    st=$(python3 -c "import re,sys;x=open(sys.argv[1]).read();s=re.findall(r'<summary status=\"([a-z]+)\"',x);print('ok' if s and all(v=='valid' for v in s) else ','.join(s) or 'none')" "$WORK/mustang/$b.xml")
    [[ "$st" == ok ]] || BADPDF="$BADPDF $b($st)"
  done
  assert_eq "all 16 ZUGFeRD PDFs valid (PDF/A-3, XML)" "${BADPDF:-none}" "none"
else
  note "  (MUSTANG_JAR not set — CI fetches it; locally infra/mustang)"
fi

note "=== 3. a customer without an electronic address (BT-49) ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$KNONE\",\"issueDate\":\"$TODAY\",\"items\":[$L19]}"
NONE=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$NONE/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/invoices/$NONE/xrechnung?companyId=$C"
assert_eq "no XRechnung that XRechnung rejects: 400, and what to enter (was: an invalid file)" \
  "$STATUS/$(echo "$BODY" | grep -c 'E-Mail-Adresse für Rechnungen')" "400/1"
AS GET "/api/v1/invoices/$NONE/xrechnung/validate?companyId=$C"
assert_eq "the in-process check names it (PEPPOL-EN16931-R010)" \
  "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(d['valid'], [e['rule'] for e in d['errors']])" "$BODY")" "False ['PEPPOL-EN16931-R010']"
fetch "/api/v1/invoices/$NONE/zugferd?companyId=$C" "$WORK/none.pdf" > "$WORK/code"
assert_eq "…the ZUGFeRD PDF all the same (EN 16931 does not require BT-49)" "$(cat "$WORK/code")/$(head -c 4 "$WORK/none.pdf")" "200/%PDF"
AS PUT "/api/v1/customers/$KNONE?companyId=$C" '{"contact":{"invoiceEmail":"buchhaltung@ohne.example.test"}}'
fetch "/api/v1/invoices/$NONE/xrechnung?companyId=$C" "$WORK/none.xml" > "$WORK/code"
assert_eq "with an e-mail for invoices: the XRechnung, BT-49 that address" \
  "$(cat "$WORK/code")/$(grep -c 'schemeID="EM">buchhaltung@ohne.example.test<' "$WORK/none.xml")" "200/1"

note "=== 4. received: the files back in, as another company's expenses ==="
U=$U2; C=$C2
IMPORTED=""
for f in standard.ubl.xml mixed-discount.cii.xml reverse-charge.zugferd.pdf credit-note.ubl.xml; do
  mime=application/xml; [[ $f == *.pdf ]] && mime=application/pdf
  code=$(curl -sS -o "$WORK/imp.json" -w "%{http_code}" -X POST "$API/api/v1/expenses/e-invoice/import?companyId=$C" \
    -H "x-user-id: $U" -H "x-company-id: $C" -F "file=@$WORK/files/$f;type=$mime" -F "companyId=$C" -F "confirmRecipient=true")
  IMPORTED="$IMPORTED $code"
done
assert_eq "UBL, CII, a ZUGFeRD PDF and a credit note read in" "$IMPORTED" " 201 201 201 201"
AMOUNTS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select string_agg(\"grossAmount\"::numeric(12,2)::text, ' ' order by \"grossAmount\") from \"Expense\" where \"companyId\"='$C'")
assert_eq "…at the invoices' amounts (credit −238, 150 § 13b, 238, 252.72 after 10 %)" "$AMOUNTS" "-238.00 150.00 238.00 252.72"

summary
