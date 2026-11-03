#!/bin/bash
# Tier 787 — reset and invitation links are found by their hash; a closed
# company's links stay shut
#
# The password-reset token and the invitation token were stored as bcrypt
# hashes. A bcrypt hash cannot be looked up, so every reset-password and every
# invitation verify/accept compared the token with every pending row of the
# whole installation in turn, about 70 ms each — the more pending links, the
# slower each request, and a made-up token the slowest (a cheap way to keep
# the server busy). Now the row holds the token's SHA-256, under a unique index.
#
# Measured on the way:
#   - the reset link sent twice at once set the password twice (both 200)
#   - the invitation link sent twice at once: 201 and 500 (the second user
#     row hit the unique e-mail)
#   - closing a company ends its portal sessions, payment links and
#     invitations by updating the rows it finds; one made while it closed (or
#     a company closed by the operator in SQL) kept working: the portal
#     answered 200 for a closed company. The lookups now ask the company.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-491-$(date +%s%N | cut -c1-13)"
PW="Tier787-e2e"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
field() { python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  for k in '$1'.split('.'): d=d.get(k) if isinstance(d,dict) else None
  print(d if d is not None else '')
except Exception: print('')" < "$D/out"; }
req() { # method path [body] [extra curl args] → status; body in $D/out
  local m="$1" p="$2" b="${3:-}"; shift 2; [[ $# -gt 0 ]] && shift
  curl -sS -o "$D/out" -w '%{http_code}' -X "$m" "$API$p" -H "Content-Type: application/json" ${b:+-d "$b"} "$@"
}
sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
rnd() { python3 -c "import secrets;print(secrets.token_hex(32))"; }
twice() { # path body → the two statuses, sorted, of the request sent twice at once
  python3 - "$API$1" "$2" <<'PY'
import sys, threading, urllib.request, urllib.error
url, body = sys.argv[1:3]
out = []
def go():
    r = urllib.request.Request(url, method="POST", data=body.encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as x: out.append(x.status)
    except urllib.error.HTTPError as e: out.append(e.code)
ts = [threading.Thread(target=go) for _ in range(2)]
[t.start() for t in ts]; [t.join() for t in ts]
print(" ".join(str(s) for s in sorted(out)))
PY
}

EMAIL="$TAG@example.test"
st=$(req POST /api/v1/auth/register "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"companyName\":\"$TAG GmbH\"}")
U=$(field user.id); C=$(field user.companyId); T=$(field sessionToken)
assert_eq "fixture: registered" "$st/${#T}" "201/64"
q "update \"User\" set \"emailVerifiedAt\"=now() where id='$U'" >/dev/null  # invitations wait for a confirmed address (Tier 736)
fixture_issuer "$C" DE811111111
A=(-H "Authorization: Bearer $T" -H "x-company-id: $C")

note "=== password reset ==="
req POST /api/v1/auth/forgot-password "{\"email\":\"$EMAIL\"}" >/dev/null
assert_eq "forgot-password stores a SHA-256 (was a bcrypt hash)" "$(q "select \"passwordResetToken\" ~ '^[0-9a-f]{64}$' from \"User\" where id='$U'")" "t"
K=$(rnd)
q "update \"User\" set \"passwordResetToken\"='$(sha "$K")', \"passwordResetExpires\"=now()+interval '1 hour' where id='$U'" >/dev/null
st=$(req POST /api/v1/auth/reset-password "{\"token\":\"$(rnd)\",\"password\":\"Neu-787-a\"}")
assert_eq "a made-up token: 400" "$st" "400"
BODY_RESET="{\"token\":\"$K\",\"password\":\"Neu-787-b\"}"  # outside "$( )": brace expansion
R=$(twice /api/v1/auth/reset-password "$BODY_RESET")
assert_eq "the link sent twice at once: one sets the password, the other is refused (was 200 200)" "$R" "200 400"
st=$(req POST /api/v1/auth/login "{\"email\":\"$EMAIL\",\"password\":\"Neu-787-b\"}")
assert_eq "…the new password signs in" "$st" "200"
assert_eq "…the token is used up" "$(q "select \"passwordResetToken\" is null from \"User\" where id='$U'")" "t"
st=$(req POST /api/v1/auth/reset-password "{\"token\":\"$K\",\"password\":\"Neu-787-c\"}")
assert_eq "…and a third use: 400" "$st" "400"
q "update \"User\" set \"passwordResetToken\"='$(sha "$K")', \"passwordResetExpires\"=now()-interval '1 minute' where id='$U'" >/dev/null
st=$(req POST /api/v1/auth/reset-password "{\"token\":\"$K\",\"password\":\"Neu-787-d\"}")
assert_eq "an expired token: 400" "$st" "400"
q "update \"User\" set \"passwordResetToken\"=null, \"passwordResetExpires\"=null where id='$U'" >/dev/null
T=$(curl -sS -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"password\":\"Neu-787-b\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sessionToken',''))")
A=(-H "Authorization: Bearer $T" -H "x-company-id: $C")  # the reset ended the sessions (Tier 403)

note "=== invitations ==="
st=$(req POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-inv@example.test\",\"role\":\"viewer\"}" "${A[@]}")
INV=$(field id)
assert_eq "fixture: an invitation" "$st/${#INV}" "201/36"
assert_eq "…its row holds a SHA-256 (was a bcrypt hash)" "$(q "select \"tokenHash\" ~ '^[0-9a-f]{64}$' from \"UserInvitation\" where id='$INV'")" "t"
for i in $(seq 1 30); do
  req POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-viele-$i@example.test\",\"role\":\"viewer\"}" "${A[@]}" >/dev/null
done
assert_eq "fixture: 30 more open invitations" "$(q "select count(*) from \"UserInvitation\" where \"companyId\"='$C' and \"acceptedAt\" is null")" "31"
MS=$(curl -sS -o /dev/null -w '%{time_total}' "$API/api/v1/invitations/verify?token=$(rnd)" | python3 -c "import sys;print(int(float(sys.stdin.read())*1000))")
assert_eq "a made-up token is answered at once, however many are open (${MS} ms; was one bcrypt per open invitation)" "$([[ $MS -lt 1000 ]] && echo fast || echo slow)" "fast"
K2=$(rnd)
q "update \"UserInvitation\" set \"tokenHash\"='$(sha "$K2")' where id='$INV'" >/dev/null
st=$(req GET "/api/v1/invitations/verify?token=$K2")
assert_eq "the link's token is found" "$st/$(field valid)/$(field email)" "200/True/$TAG-inv@example.test"
BODY_ACCEPT="{\"token\":\"$K2\",\"password\":\"Einlad-787\"}"
R=$(twice /api/v1/invitations/accept "$BODY_ACCEPT")
assert_eq "accepting it twice at once: one user, the other refused (was 201 500)" "$R" "201 400"
assert_eq "…one account with the address" "$(q "select count(*) from \"User\" where email='$TAG-inv@example.test'")" "1"
st=$(req GET "/api/v1/invitations/verify?token=$K2")
assert_eq "…the token is used up" "$(field valid)" "False"

