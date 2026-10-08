#!/bin/bash
# Tier 583 — POST /signing/verify checks the signature
#
# It called a signature valid when its container held a 32-byte digest
# attribute — the digest was compared with nothing, the signature never
# checked. Measured on a PDF signed by this application: the visible amount
# changed after signing → "valid"; the signature value overwritten → "valid";
# bytes appended after the signed range → "valid".
# Now: the document's hash is the signed one, the signature verifies with the
# certificate's key, nothing follows the last signature — and the answer says
# whether the certificate is one of this company's (`trusted`), because a
# self-signed certificate can carry any name.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-350-$(date +%s%N | cut -c1-13)"
D=$(mktemp -d)
register() { # label company-name → "userId companyId"
  local body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier583-e2e\",\"companyName\":\"$2\"}"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
read -r U C < <(register a "$TAG GmbH")
read -r U2 C2 < <(register b "$TAG GmbH")   # another company under the very same name
[[ -n "${C:-}" && -n "${C2:-}" ]] && pass "fixture: two companies with the same name" || { fail "register"; summary; exit 1; }

# a small PDF with a visible amount
python3 - "$D/plain.pdf" <<'PY'
import sys
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
        b"<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (Betrag 100,00 EUR) Tj ET\nendstream"]
out = b"%PDF-1.4\n"; offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 5\n0000000000 65535 f \n" + b"".join(b"%010d 00000 n \n" % o for o in offs)
out += b"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % xref
open(sys.argv[1], "wb").write(out)
PY
b64json() { # file [extra-json] → $D/req.json
  local extra="${2:-}"; [[ -z "$extra" ]] && extra='{}'
  python3 -c "import base64,json,sys;d={'pdf':base64.b64encode(open(sys.argv[1],'rb').read()).decode()};d.update(json.loads(sys.argv[2]));print(json.dumps(d))" "$1" "$extra" > "$D/req.json"
}
sign() { # user company in out  (company certificate)
  b64json "$3" "{\"companyId\":\"$2\"}"
  curl -s -X POST "$API/api/v1/signing/sign" -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" -d @"$D/req.json" \
    | python3 -c "import sys,json,base64;open(sys.argv[1],'wb').write(base64.b64decode(json.load(sys.stdin)['signedPdf']))" "$4"
}
verify() { # user company file → "valid trusted count [known…] reason-start"
  b64json "$3"
  curl -s -X POST "$API/api/v1/signing/verify" -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" -d @"$D/req.json" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('valid'), d.get('trusted'), d.get('signatureCount'), [s.get('knownSigner') for s in d.get('signatures',[])], (d.get('reason') or '-')[:30])"
}
sign "$U" "$C" "$D/plain.pdf" "$D/signed.pdf"
assert_eq "fixture: the PDF is signed" "$(grep -a -c '/ByteRange' "$D/signed.pdf")" "1"

note "=== 1. as signed ==="
assert_eq "valid, and made with this company's certificate" "$(verify "$U" "$C" "$D/signed.pdf")" "True True 1 ['company'] -"

note "=== 2. changed after signing ==="
python3 - "$D" <<'PY'
import sys, re
d = sys.argv[1]
pdf = open(f"{d}/signed.pdf", "rb").read()
a, b, c, e = map(int, re.search(rb"/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)", pdf).groups())
t = pdf.replace(b"Betrag 100,00 EUR", b"Betrag 900,00 EUR"); assert t != pdf and len(t) == len(pdf)
open(f"{d}/text.pdf", "wb").write(t)
hexs = pdf[b + 1:c - 1]; n = len(hexs.rstrip(b"0")); bad = bytearray(pdf); pos = b + 1 + n - 120
bad[pos:pos + 40] = b"0123456789abcdef0123456789abcdef01234567"
open(f"{d}/sig.pdf", "wb").write(bytes(bad))
open(f"{d}/appended.pdf", "wb").write(pdf + b"\n% added later\n")
zero = bytearray(pdf); zero[b + 1:c - 1] = b"0" * (c - b - 2)
open(f"{d}/empty.pdf", "wb").write(bytes(zero))
# the range made to leave out more than the signature: the amount is no longer covered
i = pdf.index(b"Betrag"); wide = pdf.replace(b"/ByteRange [%d %d %d %d" % (a, b, c, e), b"/ByteRange [%d %d %d %d" % (a, i, c, e))
open(f"{d}/range.pdf", "wb").write(wide if len(wide) == len(pdf) else pdf[:10])
PY
assert_eq "the amount changed (was valid)" "$(verify "$U" "$C" "$D/text.pdf")" "False False 1 ['company'] Das Dokument wurde nach dem Si"
assert_eq "the signature value overwritten (was valid)" "$(verify "$U" "$C" "$D/sig.pdf")" "False False 1 ['company'] Die Signatur passt nicht zum e"
assert_eq "something appended after the signed range (was valid)" "$(verify "$U" "$C" "$D/appended.pdf")" "False False 1 ['company'] Nach der letzten Signatur wurd"
assert_eq "the container emptied" "$(verify "$U" "$C" "$D/empty.pdf" | cut -d' ' -f1-3)" "False False 1"
assert_eq "a ByteRange that leaves the amount out" "$(verify "$U" "$C" "$D/range.pdf" | cut -d' ' -f1-2)" "False False"
assert_eq "an unsigned PDF" "$(verify "$U" "$C" "$D/plain.pdf")" "False False 0 [] PDF enthält keine Signatur"

note "=== 3. whose certificate ==="
assert_eq "another company looking at it: intact, not its certificate" "$(verify "$U2" "$C2" "$D/signed.pdf")" "True False 1 [None] -"
sign "$U2" "$C2" "$D/plain.pdf" "$D/by-b.pdf"
assert_eq "a PDF signed by a company of the SAME NAME is not this company's (was: valid, signed by <name>)" "$(verify "$U" "$C" "$D/by-b.pdf")" "True False 1 [None] -"

note "=== 4. a member's second signature ==="
b64json "$D/signed.pdf" "{\"userId\":\"$U\"}"
curl -s -X POST "$API/api/v1/signing/user-sign" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d @"$D/req.json" \
  | python3 -c "import sys,json,base64;open(sys.argv[1],'wb').write(base64.b64decode(json.load(sys.stdin)['signedPdf']))" "$D/two.pdf"
assert_eq "company and member: both verify, the last covers the file" "$(verify "$U" "$C" "$D/two.pdf")" "True True 2 ['company', 'user'] -"
python3 -c "import sys;b=bytearray(open(sys.argv[1],'rb').read());i=b.rfind(b'%%EOF');b[i-30]^=1;open(sys.argv[2],'wb').write(bytes(b))" "$D/two.pdf" "$D/two-bad.pdf"
assert_eq "one byte of the second revision changed" "$(verify "$U" "$C" "$D/two-bad.pdf" | cut -d' ' -f1-3)" "False False 2"

note "=== 5. the invoice PDF the application serves ==="
fixture_issuer "$C"
KB='{"name":"Kunde AG","type":"business","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"},"contact":{"email":"k@example.test"}}'
K=$(curl -s -X POST "$API/api/v1/customers?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$KB" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
IB="{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(curl -s -X POST "$API/api/v1/invoices?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$IB" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -o "$D/inv.pdf" "$API/api/v1/invoices/$I/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "its own signed invoice verifies" "$(verify "$U" "$C" "$D/inv.pdf")" "True True 1 ['company'] -"
rm -rf "$D"
summary
