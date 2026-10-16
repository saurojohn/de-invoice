#!/bin/bash
# Tier 688 — the invoice names why it carries no German VAT, as the UStVA counts it
#
# Measured before, one invoice of each kind (100 € net, 0 %):
#   intra-EU supply      "Steuerfreie innergemeinschaftliche Lieferung (§1a UStG)"
#                        — § 1a is the buyer's acquisition; the seller's
#                        exemption is § 4 Nr. 1 Buchst. b, § 6a UStG
#   export to CH         no note at all (§ 14 Abs. 4 Nr. 8 UStG asks for the
#                        exemption); the e-invoice said E "Steuerbefreite Leistung"
#   service to a Swiss   "Steuerschuldnerschaft des Leistungsempfängers (§13b
#   business (§13b flag) UStG)" — the UStVA counts it as not taxable here (Kz 45)
#   0 % to a French      no note; the e-invoice said E — the UStVA counts it as
#   business, no flag    an intra-EU supply (Kz 41)
# The page texts named § 1a too.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-412-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
KOSIT_ROOT="$(cd "$SCRIPT_DIR/../../infra/kosit" && pwd)"
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier688-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
# note ID → the tax note on the invoice's page (the line after the payment terms), or "-"
note_of() {
  fetch "/api/v1/invoices/$1/pdf?companyId=$C&format=pdf&sign=false" "$WORK/$1.pdf" >/dev/null
  # Tier 693: the invoice PDF embeds its fonts — its text runs through pdf.js
  node "$SCRIPT_DIR/fixtures/pdf-text.mjs" "$WORK/$1.pdf" --lines | grep -m1 "UStG\|steuerbar" || echo "-"
}
category_of() { fetch "/api/v1/invoices/$1/xrechnung?companyId=$C" "$WORK/$1.xml" >/dev/null; python3 -c "
import re,sys; x=open(sys.argv[1],encoding='utf-8').read()
print(' '.join(sorted(set(re.findall(r'<cac:ClassifiedTaxCategory>\s*<cbc:ID>([A-Z]+)</cbc:ID>', x)))))" "$WORK/$1.xml"; }
kosit() { # ID → ACCEPTABLE or the failed rules
  local out="$WORK/k-$1"; mkdir -p "$out"
  if (cd "$out" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" -s "$KOSIT_ROOT/scenarios.xml" -o "$out" "$WORK/$1.xml" >/dev/null 2>&1); then echo ACCEPTABLE
  else echo "REJECT $(grep -oh 'failed-assert[^>]*id="[^"]*"' "$out"/*.xml 2>/dev/null | head -3 | tr '\n' ' ')"; fi
}

AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","taxId":"12/345/67890","email":"info@t688.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
cust() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$1\",\"type\":\"business\",\"vatId\":\"$3\",\"address\":{\"street\":\"Weg 2\",\"city\":\"Stadt\",\"postalCode\":\"12345\",\"country\":\"$2\"},\"contact\":{\"email\":\"k-$2@example.test\"}}"; [[ "$STATUS" == "201" ]] || echo "customer $1: $STATUS $BODY" >&2; P "d['id']"; }
DE=$(cust "Kunde DE" DE DE987654321); FR=$(cust "Client FR" FR FR12345678901); CH=$(cust "Kunde CH" CH CHE-123.456.789)
Y=$(TZ=Europe/Berlin date +%Y); M=$((10#$(TZ=Europe/Berlin date +%m))); D1="$Y-$(printf %02d $M)-01"
inv() { # customer flags rate → id (issued)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$D1\",\"deliveryDate\":\"$D1\",$2\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":$3}]}"
  local id; id=$(P "d['id']"); AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'; echo "$id"
}
NORMAL=$(inv "$DE" "" 0.19)
RC=$(inv "$DE" '"reverseCharge":true,' 0)
IGL=$(inv "$FR" '"euTransaction":true,' 0)
EXPORT=$(inv "$CH" "" 0)
ABROAD=$(inv "$CH" '"reverseCharge":true,' 0)
NOFLAG=$(inv "$FR" "" 0)
[[ -n "$NORMAL" && -n "$RC" && -n "$IGL" && -n "$EXPORT" && -n "$ABROAD" && -n "$NOFLAG" ]] && pass "fixture: six issued invoices" || fail "fixtures: $NORMAL/$RC/$IGL/$EXPORT/$ABROAD/$NOFLAG"

note "=== 1. the note on the invoice ==="
assert_eq "19 % to a German business: no note" "$(note_of "$NORMAL")" "-"
assert_eq "§ 13b to a German business: the § 13b note (as before)" "$(note_of "$RC")" "Steuerschuldnerschaft des Leistungsempfängers (§13b UStG)."
assert_eq "intra-EU supply: § 4 Nr. 1 b / § 6a (was: §1a UStG)" "$(note_of "$IGL")" "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)."
assert_eq "export to Switzerland: the exemption is named (was: no note)" "$(note_of "$EXPORT")" "Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG)."
assert_eq "service to a Swiss business: not taxable here (was: the § 13b note)" "$(note_of "$ABROAD")" "Nicht im Inland steuerbare Leistung (Leistungsort im Drittland, § 3a Abs. 2 UStG)."
assert_eq "0 % to a French business with a VAT id: the igL note (was: no note)" "$(note_of "$NOFLAG")" "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)."

note "=== 2. the e-invoice says the same, and passes KoSIT ==="
assert_eq "categories: § 13b AE, igL K, export G (was E), Swiss service AE, French 0 % K (was E)" \
  "$(category_of "$RC") / $(category_of "$IGL") / $(category_of "$EXPORT") / $(category_of "$ABROAD") / $(category_of "$NOFLAG")" "AE / K / G / AE / K"
assert_eq "…the export's reason" "$(grep -o '<cbc:TaxExemptionReasonCode>[^<]*</cbc:TaxExemptionReasonCode>' "$WORK/$EXPORT.xml" | head -1)" "<cbc:TaxExemptionReasonCode>VATEX-EU-G</cbc:TaxExemptionReasonCode>"
if [[ -n "$JAVA_BIN" && -x "$JAVA_BIN" ]]; then
  assert_eq "KoSIT: the export (G) and the French 0 % sale (K)" "$(kosit "$EXPORT") / $(kosit "$NOFLAG")" "ACCEPTABLE / ACCEPTABLE"
else
  fail "no Java for KoSIT"
fi

note "=== 3. the UStVA counts them as before (one rule now) ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$M"
kz() { P "[k['value'] for k in d['kennzahlen'] if k['kz'] == '$1'][0]"; }
assert_eq "Kz 41 igL 200 (flagged + French 0 %), Kz 43 export 100, Kz 45 Swiss service 100, Kz 60 § 13b 100" \
  "$STATUS $(kz 41) $(kz 43) $(kz 45) $(kz 60)" "200 200 100 100 100"

note "=== 4. a template stored with the old text ==="
AS POST "/api/v1/invoice-templates?companyId=$C" "{\"companyId\":\"$C\",\"name\":\"Alt\",\"isDefault\":true,\"configJson\":{\"euTransactionNote\":\"Steuerfreie innergemeinschaftliche Lieferung (§1a UStG).\",\"reverseChargeNote\":\"Steuerschuldnerschaft des Leistungsempfängers (§13b UStG).\"}}"
assert_eq "fixture: a default template with the old igL text" "$STATUS" "201"
IGL2=$(inv "$FR" '"euTransaction":true,' 0)
assert_eq "its old igL text is read as the corrected one" "$(note_of "$IGL2")" "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)."

note "=== 5. the pages do not name § 1a any more ==="
MSG="$SCRIPT_DIR/../../frontend/messages"
SRC="$SCRIPT_DIR/../src"
assert_eq "nor do the backend's texts about the seller's igL: the form's hint, the contradiction error, the UStVA PDF (Tier 688b)" \
  "$(grep -rh "empfohlen: §1a UStG\|Innergemeinschaftliche Lieferung (§1a UStG)\|'igL (§1a UStG)'" "$SRC" | wc -l | tr -d ' ')" "0"
assert_eq "de / en / zh: no „§1a UStG“ (was 12 texts)" "$(cat "$MSG/de.json" "$MSG/en.json" "$MSG/zh.json" | grep -c '§1a UStG')" "0"

summary
