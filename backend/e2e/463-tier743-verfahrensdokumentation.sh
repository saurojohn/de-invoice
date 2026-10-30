#!/bin/bash
# Tier 743 — the Verfahrensdokumentation says what the program does
#
# backend/assets/verfahrensdokumentation.md is a template built from the program (GoBD
# Rz. 151 ff.: general description, user, technical and operating
# documentation). It is only worth anything while it is true, so what can be
# checked mechanically is: every path it names exists, its figures are the
# program's. The same goes for the retention periods on the pages: since
# 01.01.2025 § 147 Abs. 3 AO has 10 years for books, 8 for Belege, 6 for letters;
# the pages said ten years for all of it, and „IP-Adresse (anonymisiert)",
# though sessions and the audit log hold it whole.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
DOC="$ROOT/backend/assets/verfahrensdokumentation.md"
has() { grep -qF -- "$2" "$1"; }
check() { # label file text
  if has "$2" "$3"; then pass "$1"; else fail "$1 — '$3' not in $(basename "$2")"; fi
}

note "=== 1. the parts the GoBD ask for ==="
for h in "## 1. Allgemeine Beschreibung" "## 2. Anwenderdokumentation" "## 3. Technische Systemdokumentation" "## 4. Betriebsdokumentation" "## 5. Internes Kontrollsystem" "## 6. Datenzugriff" "## 7. Grenzen des Programms" "## 8. Änderungshistorie"; do
  check "section: $h" "$DOC" "$h"
done

note "=== 2. every path it names exists ==="
MISSING=$(python3 - "$DOC" "$ROOT" <<'PY'
import os, re, sys
doc, root = sys.argv[1:3]
text = open(doc, encoding='utf-8').read()
paths = sorted(set(re.findall(r'`((?:backend|frontend|infra|docs)/[^`\s]+|[A-Z-]+\.md)`', text)))
print(len(paths), ' '.join(p for p in paths if not os.path.exists(os.path.join(root, p))))
PY
)
assert_eq "no named file is missing (of ${MISSING%% *})" "${MISSING#* }" ""

note "=== 3. its figures are the program's ==="
C="$ROOT/infra/prod/docker-compose.yml"
check "hourly backups" "$C" 'BACKUP_SCHEDULE:-@hourly'
check "30 daily" "$C" 'BACKUP_KEEP_DAYS:-30'
check "12 weekly" "$C" 'BACKUP_KEEP_WEEKS:-12'
check "120 monthly" "$C" 'BACKUP_KEEP_MONTHS:-120'
check "…as the document says" "$DOC" 'eine je Tag für 30 Tage, eine je Woche für 12 Wochen, eine je Monat für 120 Monate'
check "sessions end after 30 days" "$ROOT/backend/src/auth/user-session.service.ts" 'SESSION_TTL_DAYS = 30'
check "session rows go after 90 days" "$ROOT/backend/src/auth/user-session.service.ts" 'SESSION_RETENTION_DAYS = 90'
for r in admin accountant berater viewer auditor; do
  check "role $r in the program" "$ROOT/backend/src/modules/users/users.service.ts" "'$r'"
  check "role $r in the document" "$DOC" "\`$r\`"
done
assert_eq "no role beyond the five" "$(grep -cE "^  [A-Z]+: '[a-z]+'" "$ROOT/backend/src/modules/users/users.service.ts")" "5"
assert_eq "bank formats as the document says: no CSV" "$(grep -c "'mt940' | 'camt053'" "$ROOT/backend/src/modules/bank-import/parsers.ts")/$(grep -c 'CSV' <<<"$(grep -E 'Bankauszüge werden|^- Bank:' "$DOC")")" "1/0"
assert_eq "the sent mail: 500 characters of it, as the document says" \
  "$(grep -c 'text.slice(0, 500)' "$ROOT/backend/src/modules/invoice/invoice-email.service.ts")/$(grep -c 'die ersten 500 Zeichen' "$DOC")" "1/1"

note "=== 4. the retention periods on the pages ==="
M="$ROOT/frontend/messages"
for l in de en zh; do
  assert_eq "$l: no „ten years\" for invoices, no anonymised IP" \
    "$(python3 - "$M/$l.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
ds = d['legal']['datenschutz']
bad = []
t = ds['retentionText'] + d['gobd']['subtitle']
if not any(k in t for k in ('acht Jahre', 'eight years', '八年')): bad.append('no 8 years')
if not any(k in t for k in ('sechs Jahre', 'six years', '六年')): bad.append('no 6 years')
if '30 Tagen' in t or '30 days' in t or '30 天' in t: bad.append('the 30 days nothing does')
l = ds['dataTypesList']
if '(anonymisiert)' in l or '(anonymized)' in l or '(anonymised)' in l.split(';')[0] or '(匿名' in l: bad.append('anonymised IP')
print(bad)
PY
)" "[]"
done
check "the archive's manifest names the three periods" "$ROOT/backend/src/modules/accounting/gobd-archive.service.ts" 'Buchungsbelege 8 Jahre'

summary
