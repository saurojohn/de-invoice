#!/bin/bash
# Tier 754 — a Playwright spec takes the backend's address from E2E_API_URL
#
# 114 specs named http://localhost:3001 outright. On a developer's machine that
# port can be another project's server, so they could not be run locally at
# all, and on 31.10.2026 a run without the guard in front of them tried it.
# The address is written once per spec, as the fallback of E2E_API_URL.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
E2E="$SCRIPT_DIR/../../frontend/e2e"
HARD=$(grep -nE "localhost:300[01]|127\.0\.0\.1:300[01]" "$E2E"/*.spec.ts | grep -v "process.env.E2E_API_URL" | grep -vE ":[0-9]+:[[:space:]]*(//|\*|/\*)")
assert_eq "no spec names the port outside that fallback" "$(printf '%s' "$HARD" | head -3)" ""
LATE=$(grep -lE '\$\{(API|API_BASE|E2E_API)\}' "$E2E"/*.spec.ts | xargs grep -L "E2E_API_URL")
assert_eq "every spec that builds an address reads the variable" "$LATE" ""
# Code in page.evaluate runs in the browser: it does not see the spec's constant.
INBROWSER=$(python3 - "$E2E" <<'PY'
import glob, re, sys
hits = []
for p in glob.glob(sys.argv[1] + '/*.spec.ts'):
    s = open(p).read()
    for m in re.finditer(r'\.(evaluate|evaluateHandle|evaluateAll|addInitScript|waitForFunction)\(', s):
        i, d = m.end(), 1
        while i < len(s) and d:
            d += s[i] == '('; d -= s[i] == ')'; i += 1
        if re.search(r'\$\{(API|API_BASE|E2E_API)\}', s[m.end():i]):
            hits.append(p.split('/')[-1])
print(' '.join(sorted(set(hits))))
PY
)
assert_eq "no page.evaluate reads it from the spec's scope" "$INBROWSER" ""
summary
