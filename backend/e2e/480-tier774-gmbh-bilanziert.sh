#!/bin/bash
# Tier 774 — a GmbH keeps books, whatever was set
#
# Looked at as the accountant: the settings let a GmbH choose the
# Einnahmen-Überschuss-Rechnung, and every report then counted by payment. A
# Kaufmann by legal form (§ 6 HGB, § 13 Abs. 3 GmbHG) keeps books (§§ 238, 242
# HGB) and determines its profit by Bilanz (§ 5 EStG, for a corporation through
# § 8 KStG). A sole trader may choose either.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="t774-$(date +%s)"
reg() {
  local body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier774-e2e\",\"companyName\":\"$2\"}"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['user']['id'], r['company']['id'])"
}
put() { curl -sS -m 30 -o /tmp/t774.json -w '%{http_code}' -X PUT -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" -d "$3" "$API/api/v1/companies/$2"; }
art() { curl -sS -m 30 -H "x-user-id: $1" -H "x-company-id: $2" "$API/api/v1/accounting/forms?companyId=$2" | python3 -c "import json,sys; print(json.load(sys.stdin)['gewinnermittlung'])"; }

read -r U C < <(reg g "$TAG Leder GmbH")
assert_eq "a GmbH cannot choose the EÜR" "$(put "$U" "$C" '{"gewinnermittlung":"euer"}')" "400"
assert_eq "and is told why" "$(python3 -c "import json; print('§ 238 HGB' in json.load(open('/tmp/t774.json'))['message'])")" "True"
assert_eq "it keeps books" "$(art "$U" "$C")" "bilanz"
# set before this tier, or straight into the database: the reports do not follow it
docker exec "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -c "update \"Company\" set gewinnermittlung='euer' where id='$C'" >/dev/null
assert_eq "an EÜR stored for a GmbH counts as Bilanz" "$(art "$U" "$C")" "bilanz"
assert_eq "nor can it become a GmbH while it says EÜR" "$(put "$U" "$C" '{"rechtsform":"GmbH"}')" "400"

read -r U2 C2 < <(reg e "$TAG Lederwaren")
assert_eq "a sole trader may choose the EÜR" "$(put "$U2" "$C2" '{"rechtsform":"Einzelunternehmen","gewinnermittlung":"euer"}')" "200"
assert_eq "and counts by payment" "$(art "$U2" "$C2")" "euer"
assert_eq "or the Bilanz" "$(put "$U2" "$C2" '{"gewinnermittlung":"bilanz"}')" "200"
assert_eq "an EÜR company that becomes a GmbH must say Bilanz" "$(put "$U2" "$C2" '{"gewinnermittlung":"euer"}')$(put "$U2" "$C2" '{"rechtsform":"GmbH"}')" "200400"
rm -f /tmp/t774.json
summary
