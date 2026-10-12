#!/bin/bash
# Tier 681 — the pages do not promise an ELSTER upload.
#
# The XML the UStVA and UStJA pages offer holds the declared amounts under
# their Kennzahlen. It is not built to a verified ELSTER schema, carries no
# signature, and nothing in the product submits it (elster.service.ts says
# so since Tier 417). The pages still said: „ELSTER-XML für
# Mein-ELSTER-Upload herunterladen“, „Native BMF-Datenlieferung-Paket für
# ELSTER-Upload. Seit 2024 ist UStJA verpflichtend über ELSTER einzureichen“
# (electronic filing has been the rule far longer, § 18 Abs. 3 UStG) and
# „gleiches Format wie Mein-ELSTER-Paste-Import“ — an import Mein ELSTER
# does not have.
#
# No database, no server: the texts of the three languages.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
FE="$SCRIPT_DIR/../../frontend"

OUT=$(python3 - "$FE" <<'PY'
import io, json, re, sys
fe = sys.argv[1]
# a text that names ELSTER together with an upload, a paste or an import of a file —
# unless it says that there is none
PROMISE = re.compile(r'ELSTER[^.。]*?(Upload|upload|Paste|paste-import|hochladen|上传|粘贴导入)|(上传到|导入) ?(Mein-)?ELSTER')
DENIAL = re.compile(r'[Kk]eine Datei zum Hochladen|[Nn]ot a file to upload|不是可上传的文件')
def walk(d, path=''):
    for k, v in d.items():
        p = f'{path}.{k}' if path else k
        if isinstance(v, dict):
            yield from walk(v, p)
        elif isinstance(v, str):
            yield p, v
bad = []
for lang in ('de', 'en', 'zh'):
    msgs = json.load(io.open(f'{fe}/messages/{lang}.json', encoding='utf-8'))
    for p, v in walk(msgs):
        for sentence in re.split(r'(?<=[.。])\s*', v):
            if PROMISE.search(sentence) and not DENIAL.search(sentence):
                bad.append(f'{lang}:{p}')
    for key in ('downloadElster', 'elsterTooltip'):
        if not msgs['ustva'].get(key): bad.append(f'{lang}:ustva.{key} missing')
    if 'Seit 2024' in msgs['ustja']['elsterXmlHint'] or 'Since 2024' in msgs['ustja']['elsterXmlHint'] or '自 2024' in msgs['ustja']['elsterXmlHint']:
        bad.append(f'{lang}:ustja.elsterXmlHint names 2024')
print(len(bad), ' '.join(sorted(set(bad))[:6]))
PY
)
assert_eq "no text promises an upload, a paste or an import into ELSTER" "$OUT" "0 "
for lang in de en zh; do
  python3 -c "
import io, json, sys
m = json.load(io.open(sys.argv[1], encoding='utf-8'))
t = m['ustva']['elsterTooltip'] + m['ustja']['elsterXmlHint']
sys.exit(0 if ('Mein ELSTER' in t and ('nicht nach dem ELSTER-Schema geprüft' in t or 'not been checked against the ELSTER schema' in t or '未按 ELSTER 的格式规范校验' in t)) else 1)" "$FE/messages/$lang.json" \
    && pass "$lang: the file is for copying into Mein ELSTER, and not checked against its schema — said" || fail "$lang: the hint does not say what the file is"
done
grep -q '"ELSTER-XML für Mein-ELSTER-Upload' "$FE/src/app/dashboard/accounting/ustva/page.tsx" && fail "the UStVA page still carries the old text as a fallback" || pass "no old text left in the page"
grep -q "NOT: an ELSTER upload" "$SCRIPT_DIR/../src/modules/reports/elster.service.ts" && pass "the service says the same" || fail "elster.service.ts no longer says what the file is not"

summary
