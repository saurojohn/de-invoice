#!/bin/bash
# Tier 654 — the containers run without root's powers
#
# §9 item 23/24: "the backend container runs as root, the compose file sets no
# read_only / cap_drop / no-new-privileges". The Dockerfile created a user
# `app` and then switched back to root three times, with a comment that a
# named volume comes up root-owned. A new named volume takes the owner of the
# directory it is mounted over — so the image makes that directory `app`'s.
#
# Tried on 10.10.2026 with the images on this machine, each started with the
# options the compose file now sets: PostgreSQL initialises and answers; the
# backend applies its migrations (`npx prisma migrate deploy`), answers
# /health/deep, writes an invoice PDF into the volume, runs the KoSIT
# validator (Java, /tmp in memory) — as uid 100, CapEff 0, NoNewPrivs 1, root
# filesystem read-only; the frontend serves; Caddy listens on 80; the backup
# writes a dump. The Docker workflow repeats the backend and frontend part on
# every change of the images.
#
# This spec holds what does not need Docker: the files say so, and the
# entrypoint behaves.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
TMP=$(mktemp -d); trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
DF="$ROOT/backend/Dockerfile"; DC="$ROOT/infra/prod/docker-compose.yml"; EP="$ROOT/backend/docker-entrypoint.sh"

note "=== 1. the backend image ==="
# the instructions of the last stage, comments left out
awk '/^FROM .* AS runtime/{on=1} on' "$DF" | grep -v '^\s*#' > "$TMP/runtime.txt"
assert_eq "the runtime stage's last USER is app (was: root, three times)" "$(grep '^USER ' "$TMP/runtime.txt" | tail -1)" "USER app"
assert_eq "it never switches to root" "$(grep -c '^USER root' "$TMP/runtime.txt")" "0"
grep -q 'mkdir -p /data/invoice-system && chown app:app /data/invoice-system' "$TMP/runtime.txt" \
  && pass "the storage directory is app's in the image — a new volume takes that owner" || fail "the image does not hand /data/invoice-system to app"
assert_eq "the entrypoint is the script" "$(grep '^ENTRYPOINT' "$TMP/runtime.txt")" 'ENTRYPOINT ["/app/docker-entrypoint.sh"]'
assert_eq "the command is the compiled program" "$(grep '^CMD' "$TMP/runtime.txt")" 'CMD ["node", "--enable-source-maps", "dist/main.js"]'
grep -q 'NPM_CONFIG_CACHE=/tmp/.npm' "$TMP/runtime.txt" && pass "npm's cache is under /tmp (the root filesystem is read-only)" || fail "no npm cache under /tmp"
assert_eq "the frontend image runs as app too" "$(grep '^USER ' "$ROOT/frontend/Dockerfile" | tail -1)" "USER app"

note "=== 2. the entrypoint ==="
[[ -x "$EP" ]] && pass "docker-entrypoint.sh is executable" || fail "docker-entrypoint.sh is not executable"
sh -n "$EP" && pass "… and parses" || fail "docker-entrypoint.sh does not parse"
if [[ "$(id -u)" != "0" ]]; then
  mkdir "$TMP/storage"
  OUT=$(STORAGE_PATH="$TMP/storage" sh "$EP" sh -c 'echo "ran as $(id -u)"' 2>&1); RC=$?
  assert_eq "a storage directory it can write: the command runs" "$RC $OUT" "0 ran as $(id -u)"
  chmod 0555 "$TMP/storage"
  OUT=$(STORAGE_PATH="$TMP/storage" sh "$EP" sh -c 'echo ran' 2>&1); RC=$?
  assert_eq "one it cannot write: it does not start" "$RC" "1"
  echo "$OUT" | grep -q "is not writable by" && echo "$OUT" | grep -q -- "--user root --cap-add CHOWN" && ! echo "$OUT" | grep -q "^ran" \
    && pass "… and says which run hands the volume over" || fail "the refusal: $OUT"
  OUT=$(STORAGE_PATH="$TMP/none" sh "$EP" sh -c 'echo ran' 2>&1); RC=$?
  assert_eq "no storage directory at all: it does not start" "$RC" "1"
else
  note "running as root — the unprivileged cases of the entrypoint are tried by the Docker workflow"
