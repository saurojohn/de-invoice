#!/bin/bash
# Tier 414 — the ZUGFeRD / Factur-X XML is real CII and passes EN 16931
#
# Nothing had ever validated the CrossIndustryInvoice embedded in the ZUGFeRD
# PDF. With the CII D16B schema and the CEN EN 16931 CII schematron in
# infra/kosit (scenarios.xml, scenario EN16931-CII), every invoice failed the
# schema before a business rule was reached: `SupplierTradeParty`,
# `DefinedTradeAddress`, `StreetName`, `ExchangedDocument/IssueDate`
# ("01.09.2026"), `TestIndicator` with text — none of them CII — and the parties
# straight under the transaction with the lines last. The amounts had the
# pre-Tier 412 defects: tax basis 1000 / tax 190 next to a total tax of 171 on a
# discounted invoice, category S on every rate including a 0 % igL. The XMP said
# fx:Version 2.1 and "EN16931" (Factur-X wants 1.0 and "EN 16931").
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-203-$(date +%s%N | cut -c1-13)"
# Normalised: KoSIT cannot resolve its repository through a path with "..".
KOSIT_ROOT="$(cd "$SCRIPT_DIR/../../infra/kosit" && pwd)"
# Java as in spec 140 / kosIT-validator.service.ts: bundled JDK, $JAVA_HOME, PATH.
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
[[ -n "$JAVA_BIN" && -x "$JAVA_BIN" ]] && pass "Java: $JAVA_BIN" || { fail "no Java for KoSIT"; summary; exit 1; }
[[ -f "$KOSIT_ROOT/repository/xsd/cii/uncefact/data/standard/CrossIndustryInvoice_100pD16B.xsd" ]] \
  && pass "CII D16B schema installed" || fail "CII D16B schema missing"
[[ -f "$KOSIT_ROOT/repository/schematron/en16931/EN16931-CII-validation.xslt" ]] \
  && pass "EN 16931 CII schematron installed" || fail "EN 16931 CII schematron missing"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier414-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t414.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
