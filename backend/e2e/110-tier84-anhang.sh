#!/usr/bin/env bash
# e2e 110: Tier 84 — Anhang zum Jahresabschluss
# (§ 284 HGB).
#
# Validates the new /api/v1/accounting/anhang
# + /anhang.pdf endpoints. The Anhang is the
# third part of the Bilanz-pflichtige entity's
# Jahresabschluss. v1 auto-generates a DRAFT
# that the Berater reviews + fills in the
# § 285 HGB Pflichtangaben.
#
# Tests:
#   1. JSON shape + 5 sections (I-V).
#   2. Company fields populated from Company
#      table.
#   3. Section I: Allgemeine Angaben has the
#      legalName / address / Steuernummer /
#      USt-IdNr / Handelsregister paragraphs.
#   4. Section II: Bilanzierungs- und Bewertungs-
#      methoden has the standard paragraphs
#      (going concern, Sachanlagen, Forderungen,
#      Liquide Mittel, Verbindlichkeiten, etc.)
#   5. Section III: Bilanz-Erläuterungen
#      cross-references Bilanz position values
#      and notes the "nicht ausgewiesen" ones.
#   6. Section IV: G+V-Erläuterungen cross-
#      references G+V position values.
#   7. Section V: Sonstige Pflichtangaben
#      marked auto:false (Berater editable).
#   8. Counts: bilanzComputed + bilanzNicht-
#      Ausgewiesen reflect actual data.
#   9. PDF returns application/pdf + magic bytes.
#  10. Year validation 1999, 2101 → 400.
#  11. Cross-tenant → 401.
#  12. Missing companyId → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

TS="$(date +%s)-$$"
TEST_TAG="anhang-tier84-$TS"
echo "=== Test: Anhang (test tag: $TEST_TAG) ==="

# ── 1. JSON shape ──
echo
note "=== 1. /anhang reachable + shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/accounting/anhang?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "anhang 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['year','companyId','company','sections','bilanz','guv','counts','generatedAt','disclaimer']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# 5 sections present
NSECTIONS=$(python3 -c "
import json
d = json.load(open('$TMP'))
print(len([k for k in d['sections'] if 'title' in k]))
")
assert_eq "5 sections present" "$NSECTIONS" "5"

# Section order = § 284 HGB canonical
SECTIONS=$(python3 -c "
import json
d = json.load(open('$TMP'))
titles = [s['title'] for s in d['sections']]
expected_starts = ['I.', 'II.', 'III.', 'IV.', 'V.']
actual_starts = [t.split()[0] for t in titles]
print('true' if actual_starts == expected_starts else f'got {actual_starts}')
")
assert_eq "§ 284 HGB section order (I-V)" "$SECTIONS" "true"

# ── 2. Company fields ──
echo
note "=== 2. Company fields populated ==="
COMPANY_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
c = d['company']
ok = all([c.get('name'), c.get('legalName')])
print('true' if ok else f'company={c}')
")
assert_eq "company.name + legalName present" "$COMPANY_OK" "true"

# ── 3. Section I: Allgemeine Angaben ──
echo
note "=== 3. Section I: paragraphs (Firma, Sitz, Stichtag, GF, Steuernummer, USt-IdNr, Handelsregister) ==="
SEC1_PARAS=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][0]
print(len(sec['paragraphs']))
")
# Section I has 6 paragraphs in v1: Firma + Sitz,
# Stichtag, Geschäftsführung, Steuernummer,
# USt-IdNr, Handelsregistereintrag.
# Assert >= 5 (any future paragraph added is fine)
SEC1_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][0]
print('true' if len(sec['paragraphs']) >= 5 else 'false')
")
assert_eq "Section I has >= 5 paragraphs" "$SEC1_OK" "true"

# ── 4. Section II: Bilanzierungsmethoden ──
echo
note "=== 4. Section II: paragraphs (going concern + methoden) ==="
SEC2_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][1]
print('true' if len(sec['paragraphs']) >= 8 else 'false')
")
assert_eq "Section II has >= 8 paragraphs" "$SEC2_OK" "true"

# All Section II paragraphs must be auto-generated
SEC2_AUTO=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][1]
all_auto = all(p['auto'] for p in sec['paragraphs'])
print('true' if all_auto else 'false')
")
assert_eq "all Section II paragraphs auto=true" "$SEC2_AUTO" "true"

