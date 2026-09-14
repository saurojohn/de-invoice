#!/bin/bash
# Tier 370 — the spec harness itself must be able to fail
#
# run-all.sh judges a spec by its exit code and nothing else. Tier 370 found
# specs that could not produce a non-zero exit code no matter what broke:
#
#   1. Counter mismatch. _lib.sh's fail() / assert_eq / assert_status bump the
#      LIB counter FAILS. 55-fints-real-integration sourced _lib.sh and used
#      those helpers, but also declared its own PASS=0 / FAIL=0 and ended with
#      `exit $FAIL` — a variable nothing ever incremented. Every failed
#      assertion was printed, then discarded. It even printed `lib FAILS=` in
#      its summary line: the divergence had been noticed, the exit code not.
#   2. `summary` then `exit 0`. summary() returns 1 after a failure, and a
#      following `exit 0` throws that away. 22-mahnung-cron did this in its
#      throttled branch, after two assert_eq calls had already run.
#
# Both were fixed. The full suite stayed green with lib=0, so the defect was
# real but latent. This spec exists so the shapes cannot return unnoticed.
#
# A correction worth keeping: the first pass also "fixed" 44-rbac and
# 47-journal-cap. Both were fine — neither loads _lib.sh; each defines its own
# assert_eq that bumps its own FAIL, so `exit $FAIL` was correct. The survey
# that flagged them used `grep -c "source.*_lib"`, which matched a COMMENT
# ("this script does not source _lib.sh"). Rule 1 below therefore requires a
# real, non-comment `source`/`.` line before a spec counts as lib-using. The
# mistake was caught by injecting the old shape into a copy of the tree and
# watching which rules fired: an injected 44 was (correctly) ignored, an
# injected 55 was flagged.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
SELF="$(basename "$0")"
cd "$SCRIPT_DIR"

note "=== 1. no spec uses lib assertions but exits on its own counter ==="
MISMATCH=0
CHECKED=0
for f in [0-9][0-9]-*.sh [0-9][0-9][0-9]-*.sh; do
  [[ "$f" == "$SELF" ]] && continue
  # A real, non-comment `source` or `.` line — a comment that merely mentions
  # _lib.sh must not count (that is exactly how 44/47 were misjudged).
  grep -qE '^[[:space:]]*(source|\.)[[:space:]].*_lib\.sh' "$f" || continue
  # A spec that defines its own fail() owns its counter; its exit $FAIL is right.
  grep -qE '^[[:space:]]*fail[[:space:]]*\(\)' "$f" && continue
  # Only specs that call the lib helpers (which bump FAILS) are at risk.
  grep -qE '^[[:space:]]*(fail|assert_eq|assert_status)[[:space:]]' "$f" || continue
  CHECKED=$((CHECKED + 1))
  if grep -qE '^[[:space:]]*exit[[:space:]]+\$\{?FAIL\}?[[:space:]]*$' "$f"; then
    fail "$f uses _lib.sh assertions (they bump FAILS) but exits on \$FAIL alone — its failures can never fail the suite"
    MISMATCH=$((MISMATCH + 1))
  fi
done
[[ $MISMATCH -eq 0 ]] && pass "no counter mismatch ($CHECKED lib-assertion specs checked)"

note "=== 2. no spec throws away summary's return value with exit 0 ==="
SWALLOW=$(awk '
  prev ~ /^[[:space:]]*summary[[:space:]]*$/ && $0 ~ /^[[:space:]]*exit[[:space:]]+0[[:space:]]*$/ {
    print FILENAME ":" FNR
  }
  FNR == 1 { prev = "" }
  $0 !~ /^[[:space:]]*(#|$)/ { prev = $0 }
' $(ls [0-9][0-9]-*.sh [0-9][0-9][0-9]-*.sh | grep -vx "$SELF"))
if [[ -z "$SWALLOW" ]]; then
  pass "no 'summary' immediately followed by 'exit 0'"
else
  fail "summary's return value discarded by exit 0 at: $(echo "$SWALLOW" | tr '\n' ' ')"
fi

note "=== 3. the _lib.sh semantics the fix relies on ==="
# Run each probe in a fresh bash so this spec's own FAILS is untouched.
PROBE=$(mktemp)
printf 'source "%s"\nfail probe\nsummary\n' "$SCRIPT_DIR/_lib.sh" > "$PROBE"
bash "$PROBE" >/dev/null 2>&1 < /dev/null
assert_eq "summary() returns non-zero after a lib fail()" "$([[ $? -ne 0 ]] && echo yes || echo no)" "yes"

printf 'source "%s"\nPASS=0; FAIL=0\nfail probe\nexit $(( FAIL + ${FAILS:-0} ))\n' "$SCRIPT_DIR/_lib.sh" > "$PROBE"
bash "$PROBE" >/dev/null 2>&1 < /dev/null
assert_eq "exit \$(( FAIL + FAILS )) is non-zero after a lib fail()" "$([[ $? -ne 0 ]] && echo yes || echo no)" "yes"

printf 'source "%s"\nPASS=0; FAIL=0\npass probe\nexit $(( FAIL + ${FAILS:-0} ))\n' "$SCRIPT_DIR/_lib.sh" > "$PROBE"
bash "$PROBE" >/dev/null 2>&1 < /dev/null
assert_eq "the same exit is zero when nothing failed" "$([[ $? -eq 0 ]] && echo yes || echo no)" "yes"
rm -f "$PROBE"

summary
