#!/bin/bash
# Tier 869 — npm is not in the production images
#
# Trivy (Tier 858) listed ten HIGH advisories in both images, every one in the
# npm that the node base image brings along (sigstore, pacote, ip-address,
# brace-expansion, picomatch) — npm's own dependencies. The running programs
# never use npm: the frontend is `node server.js`, the backend `node
# dist/main.js`. Only `npx prisma …` is run in the backend container
# (RUNBOOK, restore.sh, the image check); a stand-in `npx` there runs the
# program's own tool from node_modules/.bin and nothing from the registry.
#
# The images themselves are checked in docker-build.yml; here the Dockerfiles
# and that check, and — when the image is here — the image.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
RM='rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack'
assert_eq "both runtime stages remove npm and corepack" \
  "$(awk '/AS runtime/{f=1} f' "$ROOT/backend/Dockerfile" | grep -c "$RM")/$(awk '/AS runtime/{f=1} f' "$ROOT/frontend/Dockerfile" | grep -c "$RM")" "1/1"
assert_eq "…as root, before the stage turns to app (spec 388: it never turns back)" \
  "$(awk '/AS runtime/{f=1} f' "$ROOT/backend/Dockerfile" | awk -v rm="$RM" 'index($0,rm){r=NR} /^USER app/{u=NR} END{print (r && u && r<u) ? "yes" : "no"}')" "yes"
assert_eq "the runtime stage runs prisma generate with the program's own prisma, not npx" \
  "$(awk '/AS runtime/{f=1} f' "$ROOT/backend/Dockerfile" | grep -v '^\s*#' | grep -c './node_modules/.bin/prisma generate')/$(awk '/AS runtime/{f=1} f' "$ROOT/backend/Dockerfile" | grep -v -E "^\s*#|^\s*'" | grep -c 'npx prisma')" "1/0"
assert_eq "the backend gets the npx stand-in for its own tools" \
  "$(grep -c 'exec "/app/node_modules/.bin/$tool" "$@"' "$ROOT/backend/Dockerfile")" "1"
DB="$ROOT/.github/workflows/docker-build.yml"
assert_eq "the image check asserts it: no npm, npx prisma works, npx runs nothing else" \
  "$(grep -c 'test ! -e /usr/local/lib/node_modules/npm' "$DB")/$(grep -c 'npx prisma --version' "$DB")/$(grep -c 'npx left-pad' "$DB")" "2/1/1"

IMG=de-invoice-backend:t869
if docker image inspect "$IMG" >/dev/null 2>&1; then
  OUT=$(docker run --rm --pull=never --network none --entrypoint sh "$IMG" -c '
    command -v npm >/dev/null && echo "npm: there" || echo "npm: gone"
    npx prisma --version 2>/dev/null | grep -q "^prisma" && echo "npx prisma: ok" || echo "npx prisma: broken"
    npx left-pad >/dev/null 2>&1 && echo "npx other: ran" || echo "npx other: refused"' 2>&1)
  assert_eq "the built image ($IMG): npm gone, npx prisma works, nothing else runs" "$(tr '\n' '|' <<<"$OUT")" "npm: gone|npx prisma: ok|npx other: refused|"
else
  note "(the image $IMG is not here — docker-build.yml checks the image)"
fi
summary