customer() { AS POST "/api/v1/customers?companyId=$C" "$1"; json_field "$BODY" id; }
K=$(customer '{"name":"Kunde AG","type":"business","vatId":"DE987654321","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"},"contact":{"email":"k@example.test"}}')
KFR=$(customer '{"name":"Client SARL","type":"business","vatId":"FR12345678901","address":{"street":"1 Rue","city":"Paris","postalCode":"75001","country":"FR"},"contact":{"email":"c@example.test"}}')
invoice() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-09-01\",$2}"; json_field "$BODY" id; }
L19='{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}'
L0='{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0}'
PLAIN=$(invoice "$K" "\"items\":[$L19]")
DISC=$(invoice "$K" "\"discountPercent\":10,\"items\":[$L19]")
MIXDISC=$(invoice "$K" '"discountPercent":10,"items":[{"description":"a","quantity":3,"unit":"Stk","unitPrice":33.33,"vatRate":0.19},{"description":"b","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
SKONTO=$(invoice "$K" "\"skontoPercent\":2,\"skontoDays\":14,\"items\":[$L19]")
IGL=$(invoice "$KFR" "\"euTransaction\":true,\"deliveryDate\":\"2026-08-28\",\"items\":[$L0]")
RC=$(invoice "$K" "\"reverseCharge\":true,\"items\":[$L0]")
[[ -n "$PLAIN" && -n "$DISC" && -n "$MIXDISC" && -n "$SKONTO" && -n "$IGL" && -n "$RC" ]] \
  && pass "fixture: six invoices" || { fail "invoice fixtures"; summary; exit 1; }

WORK=$(mktemp -d)
cii() { # id label → $WORK/label.xml (the CII inside the ZUGFeRD PDF)
  curl -sS -o "$WORK/$2.pdf" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" \
    "$API/api/v1/invoices/$1/zugferd?companyId=$C" > "$WORK/$2.http"
  python3 - "$WORK/$2.pdf" "$WORK/$2.xml" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', d, re.DOTALL):
    try: dec = zlib.decompress(m.group(1))
    except Exception: continue
    if b'CrossIndustryInvoice' in dec:
        open(sys.argv[2], 'wb').write(dec); sys.exit(0)
sys.exit(1)
PY
}
kosit() { # label → "ACCEPTABLE" or the first failed rules
  local out="$WORK/out-$1"; mkdir -p "$out"
  if (cd "$out" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" \
        -s "$KOSIT_ROOT/scenarios.xml" -o "$out" "$WORK/$1.xml" >/dev/null 2>&1); then
    echo ACCEPTABLE
  else
    python3 - "$out" <<'PY'
import glob, re, sys
ids = []
for fn in glob.glob(sys.argv[1] + "/*.xml"):
    x = open(fn, encoding="utf-8").read()
    ids += re.findall(r'failed-assert[^>]*id="([^"]+)"', x)
    ids += ["XSD: " + m[:80] for m in re.findall(r'<xmlSyntaxError>.*?<message>(.*?)</message>', x, re.S)]
print("REJECT " + "; ".join(dict.fromkeys(ids)))
PY
  fi
}
has() { if grep -qF -- "$3" "$2"; then pass "$1"; else fail "$1 — missing: $3"; fi; }
hasnt() { if grep -qF -- "$3" "$2"; then fail "$1 — still present: $3"; else pass "$1"; fi; }

note "=== 1. KoSIT: CII D16B schema + EN 16931 CII schematron ==="
for pair in "plain:$PLAIN" "discount:$DISC" "mixdisc:$MIXDISC" "skonto:$SKONTO" "igl:$IGL" "rc:$RC"; do
  label=${pair%%:*}; id=${pair#*:}
  if cii "$id" "$label"; then
    assert_eq "$label: ACCEPTABLE" "$(kosit "$label")" "ACCEPTABLE"
  else
    # Tier 423: say what came back — this failed twice in local full runs
    # (never alone, never in CI) and the file was gone by the time anyone looked.
    fail "$label: no CII found in the ZUGFeRD PDF (HTTP $(cat "$WORK/$label.http"), $(wc -c < "$WORK/$label.pdf") bytes: $(head -c 120 "$WORK/$label.pdf" | tr -c '[:print:]' '.'))"
  fi
done

note "=== 2. structure ==="
X="$WORK/plain.xml"
has "IssueDateTime in format 102" "$X" '<udt:DateTimeString format="102">20260901</udt:DateTimeString>'
has "parties inside ApplicableHeaderTradeAgreement" "$X" '<ram:ApplicableHeaderTradeAgreement>'
has "SellerTradeParty" "$X" '<ram:SellerTradeParty>'
hasnt "no SupplierTradeParty (not CII)" "$X" 'SupplierTradeParty'
hasnt "no DefinedTradeAddress (not CII)" "$X" 'DefinedTradeAddress'
has "seller electronic address (EM)" "$X" '<ram:URIID schemeID="EM">info@t414.example</ram:URIID>'
has "IBAN in payment means" "$X" '<ram:IBANID>DE89370400440532013000</ram:IBANID>'

note "=== 3. the discount ==="
X="$WORK/discount.xml"
has "line total 1000.00" "$X" '<ram:LineTotalAmount>1000.00</ram:LineTotalAmount>'
has "allowance 100.00" "$X" '<ram:AllowanceTotalAmount>100.00</ram:AllowanceTotalAmount>'
has "tax basis 900.00" "$X" '<ram:BasisAmount>900.00</ram:BasisAmount>'
has "tax 171.00 (was 190.00)" "$X" '<ram:CalculatedAmount>171.00</ram:CalculatedAmount>'
has "tax basis total 900.00 (was 1000.00)" "$X" '<ram:TaxBasisTotalAmount>900.00</ram:TaxBasisTotalAmount>'
has "grand total 1071.00" "$X" '<ram:GrandTotalAmount>1071.00</ram:GrandTotalAmount>'

note "=== 4. tax categories, Skonto, delivery ==="
X="$WORK/igl.xml"
has "igL: category K" "$X" '<ram:CategoryCode>K</ram:CategoryCode>'
has "igL: VATEX-EU-IC" "$X" '<ram:ExemptionReasonCode>VATEX-EU-IC</ram:ExemptionReasonCode>'
has "igL: ship-to country FR" "$X" '<ram:CountryID>FR</ram:CountryID>'
has "igL: the recorded delivery date (BT-72)" "$X" '20260828'
hasnt "igL: no S category" "$X" '<ram:CategoryCode>S</ram:CategoryCode>'
has "§13b: category AE" "$WORK/rc.xml" '<ram:CategoryCode>AE</ram:CategoryCode>'
has "Skonto: #SKONTO# payment term" "$WORK/skonto.xml" '#SKONTO#TAGE=14#PROZENT=2.00#'
hasnt "Skonto: no allowance" "$WORK/skonto.xml" 'SpecifiedTradeAllowanceCharge'

note "=== 5. the Factur-X XMP ==="
has "fx:Version 1.0" "$WORK/plain.pdf" 'fx:Version>1.0<'
has "fx:ConformanceLevel EN 16931" "$WORK/plain.pdf" 'fx:ConformanceLevel>EN 16931<'

rm -rf "$WORK"
summary; exit $?