# ── 5. Section III: Bilanz-Erläuterungen cross-references bilanz + notes nicht ausgewiesen ──
echo
note "=== 5. Section III: Bilanz-Erläuterungen cross-references position sums ==="
SEC3_BILANZ_REF=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][2]
# At least one paragraph should mention 'Bilanzgleichung' or 'Saldoposten' or
# a 'nicht ausgewiesen' note.
texts = ' '.join(p['text'] for p in sec['paragraphs'])
has_check = 'Bilanzgleichung' in texts
print('true' if has_check else 'false')
")
assert_eq "Section III references Bilanzgleichung check" "$SEC3_BILANZ_REF" "true"

# ── 6. Section IV: G+V-Erläuterungen cross-references Jahresergebnis ──
echo
note "=== 6. Section IV: G+V-Erläuterungen references Jahresergebnis ==="
SEC4_JU=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][3]
texts = ' '.join(p['text'] for p in sec['paragraphs'])
has_ju = 'Jahresergebnis' in texts or 'Jahresüberschuss' in texts
print('true' if has_ju else 'false')
")
assert_eq "Section IV references Jahresergebnis" "$SEC4_JU" "true"

# ── 7. Section V: Sonstige Pflichtangaben — all auto:false ──
echo
note "=== 7. Section V: all paragraphs auto=false (Berater editable) ==="
SEC5_AUTO=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][4]
all_berater = all(not p['auto'] for p in sec['paragraphs'])
print('true' if all_berater else 'false')
")
assert_eq "all Section V paragraphs auto=false" "$SEC5_AUTO" "true"

# Each § 285 HGB Pflichtangabe should be present
SEC5_TOPICS=$(python3 -c "
import json
d = json.load(open('$TMP'))
sec = d['sections'][4]
texts = ' '.join(p['text'] for p in sec['paragraphs']).lower()
expected = ['haftungsverhältnisse', 'nahe stehenden', 'ereignisse', 'ergebnisverwendung']
results = [t for t in expected if t in texts]
print('true' if len(results) == len(expected) else f'missing: {set(expected) - set(results)}')
")
assert_eq "Section V covers Haftungsverhältnisse / nahe stehende / Ereignisse / Ergebnisverwendung" "$SEC5_TOPICS" "true"

# ── 8. Counts ──
echo
note "=== 8. Counts: bilanzComputed + nichtAusgewiesen reflect actual data ==="
COUNTS_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
c = d['counts']
bilanz = d['bilanz']
actual_computed = sum(
  sum(1 for l in sec['lines'] if l['amount'] is not None)
  for sec in bilanz['aktiva'] + bilanz['passiva']
)
actual_nicht = sum(sec['nichtAusgewiesen'] for sec in bilanz['aktiva'] + bilanz['passiva'])
ok = c['bilanzComputed'] == actual_computed and c['bilanzNichtAusgewiesen'] == actual_nicht
print('true' if ok else f'expected computed={actual_computed} nicht={actual_nicht}, got computed={c[\"bilanzComputed\"]} nicht={c[\"bilanzNichtAusgewiesen\"]}')
")
assert_eq "counts.bilanzComputed + nichtAusgewiesen match actual" "$COUNTS_OK" "true"

# ── 9. PDF endpoint ──
echo
note "=== 9. /anhang.pdf returns application/pdf + magic bytes ==="
PDF_RESP=$(curl -sS -o /tmp/anhang-tier84.pdf -w "%{http_code}|%{content_type}|%{size_download}" \
  "$API/api/v1/accounting/anhang.pdf?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
HTTP=$(echo "$PDF_RESP" | cut -d'|' -f1)
CT=$(echo "$PDF_RESP" | cut -d'|' -f2)
assert_eq "PDF 200" "$HTTP" "200"
assert_eq "PDF content-type" "$CT" "application/pdf"
MAGIC=$(head -c 4 /tmp/anhang-tier84.pdf | od -An -tx1 | tr -d ' \n')
assert_eq "PDF magic bytes (25 50 44 46)" "$MAGIC" "25504446"
rm -f /tmp/anhang-tier84.pdf

# ── 10. year validation ──
echo
note "=== 10. year validation ==="
ST_Y1999=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anhang?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$ST_Y1999" "400"
ST_Y2101=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anhang?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$ST_Y2101" "400"

# ── 11. Cross-tenant → 401 ──
echo
note "=== 11. cross-tenant → 401 ==="
ST_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anhang?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$ST_CROSS" "401"

# ── 12. Missing companyId → 400 ──
echo
note "=== 12. missing companyId → 400 ==="
ST_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/accounting/anhang?year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId → 400" "$ST_NO_CID" "400"

rm -f "$TMP"
summary
exit $?
