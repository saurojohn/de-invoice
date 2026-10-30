#!/bin/bash
# Tier 748 — a company's Verfahrensdokumentation, as a Word file
#
# The template was a file in the repository, which no company using the program
# can reach. GET /accounting/verfahrensdokumentation fills in what the program
# knows and marks what only the company knows. Read here as Word reads it: a ZIP
# of well-formed XML parts.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-467-$(date +%s%N | cut -c1-13)"
D=$(mktemp -d)
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier748-e2e\",\"companyName\":\"Müller & Söhne $TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
get() { curl -sS -D "$D/h" -o "$D/doc.docx" -w '%{http_code}' "$API/api/v1/accounting/verfahrensdokumentation?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"; }
# text of the document, one paragraph a line
text() { python3 -I -c "
import sys, zipfile
import xml.etree.ElementTree as ET
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
root = ET.fromstring(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))
for p in root.iter(W + 'p'):
    print(''.join(t.text or '' for t in p.iter(W + 't')))" "$D/doc.docx"; }
in_doc() { grep -cF -- "$1" "$D/doc.txt"; }

note "=== 1. a fresh company: what the program knows, the rest marked ==="
assert_eq "200, a Word document, for download" \
  "$(get)/$(grep -ic 'wordprocessingml.document' "$D/h")/$(grep -ic '^content-disposition: attachment' "$D/h")" "200/1/1"
# (a function: inside "$( )" the braces of a Python set are brace-expanded, and
# assert_eq gets other arguments than it should)
parts() { python3 -I - "$D/doc.docx" <<'PY'
import sys, zipfile
import xml.etree.ElementTree as ET
z = zipfile.ZipFile(sys.argv[1])
for n in z.namelist():
    ET.fromstring(z.read(n))
need = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']
print(all(n in z.namelist() for n in need), len(z.namelist()))
PY
}
assert_eq "every part of the file is well-formed XML, with what Word needs" "$(parts)" "True 6"
text > "$D/doc.txt"
assert_eq "the title names the company, „&\" as it is" "$(head -1 "$D/doc.txt")" "Verfahrensdokumentation Müller & Söhne $TAG GmbH"
assert_eq "the sections are there" "$(grep -cE '^[1-8]\. ' "$D/doc.txt" | awk '$1>=8{print "ok"}')" "ok"
assert_eq "no trace of the Markdown or of the template" \
  "$(grep -cE '\*\*|<!--|^\||^> |Diese Vorlage|\(Vorlage\)' "$D/doc.txt")" "0"
assert_eq "no paths of the code in a document for a Steuerberater" "$(grep -cE 'backend/|infra/|docs/|USER-GUIDE|Tier [0-9]' "$D/doc.txt")" "0"
HIGHLIGHT() { python3 -I -c "import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode().count('w:highlight'))" "$D/doc.docx"; }
FRESH=$(HIGHLIGHT)
[[ "$FRESH" -gt 10 ]] && pass "what is still to fill in is highlighted ($FRESH places)" || fail "highlights: $FRESH"
assert_eq "a missing tax number is marked" "$(grep -A1 -x 'Steuernummer' "$D/doc.txt" | tail -1)" "[Auszufüllen]"

note "=== 2. what the company entered is in it ==="
COMPANY='{"taxId":"181/815/08155","bundesland":"BY","vatId":"DE811907980","registerEntry":"HRB 12345 Amtsgericht München","managingDirector":"Eva Muster","address":{"street":"Teststr. 1","postalCode":"80331","city":"München","country":"DE"}}'
AS PUT "/api/v1/companies/$C?companyId=$C" "$COMPANY"
assert_eq "fixture: the company's details" "$STATUS" "200"
get >/dev/null; text > "$D/doc.txt"
row() { grep -A1 -xF -- "$1" "$D/doc.txt" | tail -1; }
assert_eq "Steuernummer" "$(row 'Steuernummer')" "181/815/08155"
assert_eq "USt-IdNr." "$(row 'USt-IdNr.')" "DE811907980"
assert_eq "the Land" "$(row 'Finanzamt im Land')" "Bayern"
assert_eq "the address" "$(row 'Anschrift')" "Teststr. 1, 80331 München"
assert_eq "the register" "$(row 'Handelsregister')" "HRB 12345 Amtsgericht München"
assert_eq "the directors" "$(row 'Geschäftsführung')" "Eva Muster"
assert_eq "the legal form" "$(row 'Rechtsform')" "GmbH"
assert_eq "the profit: a GmbH balances" "$(row 'Gewinnermittlung')" "Bilanz (§ 4 Abs. 1, § 5 EStG)"
assert_eq "the mail goes through the installation" "$(row 'E-Mail-Versand')" "über den Mailserver der Installation"
assert_eq "the access: one admin, by count, no addresses" "$(row 'Zugänge im Programm')/$(in_doc "$TAG@example.test")" "1 Administrator/0"
[[ "$(HIGHLIGHT)" -lt "$FRESH" ]] && pass "fewer places are marked now" || fail "still $(HIGHLIGHT)"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2026-03-31","reason":"Spec 467"}'
get >/dev/null; text > "$D/doc.txt"
assert_eq "the closing of the books" "$(row 'Bücher festgeschrieben bis')" "31.03.2026"
assert_eq "the history says it was made for the company" "$(in_doc 'aus dem Programm erzeugt')" "2"

note "=== 3. who may have it ==="
INVITE="{\"email\":\"$TAG-v@example.test\",\"role\":\"viewer\"}"
AS POST "/api/v1/users/invitations?companyId=$C" "$INVITE"
TOKEN=$(grep -o "register?invite=[A-Za-z0-9_-]*" /tmp/backend.log | tail -1 | cut -d= -f2)
ACCEPT="{\"token\":\"$TOKEN\",\"password\":\"Tier748-view1\"}"
V=$(curl -sS -X POST "$API/api/v1/invitations/accept" -H "Content-Type: application/json" -d "$ACCEPT" \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('userId',''))")
assert_eq "a viewer: 403" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/accounting/verfahrensdokumentation?companyId=$C" -H "x-user-id: $V" -H "x-company-id: $C")" "403"
assert_eq "without a login: 401" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/accounting/verfahrensdokumentation?companyId=$C")" "401"

note "=== 4. the Markdown of the template, line by line ==="
assert_eq "the template has the markers the company's table replaces" \
  "$(grep -c '<!-- firma -->' "$SCRIPT_DIR/../assets/verfahrensdokumentation.md")/$(grep -c '<!-- erzeugt -->' "$SCRIPT_DIR/../assets/verfahrensdokumentation.md")" "1/1"

summary
