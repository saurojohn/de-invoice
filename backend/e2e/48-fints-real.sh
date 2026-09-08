#!/usr/bin/env bash
# e2e 48: Real FinTS library integration
#
# Verifies the Tier 13 thin wrapper around
# the `fints` npm package
# (https://github.com/Prior99/fints) compiles
# and has the expected shape.
#
# We can't e2e test the real-mode path
# without a Sparkasse / DKB / Volksbank
# sandbox account (and the production
# banks are NOT publicly accessible).
# What we CAN test:
#
#   1. The `fints` package is installed
#      (package.json + node_modules check)
#   2. The fints-real.ts wrapper
#      compiles without TypeScript errors
#   3. The wrapper exposes the expected
#      class + methods
#   4. Instantiating FintsReal with a
#      fake config doesn't throw (it's
#      a thin wrapper; no I/O on
#      construction)
#
# Real-mode validation will require a
# sandbox bank account — see the
# `fints-real.ts` file's header for the
# steps to wire the wrapper into
# fints.service.ts once one is available.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Tier 335: ${SCRIPT_DIR} not hardcoded dev-machine
# path. Same fix as 46-i18n.sh — CI runner has no
# /Users/shledergmbh/... so the previous default
# crashed 48-fints-real.sh at startup.
BACKEND_DIR="${BACKEND_DIR:-${SCRIPT_DIR}/../backend}"
PASS=0
FAIL=0

assert() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $label (expected: $expected, got: $actual)"
    FAIL=$((FAIL+1))
  fi
}

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "FATAL: BACKEND_DIR not found: $BACKEND_DIR" >&2
  exit 1
fi

cd "$BACKEND_DIR"

# 1. fints package is installed
echo "=== Package installation ==="
PKG_PRESENT=$(python3 -c "
import json
p = json.load(open('package.json'))
deps = {**p.get('dependencies', {}), **p.get('devDependencies', {})}
print('1' if 'fints' in deps else '0')
")
assert "fints in package.json" "1" "$PKG_PRESENT"

if [[ ! -d node_modules/fints ]]; then
  echo "  FAIL: node_modules/fints does not exist"
  FAIL=$((FAIL+1))
else
  echo "  PASS: node_modules/fints exists"
  PASS=$((PASS+1))
fi

# 2. fints-real.ts compiles
echo
echo "=== Wrapper compilation ==="
TSC_OUT=$(npx tsc --noEmit 2>&1 | grep -v "main.ts(10,15)\|main.ts(16,7)" | grep -i "fints-real" | head -3)
if [[ -z "$TSC_OUT" ]]; then
  echo "  PASS: fints-real.ts compiles without TypeScript errors"
  PASS=$((PASS+1))
else
  echo "  FAIL: fints-real.ts has TypeScript errors"
  echo "$TSC_OUT" | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

# 3. Wrapper has the expected public surface
echo
echo "=== Public API surface ==="
SURFACE=$(node -e "
require('ts-node/register');
const m = require('./src/modules/fints/fints-real');
const expected = ['FintsReal', 'FintsAccount', 'FintsTransaction', 'FintsConnectionConfig'];
for (const name of expected) {
  console.log(name + '=' + (typeof m[name] === 'undefined' ? '0' : '1'));
}
" 2>&1 | tail -4)
for line in $SURFACE; do
  name="${line%%=*}"
  val="${line##*=}"
  if [[ "$name" == "FintsReal" ]]; then
    expected="1"  # class
  else
    expected="0"  # interfaces don't exist at runtime (TS only)
  fi
  if [[ "$name" == "FintsReal" ]]; then
    assert "class $name exists" "1" "$val"
  else
    # Interfaces are TypeScript-only; in compiled JS
    # they're erased. Just verify the file exists.
    if grep -q "interface $name" src/modules/fints/fints-real.ts; then
      echo "  PASS: interface $name declared in fints-real.ts"
      PASS=$((PASS+1))
    else
      echo "  FAIL: interface $name not found in fints-real.ts"
      FAIL=$((FAIL+1))
    fi
  fi
done

# 4. FintsReal can be instantiated without throwing
echo
echo "=== Instantiation smoke test ==="
node -e "
require('ts-node/register');
const { FintsReal } = require('./src/modules/fints/fints-real');
const c = new FintsReal({
  url: 'https://example.invalid/fints',
  blz: '12345678',
  username: 'test',
  pin: '12345',
});
console.log('FintsReal constructed: url=' + c.config.url);
" 2>&1 | tail -3 | head -1
if node -e "
require('ts-node/register');
const { FintsReal } = require('./src/modules/fints/fints-real');
const c = new FintsReal({
  url: 'https://example.invalid/fints',
  blz: '12345678',
  username: 'test',
  pin: '12345',
});
process.exit(c && c.config && c.config.url === 'https://example.invalid/fints' ? 0 : 1);
" 2>/dev/null; then
  echo "  PASS: FintsReal constructor accepts config without throwing"
  PASS=$((PASS+1))
else
  echo "  FAIL: FintsReal constructor failed"
  FAIL=$((FAIL+1))
fi

echo
echo "==== $PASS passed, $FAIL failed ===="
exit $FAIL
