#!/bin/bash
# Tier 858 — the dependencies and the images are checked for known holes
#
# Security audit (18.11.2026), item 4: nothing looked at advisories. Measured
# that day with `npm audit --omit=dev`: the frontend ran Next.js 15.5.27 (a
# critical advisory: remote code execution through the image optimizer with
# SVG files, fixed in 15.5.29); the backend node-forge 1.4.0 (signature
# forgery, PKCS#12 MAC forgery, …), multer 2.4.0 and body-parser 2.3.0
# (denial of service) — ten high advisories, each with a fix.
#
# Now: the fixed versions; CI's `dependency-audit` job fails on a high or
# critical advisory of a production dependency (scripts/ci-npm-audit.mjs,
# exceptions with a reason and an end date in scripts/npm-audit-allow.json);
# the Docker images run scans each image with Trivy, pinned by digest.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GATE="$ROOT/scripts/ci-npm-audit.mjs"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
ver() { node -p "require('$ROOT/$1/package-lock.json').packages['node_modules/$2']?.version ?? '-'"; }
atleast() { node -e "const [a,b]=process.argv.slice(1).map(v=>v.split('.').map(Number));for(let i=0;i<3;i++){if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1)}" "$1" "$2" && echo yes || echo "no ($1)"; }

note "=== 1. the fixed versions are what the lock files install ==="
assert_eq "Next.js at least 15.5.29 (was 15.5.27: critical)" "$(atleast "$(ver frontend next)" 15.5.29)" "yes"
assert_eq "node-forge at least 1.4.3 (was 1.4.0)" "$(atleast "$(ver backend node-forge)" 1.4.3)" "yes"
assert_eq "multer at least 2.5.0, also under Nest (was 2.4.0)" "$(atleast "$(ver backend multer)" 2.5.0)/$(node -p "require('$ROOT/backend/package-lock.json').packages['node_modules/@nestjs/platform-express/node_modules/multer'] ? 'a second, older copy' : 'one'")" "yes/one"
assert_eq "body-parser at least 2.4.0 (was 2.3.0)" "$(atleast "$(ver backend body-parser)" 2.4.0)" "yes"

note "=== 2. the gate ==="
if ! npm ping >/dev/null 2>&1; then
  note "SKIP (gate runs): the npm registry is not reachable here"
else
  # (whether today's lock files pass is the dependency-audit job's to say — an
  # advisory published tomorrow would otherwise fail the end-to-end suite too)
  # a package with a known hole: a lock file of node-forge 1.4.0
  mkdir -p "$W/old" && echo '{"name":"t","version":"1.0.0","dependencies":{"node-forge":"1.4.0"}}' > "$W/old/package.json"
  (cd "$W/old" && npm install --package-lock-only --no-audit --no-fund >/dev/null 2>&1)
  OUT=$(node "$GATE" "$W/old" 2>&1); RC=$?
  assert_eq "node-forge 1.4.0: the run fails, naming it" "$RC/$(grep -c 'high     node-forge .*→ FAIL' <<<"$OUT" | awk '{print ($1>0)}')" "1/1"
  assert_eq "…moderate and low ones are listed, they do not fail" "$(grep -cE '(moderate|low) +node-forge .*→ listed' <<<"$OUT" | awk '{print ($1>0)}')" "1"
  IDS=$(grep -E 'high     node-forge .*→ FAIL' <<<"$OUT" | grep -oE 'GHSA-[a-z0-9-]+' | sort -u)
  python3 -c "import json,sys;print(json.dumps({'allow':[{'id':i,'package':'node-forge','reason':'spec 551','until':sys.argv[1]} for i in sys.argv[2:]]}))" 2099-12-31 $IDS > "$W/allow.json"
  OUT=$(AUDIT_ALLOW="$W/allow.json" node "$GATE" "$W/old" 2>&1); RC=$?
  assert_eq "with an exception for each: passes, says until when" "$RC/$(grep -c 'allowed until 2099-12-31: spec 551' <<<"$OUT" | awk '{print ($1>0)}')" "0/1"
  OUT=$(AUDIT_ALLOW="$W/allow.json" AUDIT_TODAY=2100-01-01 node "$GATE" "$W/old" 2>&1); RC=$?
  assert_eq "after the exception's date: fails again" "$RC/$(grep -c 'the exception ended on 2099-12-31' <<<"$OUT" | awk '{print ($1>0)}')" "1/1"
fi
assert_eq "every exception in the repository has a reason and a date at most half a year ahead" \
  "$(python3 -c "
import json,datetime,sys
a=json.load(open('$ROOT/scripts/npm-audit-allow.json'))['allow']
lim=(datetime.date.today()+datetime.timedelta(days=183)).isoformat()
print(sum(1 for x in a if not x.get('reason') or not x.get('until') or x['until']>lim))")" "0"

note "=== 3. CI runs it ==="
assert_eq "ci.yml: a dependency-audit job runs the gate on both packages" \
  "$(python3 -c "
import yaml
j=yaml.safe_load(open('$ROOT/.github/workflows/ci.yml'))['jobs'].get('dependency-audit',{})
print(any('ci-npm-audit.mjs backend frontend' in (s.get('run') or '') for s in j.get('steps',[])), bool(j.get('timeout-minutes')))")" "True True"
DB="$ROOT/.github/workflows/docker-build.yml"
assert_eq "docker-build.yml: each image scanned by Trivy, CRITICAL fails the run" \
  "$(grep -c 'scan --severity CRITICAL --exit-code 1' "$DB")/$(grep -c 'scan --severity HIGH --exit-code 0' "$DB")" "1/1"
assert_eq "…Trivy pinned by digest, never a moving tag or one of the malicious builds of March 2026" \
  "$(grep -cE 'TRIVY_IMAGE: aquasec/trivy:0\.69\.3@sha256:[0-9a-f]{64}$' "$DB")/$(grep -cE 'aquasec/trivy:(latest|0\.69\.[4-6])' "$DB")" "1/0"
summary