fi
grep -q 'exec setpriv --reuid=app --regid=app --init-groups "\$@"' "$EP" \
  && pass "started as root, it hands the storage over and runs as app all the same" || fail "no step down from root"

note "=== 3. the compose file ==="
python3 - "$DC" > "$TMP/services.txt" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
body = text.split('\nservices:\n', 1)[1]
body = re.split(r'\n(?=\S)', body, 1)[0]          # up to the next top-level key
blocks = re.split(r'\n(?=  [a-z][a-z0-9_-]*:\s*\n)', '\n' + body)
for b in blocks:
    m = re.match(r'\n?  ([a-z][a-z0-9_-]*):\s*\n', b)
    if not m: continue
    lines = [l for l in b.split('\n') if not l.strip().startswith('#')]
    t = '\n'.join(lines)
    add = re.search(r'^    cap_add: \[(.*)\]', t, re.M)
    print(m.group(1),
          'ro' if re.search(r'^    read_only: true', t, re.M) else 'RW',
          'drop' if re.search(r'^    cap_drop: \[ALL\]', t, re.M) else 'CAPS',
          'nnp' if re.search(r'^      - no-new-privileges:true', t, re.M) else 'NEWPRIV',
          'tmp' if re.search(r'^      - /tmp$', t, re.M) else 'NOTMP',
          (add.group(1).replace(' ', '') if add else '-'),
          'user:' + (re.search(r'^    user: (.*)', t, re.M).group(1) if re.search(r'^    user: ', t, re.M) else '-'))
PY
assert_eq "five services" "$(wc -l < "$TMP/services.txt" | tr -d ' ')" "5"
assert_eq "each read-only, without capabilities, without new privileges, /tmp in memory (was: none of it)" \
  "$(awk '{print $2, $3, $4, $5}' "$TMP/services.txt" | sort -u)" "ro drop nnp tmp"
assert_eq "what is added back: binding ports for Caddy, the data directory for PostgreSQL — nothing for the others" \
  "$(awk '{print $1":"$6}' "$TMP/services.txt" | sort | tr '\n' ' ')" "backend:- backup:- caddy:NET_BIND_SERVICE frontend:- postgres:CHOWN,DAC_OVERRIDE,FOWNER,SETGID,SETUID "
assert_eq "no service asks for root or another user" "$(awk '{print $7}' "$TMP/services.txt" | sort -u)" "user:-"
grep -q '^    privileged: true' "$DC" && fail "a privileged service" || pass "none is privileged"
grep -A12 '^  frontend:' "$DC" >/dev/null; grep -q '^      - /app/.next/cache$' "$DC" && pass "the frontend's cache is in memory" || fail "no tmpfs for .next/cache"
grep -q '^      - /var/run/postgresql$' "$DC" && pass "PostgreSQL's socket directory is in memory" || fail "no tmpfs for /var/run/postgresql"

note "=== 4. what tries it ==="
WF="$ROOT/.github/workflows/docker-build.yml"
grep -q "Run the backend image hardened" "$WF" && grep -q -- '--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true' "$WF" \
  && pass "the Docker workflow starts the backend image with these options" || fail "the workflow does not run the image hardened"
grep -q "npx prisma migrate deploy" "$WF" && grep -q 'is not writable by app' "$WF" \
  && pass "… runs the migrations in it, and tries the volume that belongs to root" || fail "the workflow misses the migration or the root-owned volume"
grep -q "backend/docker-entrypoint.sh" "$WF" && grep -q "infra/prod/docker-compose.yml" "$WF" \
  && pass "… and runs when the entrypoint or the compose file change" || fail "the workflow's paths miss the entrypoint or the compose file"
grep -q "prisma generate" "$ROOT/infra/prod/HETZNER-DEPLOY.sh" | grep -v '^\s*#' >/dev/null; \
  [[ "$(grep -v '^\s*#' "$ROOT/infra/prod/HETZNER-DEPLOY.sh" | grep -c 'npx prisma generate')" == "0" ]] \
  && pass "the deploy script no longer generates the client in a container it throws away" || fail "HETZNER-DEPLOY.sh still runs prisma generate"
grep -q "run as the unprivileged user" "$ROOT/infra/prod/README.md" && ! grep -q "All containers run as root" "$ROOT/infra/prod/README.md" \
  && pass "the README says what is the case" || fail "the README still says the containers run as root"

summary
