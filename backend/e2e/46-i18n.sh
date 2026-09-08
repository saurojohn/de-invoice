#!/usr/bin/env bash
# e2e 46: i18n key completeness
#
# Verifies that every translation key
# used in the frontend code (`t("foo.bar")`
# calls) is present in all three locale
# files: de.json, en.json, zh.json.
#
# Why this test exists:
#   The t() function in src/components/useI18n.ts
#   silently returns the raw key string if a
#   translation is missing. That means a
#   missing key in en.json or zh.json shows
#   up as "common.delete" in the UI instead
#   of "Delete" or "删除" — easy to miss in
#   dev (which defaults to de) but a real
#   bug for English / Chinese users.
#
# Coverage:
#   1. Every t() call site in src/**/*.tsx
#      has a corresponding key in de.json,
#      en.json, AND zh.json
#   2. The 3 locale files are all valid
#      JSON (parseable)
#   3. The 3 locale files have the same
#      set of leaf keys — if a new
#      namespace is added in one file
#      and not the others, the structural
#      check catches it
#
# Implementation: the actual scanning is
# in two helper Python scripts
# (e2e/i18n_check.py + e2e/i18n_struct_check.py).
# Shell is the wrapper that counts pass/fail.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Tier 335: ${SCRIPT_DIR} not hardcoded dev-machine
# path. The CI runner has no /Users/shledergmbh/...
# so the previous default broke 46-i18n.sh
# immediately on its first assertion.
FRONTEND_DIR="${FRONTEND_DIR:-${SCRIPT_DIR}/../frontend}"
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

if [[ ! -d "$FRONTEND_DIR" ]]; then
  echo "FATAL: FRONTEND_DIR not found: $FRONTEND_DIR" >&2
  exit 1
fi

cd "$FRONTEND_DIR"

# 1. All 3 locale files are valid JSON
echo "=== JSON validity ==="
for loc in de en zh; do
  if python3 -c "import json; json.load(open('messages/${loc}.json'))" 2>/dev/null; then
    echo "  PASS: messages/${loc}.json is valid JSON"
    PASS=$((PASS+1))
  else
    echo "  FAIL: messages/${loc}.json is NOT valid JSON"
    FAIL=$((FAIL+1))
  fi
done

# 2. Every t() call has a key in all 3 files
echo
echo "=== t() key completeness ==="
if python3 "$SCRIPT_DIR/i18n_check.py" "$FRONTEND_DIR" 2>/tmp/i18n_check.err; then
  echo "  PASS: all t() keys exist in de.json, en.json, zh.json"
  PASS=$((PASS+1))
else
  echo "  FAIL: some t() keys are missing in one or more locale files"
  cat /tmp/i18n_check.err | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

# 3. Structural key set matches across locales
echo
echo "=== Structural key match ==="
if python3 "$SCRIPT_DIR/i18n_struct_check.py" "$FRONTEND_DIR" 2>/tmp/i18n_struct.err; then
  echo "  PASS: structural key set matches across de/en/zh"
  PASS=$((PASS+1))
else
  echo "  FAIL: structural mismatch across locale files"
  cat /tmp/i18n_struct.err | sed 's/^/    /'
  FAIL=$((FAIL+1))
fi

rm -f /tmp/i18n_check.err /tmp/i18n_struct.err

echo
echo "==== $PASS passed, $FAIL failed ===="
exit $FAIL