note "=== a closed company's links ==="
st=$(req POST "/api/v1/customers?companyId=$C" "{\"name\":\"Kunde $TAG\",\"type\":\"business\",\"contact\":{\"email\":\"kunde-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}" "${A[@]}")
K=$(field id)
req POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$(date +%Y-%m-%d)\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}" "${A[@]}" >/dev/null
I=$(field id)
req PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}' "${A[@]}" >/dev/null
req POST "/api/v1/invoices/$I/generate-payment-link?companyId=$C" '{"origin":"http://localhost:3100"}' "${A[@]}" >/dev/null
LT=$(python3 -c "import json;d=json.load(open('$D/out'));print(d.get('token') or d.get('url','').rstrip('/').rsplit('/',1)[-1])" 2>/dev/null)
req POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$K\"}" "${A[@]}" >/dev/null
PT=$(field url | sed -n 's/.*token=\([0-9a-f]\{64\}\).*/\1/p')
st=$(req POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"$TAG-spaet@example.test\",\"role\":\"viewer\"}" "${A[@]}")
INV2=$(field id); K3=$(rnd)
q "update \"UserInvitation\" set \"tokenHash\"='$(sha "$K3")' where id='$INV2'" >/dev/null
assert_eq "fixture: payment link, portal session, invitation — all open" \
  "$(req GET "/api/v1/portal/$LT")/$(req GET "/api/v1/customer-portal/invoices?token=$PT")/$(req GET "/api/v1/invitations/verify?token=$K3" >/dev/null; field valid)" "200/200/True"
# The company closes while they were being made: its rows are as they were.
q "update \"Company\" set \"closedAt\"=now(), \"retentionUntil\"=now()+interval '10 years' where id='$C'" >/dev/null
st=$(req GET "/api/v1/customer-portal/invoices?token=$PT")
assert_eq "the portal of the closed company: 401 (was 200)" "$st" "401"
st=$(req GET "/api/v1/customer-portal/profile?token=$PT")
assert_eq "…its profile page too" "$st" "401"
st=$(req GET "/api/v1/portal/$LT")
assert_eq "the payment link: 404 (was 200)" "$st" "404"
st=$(req POST "/api/v1/portal/$LT/mark-paid" '{}')
assert_eq "…reporting a payment on it: refused" "$([[ $st == 4* ]] && echo refused || echo "$st")" "refused"
st=$(req GET "/api/v1/invitations/verify?token=$K3")
assert_eq "the invitation: no longer valid (was valid)" "$(field valid)" "False"
st=$(req POST /api/v1/invitations/accept "{\"token\":\"$K3\",\"password\":\"Einlad-787\"}")
assert_eq "…accepting it: 400, no user" "$st/$(q "select count(*) from \"User\" where email='$TAG-spaet@example.test'")" "400/0"

summary
