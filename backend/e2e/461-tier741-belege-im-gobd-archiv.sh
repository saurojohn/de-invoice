#!/bin/bash
# Tier 741 — the Belege are in the GoBD archives
#
# Measured before: an expense with its scanned invoice gave
# Expenses/<number>.json and no invoice in GET /accounting/gobd-archive (it read
# Expense.attachmentPath, which nothing writes), and nothing at all in GET
# /gobd-export (left out on purpose). What a tax auditor is handed has to hold
# the Belege (§ 147 Abs. 1 Nr. 4 AO). Now both hold them, byte for byte, those
# taken off a record under entfernt/, and a file that is missing or no longer
# the one stored is named in the manifest.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-461-$(date +%s%N | cut -c1-13)"
D=$(mktemp -d)
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier741-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE136695976
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
expense() { # number → id
  local body="{\"description\":\"Beleg $1\",\"invoiceDate\":\"2026-03-15\",\"invoiceNumber\":\"$1\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
  AS POST "/api/v1/expenses?companyId=$C" "$body"
  json_field "$BODY" id
}
attach() { # expenseId fileName → attachment id
  printf '%%PDF-1.4 %s %s\n' "$TAG" "$2" > "$D/$2"
  curl -sS -X POST "$API/api/v1/attachments" -H "x-user-id: $U" -H "x-company-id: $C" \
    -F "file=@$D/$2;type=application/pdf" -F "companyId=$C" -F "entityType=expense" -F "entityId=$1" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"
}
E1=$(expense "$TAG-1"); A1=$(attach "$E1" rechnung.pdf)
E2=$(expense "$TAG-2"); A2=$(attach "$E2" falsch.pdf); A3=$(attach "$E2" richtig.pdf)
AS DELETE "/api/v1/attachments/$A2?companyId=$C"
assert_eq "fixture: one Beleg taken off its record" "$STATUS" "200"
get() { curl -sS -o "$2" -w '%{http_code}' "$API$1" -H "x-user-id: $U" -H "x-company-id: $C"; }
# name of the entry ending in $2 / its content equals file $3
zipfind() { python3 -I -c "
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
m = [n for n in z.namelist() if n.endswith(sys.argv[2])]
print(m[0] if m else '-')" "$1" "$2"; }
same() { python3 -I -c "
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(z.read(sys.argv[2]) == open(sys.argv[3], 'rb').read())" "$1" "$2" "$3"; }
jsonof() { python3 -I -c "
import sys, json, zipfile
z = zipfile.ZipFile(sys.argv[1])
d = json.loads(z.read(sys.argv[2]))
print(eval(sys.argv[3]))" "$1" "$2" "$3"; }

note "=== 1. GET /accounting/gobd-archive ==="
assert_eq "the archive: 200" "$(get "/api/v1/accounting/gobd-archive?companyId=$C&year=2026" "$D/a.zip")" "200"
N=$(zipfind "$D/a.zip" "_rechnung.pdf")
[[ "$N" == Expenses/"$TAG"-1/* ]] && pass "the expense's Beleg is in it, under its number (was: only the JSON): $N" || fail "not in the archive: $N"
[[ "$N" != "-" ]] && assert_eq "…byte for byte" "$(same "$D/a.zip" "$N" "$D/rechnung.pdf")" "True"
assert_eq "the Beleg taken off a record: kept, under entfernt/" "$(zipfind "$D/a.zip" "_falsch.pdf" | grep -c "/entfernt/")" "1"
assert_eq "…and the current one beside it" "$(zipfind "$D/a.zip" "_richtig.pdf" | grep -c "/entfernt/")" "0"
assert_eq "the manifest counts 3, and no problem" "$(jsonof "$D/a.zip" MANIFEST.json "(d['counts']['attachments'], d['belegeProblems'])")" "(3, [])"
assert_eq "the manifest names the three periods of § 147 Abs. 3 AO (was: 10 years for all)" "$(jsonof "$D/a.zip" MANIFEST.json "'Buchungsbelege 8 Jahre' in d['disclaimer']")" "True"
AS GET "/api/v1/accounting/gobd-archive/summary?companyId=$C&year=2026"
assert_eq "the summary counts them too (was 0)" "$(json_field "$BODY" attachmentCount)" "3"

note "=== 2. GET /gobd-export ==="
assert_eq "the export: 200" "$(get "/api/v1/gobd-export?companyId=$C&year=2026" "$D/e.zip")" "200"
N=$(zipfind "$D/e.zip" "_rechnung.pdf")
[[ "$N" == belege/expenses/"$TAG"-1/* ]] && pass "the Beleg is in it (was: left out): $N" || fail "not in the export: $N"
[[ "$N" != "-" ]] && assert_eq "…byte for byte" "$(same "$D/e.zip" "$N" "$D/rechnung.pdf")" "True"
assert_eq "…with its SHA-256 in the manifest" \
  "$(jsonof "$D/e.zip" manifest.json "[f['sha256'] for f in d['files'] if f['path'].endswith('_rechnung.pdf')]")" "['$(q "SELECT \"contentHash\" FROM \"Attachment\" WHERE id='$A1';")']"
assert_eq "the taken-off one under entfernt/" "$(zipfind "$D/e.zip" "_falsch.pdf" | grep -c "/entfernt/")" "1"
assert_eq "the expenses' data: a meta file each" \
  "$(python3 -I -c "import sys,zipfile;print(len([n for n in zipfile.ZipFile(sys.argv[1]).namelist() if n.startswith('expenses/')]))" "$D/e.zip")" "2"
assert_eq "the report: 3 Belege, no problem" "$(jsonof "$D/e.zip" verification-report.json "(d['summary']['belege'], d['summary']['belegeProblems'])")" "(3, [])"
get "/api/v1/gobd-export?companyId=$C&year=2025" "$D/none.zip" >/dev/null
assert_eq "another year holds none of them" "$(jsonof "$D/none.zip" verification-report.json "d['summary']['belege']")" "0"

note "=== 3. a file missing or changed is named, not passed over ==="
q "UPDATE \"Attachment\" SET \"contentHash\"=repeat('0',64) WHERE id='$A1';" >/dev/null
q "UPDATE \"Attachment\" SET \"storagePath\"='2026/03/attachments/$C/gibt-es-nicht.pdf' WHERE id='$A3';" >/dev/null
get "/api/v1/gobd-export?companyId=$C&year=2026" "$D/p.zip" >/dev/null
assert_eq "the export's report names both" \
  "$(jsonof "$D/p.zip" verification-report.json "sorted((p['file'], p['problem']) for p in d['summary']['belegeProblems'])")" \
  "[('rechnung.pdf', 'Inhalt weicht vom gespeicherten Hash ab'), ('richtig.pdf', 'Datei fehlt')]"
get "/api/v1/accounting/gobd-archive?companyId=$C&year=2026" "$D/q.zip" >/dev/null
assert_eq "…and the archive's manifest" "$(jsonof "$D/q.zip" MANIFEST.json "sorted(p['file'] for p in d['belegeProblems'])")" "['rechnung.pdf', 'richtig.pdf']"

summary
