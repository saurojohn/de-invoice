#!/bin/bash
# Tier 572 — the packages with known vulnerabilities stay updated
#
# `npm audit --omit=dev` showed 12 findings in the backend and 5 in the
# frontend, one critical each: `proxy-addr` < 2.0.8 let a visitor pose as a
# trusted proxy by writing its address as IPv4-mapped IPv6 (the backend trusts
# the private ranges behind Caddy, so the per-visitor limits hang on it), and
# `next` 15.5.7. An audit needs the network and changes from day to day, so
# this only holds the floor: what the lockfiles resolve to may not fall back
# below the versions that fixed those findings.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
BACK="$SCRIPT_DIR/../package-lock.json"
FRONT="$SCRIPT_DIR/../../frontend/package-lock.json"
# floor <lockfile> <package> <minimum version> <label>
floor() {
  local got
  got=$(node -e '
    const [lock, name, min] = process.argv.slice(1)
    const pk = require(lock).packages
    const num = (v) => v.split("-")[0].split(".").map(Number)
    const below = (a, b) => { for (let i = 0; i < 3; i++) { if ((a[i]||0) !== (b[i]||0)) return (a[i]||0) < (b[i]||0) } return false }
    // every copy of the package, also the ones nested under another package
    const hits = Object.keys(pk).filter((k) => k === "node_modules/" + name || k.endsWith("/node_modules/" + name))
    if (!hits.length) { console.log("missing"); process.exit(0) }
    const bad = hits.filter((k) => below(num(pk[k].version), num(min)))
    console.log(bad.length ? "below: " + bad.map((k) => k + "@" + pk[k].version).join(", ") : "ok")
  ' "$1" "$2" "$3" 2>&1)
  assert_eq "$4: $2 is at least $3" "$got" "ok"
}
floor "$BACK" proxy-addr 2.0.8 backend
floor "$BACK" multer 2.4.0 backend
floor "$BACK" nodemailer 10.0.16 backend
floor "$BACK" @nestjs/platform-express 11.2.7 backend
floor "$BACK" qs 6.14.1 backend
floor "$FRONT" next 15.5.27 frontend
floor "$FRONT" postcss 8.5.23 frontend
# the old fetch library the FinTS package asked for is gone
assert_eq "backend: no node-fetch 1.x left" "$(node -e '
  const pk = require(process.argv[1]).packages
  console.log(Object.keys(pk).filter((k) => k.endsWith("node_modules/node-fetch") && pk[k].version.startsWith("1.")).length)' "$BACK")" "0"
summary
