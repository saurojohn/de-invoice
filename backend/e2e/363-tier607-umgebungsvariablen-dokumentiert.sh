#!/bin/bash
# Tier 607 — every environment variable the backend reads is documented
#
# Eleven variables were read in backend/src and named in no .env.example:
# where the uploads go (STORAGE_PATH), where backups go (BACKUP_ROOT), the
# keep-alive that has to stay above the proxy's, and three switches that
# must never be set in production. A static check: a `process.env.X` in the
# source needs a line for X in backend/.env.example or in
# infra/prod/.env.example — or a place in the short list of what the
# platform sets itself.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
REPORT=$(python3 - "$SCRIPT_DIR/.." <<'PY'
import os, re, sys
root = sys.argv[1]
used = set()
for dp, dn, fn in os.walk(os.path.join(root, 'src')):
    for f in fn:
        if not f.endswith('.ts') or f.endswith(('.test.ts', '.runner.ts')): continue
        s = open(os.path.join(dp, f), encoding='utf-8').read()
        used |= set(m.group(1) or m.group(2) for m in re.finditer(r"process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[[\x27\x22]([A-Z][A-Z0-9_]+)[\x27\x22]\]", s))
# the developer's example file, or the operator's
example = open(os.path.join(root, '.env.example'), encoding='utf-8').read() + open(os.path.join(root, '..', 'infra', 'prod', '.env.example'), encoding='utf-8').read()
documented = set(re.findall(r'^#?\s*([A-Z][A-Z0-9_]+)=', example, re.M))
# set by the platform or the test harness, not by an operator
PLATFORM = {'NODE_ENV', 'PORT', 'HOME', 'JAVA_HOME', 'PG_CONTAINER', 'TZ', 'CI'}
missing = sorted(used - documented - PLATFORM)
print(len(used)); print(','.join(missing) or '-')
PY
)
N=$(echo "$REPORT" | sed -n 1p)
[[ "$N" -ge 20 ]] && pass "found the variables the backend reads ($N)" || fail "only $N variables found — the check is looking in the wrong place"
assert_eq "each of them has a line in an .env.example (was: 11 without one)" "$(echo "$REPORT" | sed -n 2p)" "-"
assert_eq "the test switches are marked as such" "$(grep -c 'Test switches — never in production' "$SCRIPT_DIR/../.env.example")" "1"
assert_eq "production pins header authentication off" "$(grep -c 'ALLOW_HEADER_AUTH: "0"' "$SCRIPT_DIR/../../infra/prod/docker-compose.yml")" "1"
summary
