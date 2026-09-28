#!/bin/bash
# Tier 445 — SQL fed to `docker exec` on stdin needs -i
#
# `docker exec` attaches stdin only with -i. Without it the heredoc / redirect /
# pipe is read by nobody: psql starts with an empty stdin, runs nothing and
# exits 0 — and every one of these calls also sent its output to /dev/null.
# Seven such calls were found, all cleanups:
#   105 (Berater test user), 106 (ANS-* invoices / expenses), 107 (BIL-*),
#   108 (the GUV-* pre-clean), 91 (Mahnungspause).
# On CI they never ran. 114-tier88-ebilanz asserted Materialaufwand > 0 and
# passed only because 106 / 107 left their Material expenses behind; with the
# cleanups working it seeds its own.
#
# This spec keeps the shape out: no spec may pipe, redirect or heredoc into
# `docker exec` without -i (continuation lines are joined, quoted text such as
# SQL `x < 0` is ignored).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# check DIR — prints file:line of every stdin-fed `docker exec` without -i.
check() {
  python3 - "$1" "$(basename "$0")" <<'PY'
import glob, os, re, sys
d, me = sys.argv[1], sys.argv[2]
bad = []
files = sorted(glob.glob(os.path.join(d, '[0-9]*.sh')))
files += [os.path.join(d, x) for x in ('_lib.sh', 'ci-seed.sh', 'run-all.sh')]
for f in files:
    if os.path.basename(f) == me or not os.path.exists(f):
        continue
    joined, buf, start = [], '', 0
    for n, line in enumerate(open(f, encoding='utf-8').read().split('\n'), 1):
        if not buf:
            start = n
        if line.rstrip().endswith('\\'):
            buf += line.rstrip()[:-1] + ' '
            continue
        joined.append((start, buf + line))
        buf = ''
    for n, line in joined:
        if line.lstrip().startswith('#'):
            continue
        # Quoted text is data (SQL like `x < 0`), not a redirect.
        code = re.sub(r'"(\\.|[^"\\])*"', '""', line)
        code = re.sub(r"'[^']*'", "''", code)
        for m in re.finditer(r'docker\s+exec\b([^|;&]*)', code):
            args = m.group(1)
            flags = re.findall(r'\s(-[a-zA-Z]+)', args.split('psql')[0])
            fed = re.search(r'<<|(^|\s)<\s', args) or re.search(r'\|\s*$', code[:m.start()])
            if fed and not any('i' in fl for fl in flags):
                bad.append(f'{os.path.basename(f)}:{n}')
print(' '.join(bad))
PY
}

note "=== no stdin-fed docker exec without -i ==="
BAD=$(check "$SCRIPT_DIR")
assert_eq "every stdin-fed docker exec has -i" "${BAD:-none}" "none"

note "=== the check catches the shape it is for ==="
T=$(mktemp -d)
{
  echo '#!/bin/bash'
  echo 'docker exec "$PG_CONTAINER" psql -U x <<SQL'
  echo 'DELETE FROM "X";'
  echo 'SQL'
  echo 'echo "select 1" | docker exec "$PG_CONTAINER" psql -U x'
  echo 'docker exec -i "$PG_CONTAINER" psql -U x <<SQL'
  echo 'SQL'
  echo 'docker exec "$PG_CONTAINER" psql -U x -c "select 1 where 2 < 3"'
  echo 'docker exec "$PG_CONTAINER" psql -U x \'
  echo '  <<SQL'
  echo 'SQL'
} > "$T/999-probe.sh"
assert_eq "heredoc, pipe and a continued heredoc flagged; -i and a quoted < left alone" \
  "$(check "$T")" "999-probe.sh:2 999-probe.sh:5 999-probe.sh:9"
rm -rf "$T"

summary; exit $?
