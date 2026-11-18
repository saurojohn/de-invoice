#!/bin/bash
# Tier 855 — the production backend does not start with a configuration that
# switches a protection off (security audit of 18.11.2026).
#
# Before: FINTS_PIN_ENC_KEY empty — SMTP passwords stored as typed; SETUP_TOKEN
# empty (a deploy without HETZNER-DEPLOY.sh) — the first visitor of a new
# installation became its owner; ALLOW_HEADER_AUTH=1, THROTTLE_DISABLED=1 or a
# mock of VIES / the ECB / the bank — all accepted without a word.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
check() { # env assignments… → the problems found, by their variable, or "ok"
  # ts-node itself, not npx: under NODE_ENV=production npx printed an „npm notice“
  # after the answer in CI (run 44198898442), and that was read as the result
  (cd "$SCRIPT_DIR/.." && env -i PATH="$PATH" HOME="$HOME" "$@" ./node_modules/.bin/ts-node -T -e "
const { productionConfigProblems } = require('./src/common/production-config')
const p = productionConfigProblems(process.env)
console.log(p.length ? p.map((x: string) => x.split(/[ =]/)[0]).join(' ') : 'ok')" 2>&1 | tail -1)
}
KEY=0123456789abcdef0123456789abcdef
SAFE=(NODE_ENV=production FINTS_PIN_ENC_KEY=$KEY SETUP_TOKEN=abc123)

note "=== 1. the check ==="
assert_eq "a safe production configuration starts" "$(check "${SAFE[@]}")" "ok"
assert_eq "without the key and the setup token: refused (was: started, passwords as typed)" "$(check NODE_ENV=production)" "FINTS_PIN_ENC_KEY SETUP_TOKEN"
assert_eq "a key shorter than 32 characters: refused" "$(check NODE_ENV=production FINTS_PIN_ENC_KEY=short SETUP_TOKEN=abc123)" "FINTS_PIN_ENC_KEY"
assert_eq "ALLOW_HEADER_AUTH=1: refused" "$(check "${SAFE[@]}" ALLOW_HEADER_AUTH=1)" "ALLOW_HEADER_AUTH"
assert_eq "THROTTLE_DISABLED=1: refused" "$(check "${SAFE[@]}" THROTTLE_DISABLED=1)" "THROTTLE_DISABLED"
assert_eq "a mocked VIES, ECB or bank: refused" "$(check "${SAFE[@]}" VIES_MOCK=1 EXCHANGE_RATES_MOCK=1 FINTS_ALLOW_MOCK=1)" "VIES_MOCK EXCHANGE_RATES_MOCK FINTS_ALLOW_MOCK"
assert_eq "…unless it is a drill on the production images (PRODUCTION_DRILL=1)" "$(check "${SAFE[@]}" VIES_MOCK=1 EXCHANGE_RATES_MOCK=1 PRODUCTION_DRILL=1)" "ok"
assert_eq "…which does not let the rest through" "$(check NODE_ENV=production VIES_MOCK=1 PRODUCTION_DRILL=1 THROTTLE_DISABLED=1)" "FINTS_PIN_ENC_KEY SETUP_TOKEN THROTTLE_DISABLED"
assert_eq "ALLOW_HEADER_AUTH=0 and the mocks at 0 are fine" "$(check "${SAFE[@]}" ALLOW_HEADER_AUTH=0 VIES_MOCK=0 FINTS_ALLOW_MOCK=0)" "ok"
assert_eq "outside production nothing is checked (development, CI, the specs)" "$(check NODE_ENV=test ALLOW_HEADER_AUTH=1 VIES_MOCK=1)" "ok"
grep -q "productionConfigProblems()" "$SCRIPT_DIR/../src/main.ts" && grep -q "process.exit(1)" "$SCRIPT_DIR/../src/main.ts" \
  && pass "main.ts runs the check before the app is created and exits" || fail "main.ts does not run the check"

note "=== 2. the deployment ==="
C="$ROOT/infra/prod/docker-compose.yml"
grep -q 'FINTS_PIN_ENC_KEY: ${FINTS_PIN_ENC_KEY:?' "$C" && grep -q 'SETUP_TOKEN: ${SETUP_TOKEN:?' "$C" \
  && pass "compose requires FINTS_PIN_ENC_KEY and SETUP_TOKEN (was: empty allowed)" || fail "compose still allows them empty"
D="$ROOT/infra/prod/HETZNER-DEPLOY.sh"
grep -q "FINTS_PIN_ENC_KEY=%s" "$D" && grep -q "if ! grep -qE '^FINTS_PIN_ENC_KEY=\[^ \]{32,}'" "$D" \
  && pass "the deploy writes a key only when there is none (a key that changes loses every sealed password)" || fail "the deploy does not write the key"
bash -n "$D" && pass "HETZNER-DEPLOY.sh parses" || fail "HETZNER-DEPLOY.sh has a syntax error"
# the deploy's key step against a scratch .env: none → one written; one there → left alone
T=$(mktemp -d); mkdir -p "$T/infra/prod"
STEP=$(sed -n '/^# Tier 855: the key that seals/,/^fi$/p' "$D")
run_step() { (cd "$T" && log() { :; }; die() { echo "DIE $*"; exit 1; }; eval "$STEP"); }
printf 'POSTGRES_PASSWORD=x\nFINTS_PIN_ENC_KEY=\n' > "$T/infra/prod/.env"; run_step
assert_eq "an empty key line: replaced by one key of 64 hex characters" "$(grep -cE '^FINTS_PIN_ENC_KEY=[0-9a-f]{64}$' "$T/infra/prod/.env")/$(grep -c '^FINTS_PIN_ENC_KEY=' "$T/infra/prod/.env")" "1/1"
FIRST=$(grep '^FINTS_PIN_ENC_KEY=' "$T/infra/prod/.env"); run_step
assert_eq "run again: the same key (never rotated)" "$(grep '^FINTS_PIN_ENC_KEY=' "$T/infra/prod/.env")" "$FIRST"
printf 'FINTS_PIN_ENC_KEY=tooshort\n' > "$T/infra/prod/.env"
assert_eq "a key too short: the deploy stops instead of replacing it" "$(run_step | grep -c '^DIE')" "1"
rm -rf "$T"
grep -q "FINTS_PIN_ENC_KEY=ci-only" "$ROOT/.github/workflows/docker-build.yml" && grep -q "the production image started without FINTS_PIN_ENC_KEY" "$ROOT/.github/workflows/docker-build.yml" \
  && pass "the image build starts the image with them, and checks it refuses without them" || fail "docker-build.yml does not check the refusal"
summary
