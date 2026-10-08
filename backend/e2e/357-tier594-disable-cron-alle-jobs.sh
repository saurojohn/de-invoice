#!/bin/bash
# Tier 594 — DISABLE_CRON=1 switches off every scheduled job
#
# start.sh tells the developer: "To start without them: DISABLE_CRON=1". Four
# of the ten jobs did not look at it: the webhook retry worker (every minute),
# the FinTS sync (every four hours), the ECB rate refresh (nightly) and the
# AfA auto-booker (monthly) — which writes depreciation into the books of
# every company that has not opted out. A static check, like 176 / 177: each
# method under a @Cron / @Interval decorator must test the variable before it
# does anything.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
SRC="$SCRIPT_DIR/../src"
REPORT=$(python3 - "$SRC" <<'PY'
import os, re, sys
src = sys.argv[1]; jobs = []; bad = []
for dp, dn, fn in os.walk(src):
    for f in fn:
        if not f.endswith('.ts'): continue
        p = os.path.join(dp, f); lines = open(p, encoding='utf-8').read().split('\n')
        for i, l in enumerate(lines):
            if not re.match(r'^\s*@(Cron|Interval)\(', l): continue
            # the method the decorator belongs to, and the first statements of its body
            j = next((k for k in range(i, min(i + 12, len(lines))) if re.match(r'^\s*(public\s+|private\s+)?async\s+\w+\(', lines[k])), None)
            rel = os.path.relpath(p, src)
            if j is None: bad.append(rel + ': no method found under the decorator'); continue
            name = re.search(r'async\s+(\w+)\(', lines[j]).group(1)
            jobs.append(rel + ':' + name)
            head = '\n'.join(x for x in lines[j + 1:j + 14] if not x.strip().startswith(('//', '*', '/*')))
            first = [x.strip() for x in head.split('\n') if x.strip()][:1]
            if not first or 'DISABLE_CRON' not in first[0]: bad.append(rel + ':' + name)
print(len(jobs)); print(','.join(sorted(bad)) or '-')
PY
)
N=$(echo "$REPORT" | sed -n 1p); BAD=$(echo "$REPORT" | sed -n 2p)
[[ "$N" -ge 10 ]] && pass "found the scheduled jobs ($N)" || fail "only $N scheduled jobs found — the check is looking in the wrong place"
assert_eq "every scheduled job tests DISABLE_CRON first (was: 4 of 10 did not)" "$BAD" "-"
assert_eq "start.sh still tells how to start without them" "$(grep -c 'DISABLE_CRON=1 ./start.sh' "$SCRIPT_DIR/../../start.sh")" "2"
summary
