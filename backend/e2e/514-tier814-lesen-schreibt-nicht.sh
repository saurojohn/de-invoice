#!/bin/bash
# Tier 814 — a GET writes nothing
#
# Tier 666/667 called every GET route once and watched the database: three
# wrote — `GET /accounting/accounts/seed` (it creates the chart of accounts)
# and the first rendering of an invoice's PDF (it keeps the file's path).
# Measured again on 06.11.2026 with statement logging, 264 GET routes (with
# real ids for those with a path parameter): the seed route is the one that
# writes. A link, an <img src>, a browser's prefetch or a mail scanner opening
# the URL ran it; it is `POST /accounting/accounts/seed` now.
#
# On a fresh company the sweep found three more, hidden on a company that has
# them already: the defaults made on the first read — 5 note templates, 3
# reminder templates, the signing key. Defaults are fine once; two of them
# were not once: five first reads at once made 15 note templates (no unique
# key), and five first signatures five signing keys, each replacing the one
# before (four PDFs signed with a key the company no longer had).
#
# Kept as a guard, which nothing was: every GET route without a path parameter
# is called for a fresh company twice — the seed route among them. The
# company's rows (count and latest updatedAt of every table with a companyId,
# the audit log aside: reading personal data is logged on purpose) may gain
# those three defaults on the first round and nothing else, and nothing on
# the second.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-514-$(date +%s%N | cut -c1-13)"
SRC="$SCRIPT_DIR/../src"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier814-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

# the company's rows: per table with a companyId, its count and latest updatedAt
SNAP_SQL=$(q "select string_agg(format('select %L || %L || count(*) || %L || coalesce(%s::text, %L) from %I where \"companyId\" = %L',
    c.table_name, ' ', ' ', case when u.column_name is null then 'null' else 'max(\"updatedAt\")' end, '-', c.table_name, '$C'), ' union all ' order by c.table_name)
  from information_schema.columns c
  left join information_schema.columns u on u.table_schema = c.table_schema and u.table_name = c.table_name and u.column_name = 'updatedAt'
  where c.table_schema = 'public' and c.column_name = 'companyId' and c.table_name not in ('AuditLog')")
snap() { q "$SNAP_SQL" | sort; }
BEFORE=$(snap)
[[ $(echo "$BEFORE" | wc -l) -gt 50 ]] && pass "fixture: the company's rows in $(echo "$BEFORE" | wc -l | tr -d ' ') tables" || fail "snapshot: $(echo "$BEFORE" | head -3)"

# every GET route without a path parameter (the inventory of spec 176)
SWEEP_PY=$(mktemp); trap 'rm -f "$SWEEP_PY"' EXIT
cat > "$SWEEP_PY" <<'PY'
import re, glob, sys, urllib.request, urllib.error
src, api, uid, cid = sys.argv[1:5]
ROUTE = re.compile(r"@(Get)\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)")
paths = set()
for f in sorted(glob.glob(f"{src}/**/*.controller.ts", recursive=True)):
    code = open(f, encoding="utf-8").read()
    code = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), code, flags=re.S)
    code = re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), code)
    ctrls = list(re.finditer(r"@Controller\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)", code))
    for ci, cm in enumerate(ctrls):
        body = code[cm.end():(ctrls[ci + 1].start() if ci + 1 < len(ctrls) else len(code))]
        for r in ROUTE.finditer(body):
            p = "/".join(x for x in ((cm.group(1) or ""), (r.group(2) or "")) if x)
            if ":" not in p:
                paths.add(p)
# the seed route as it was, so the old code shows what it did
paths.add("accounting/accounts/seed")
qs = f"companyId={cid}&year=2026&month=10&quarter=4&startDate=2026-01-01&endDate=2026-12-31&from=2026-01-01&to=2026-12-31"
fired = 0
for p in sorted(paths):
    req = urllib.request.Request(f"{api}/api/v1/{p}?{qs}", headers={"x-user-id": uid, "x-company-id": cid})
    try:
        urllib.request.urlopen(req, timeout=60).read()
    except urllib.error.HTTPError:
        pass
    except Exception:
        pass
    fired += 1
print(fired)
PY
sweep() { python3 "$SWEEP_PY" "$SRC" "$API" "$U" "$C"; }

SWEEP=$(sweep)
[[ "${SWEEP:-0}" -gt 190 ]] && pass "called $SWEEP GET routes" || fail "sweep called only ${SWEEP:-0} routes"
python3 -c "import time; time.sleep(2)"
AFTER=$(snap)
CHANGED=$(diff <(echo "$BEFORE") <(echo "$AFTER") | grep '^>' | sed 's/^> //')
assert_eq "the first round: the defaults made on a first read, and nothing else (was: also 14 accounts by GET /accounting/accounts/seed)" \
  "$(echo "$CHANGED" | awk '{print $1, $2}' | tr '\n' ';')" "CompanySigningKey 1;NoteTemplate 5;ReminderTemplate 3;"
sweep >/dev/null
python3 -c "import time; time.sleep(2)"
assert_eq "the second round: nothing" "$(diff <(echo "$AFTER") <(snap) | grep -E '^[<>]' | tr '\n' ';')" ""

# ── the defaults once, also when first read five times at once ──
read -r U2 C2 < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-b@example.test\",\"password\":\"Tier814-e2e\",\"companyName\":\"$TAG-b GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
FP=$(mktemp -d)
for i in 1 2 3 4 5; do
  curl -sS -o /dev/null "$API/api/v1/note-templates?companyId=$C2" -H "x-user-id: $U2" -H "x-company-id: $C2" &
  curl -sS "$API/api/v1/signing/cert-info?companyId=$C2" -H "x-user-id: $U2" -H "x-company-id: $C2" > "$FP/$i" &
done
wait
assert_eq "five first reads at once: 5 note templates (was 15)" "$(q "select count(*) from \"NoteTemplate\" where \"companyId\"='$C2'")" "5"
assert_eq "…and one signing key, the one all five were given (was: five keys, the last one kept)" \
  "$(for i in 1 2 3 4 5; do python3 -c "import json;print(json.load(open('$FP/$i'))['fingerprint'])"; done | sort -u | wc -l | tr -d ' ')/$(for i in 1; do python3 -c "import json;print(json.load(open('$FP/$i'))['fingerprint'])"; done)" \
  "1/$(q "select fingerprint from \"CompanySigningKey\" where \"companyId\"='$C2'")"
rm -rf "$FP"

curl -sS -o /dev/null -w "%{http_code}" "$API/api/v1/accounting/accounts/seed?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" > /tmp/e2e-514.code
assert_eq "GET /accounting/accounts/seed: 404 (was 200, and wrote)" "$(cat /tmp/e2e-514.code)" "404"
curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/accounting/accounts/seed?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "x-readonly: 1" > /tmp/e2e-514.code
assert_eq "POST in read-only mode: refused" "$(cat /tmp/e2e-514.code)" "403"
curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/accounting/accounts/seed?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" > /tmp/e2e-514.code
assert_eq "POST /accounting/accounts/seed: the chart of accounts" "$(cat /tmp/e2e-514.code)/$(q "select count(*) from \"Account\" where \"companyId\"='$C'")" "201/16"
rm -f /tmp/e2e-514.code

summary
