#!/bin/bash
# Tier 929 — the images' Debian packages are never older than a day
#
# The workflows build with the GitHub Actions cache (cache-from: type=gha):
# the apt layer of the runtime stage was reused from the day it was first
# built. Measured: the "Docker images" run of Tier 919 and Tier 928 failed —
# the backend image held openjdk-17-jre-headless 17.0.21+9 with three
# CRITICAL CVEs (CVE-2026-114820, -114938, -91403) whose fixes Debian had
# released; the production images (release.yml) would have shipped it.
# Now the build day goes into that layer (ARG APT_REFRESH), with an
# apt-get upgrade: a cached layer serves a day at most.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."

layer() { # Dockerfile → the RUN of the runtime stage that installs packages, with its ARG
  python3 - "$1" <<'PY'
import sys,re
s=open(sys.argv[1]).read()
rt=s[s.index(' AS runtime'):]
lines=rt.split('\n')
run=''
for i,l in enumerate(lines):
    if l.strip()=='ARG APT_REFRESH=' and i+1 < len(lines) and lines[i+1].startswith('RUN '):
        j=i+1
        while True:
            run+=lines[j]+'\n'
            if not lines[j].rstrip().endswith('\\'): break
            j+=1
        break
print('yes' if '${APT_REFRESH' in run and 'apt-get upgrade' in run and 'apt-get install' in run else 'no')
PY
}
assert_eq "backend/Dockerfile: the runtime's apt layer depends on APT_REFRESH and upgrades" "$(layer "$ROOT/backend/Dockerfile")" "yes"
assert_eq "frontend/Dockerfile: the same" "$(layer "$ROOT/frontend/Dockerfile")" "yes"
for wf in docker-build.yml release.yml; do
  f="$ROOT/.github/workflows/$wf"
  assert_eq "$wf: the build day computed" "$(grep -c 'echo "day=$(date -u +%F)" >> "$GITHUB_OUTPUT"' "$f")" "1"
  assert_eq "$wf: …and passed as APT_REFRESH" "$(grep -c 'APT_REFRESH=${{ steps.day.outputs.day }}' "$f")" "1"
done

summary
