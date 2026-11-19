#!/bin/bash
# Tier 878 — a receipt's „Summe“ is its total
#
# Found on the production images (Tier 877's walk): a receipt read by the
# scanner — „Brötchen 100,00 / MwSt 19% 19,00 / Summe 119,00 EUR“ — came back
# as net 119, VAT 19, gross 138: a gross on no receipt, and 19 € of input VAT
# on 119 € that were the total. extractNetAmount took a bare „Summe“ as the
# net; extractGrossAmount knew only „Gesamtbetrag / Rechnungsbetrag / Total“,
# and then made the gross of net + VAT. A till receipt („SUMME EUR 3,68“,
# „Zu zahlen 50,00“) gave no total at all.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
OUT=$(cd "$SCRIPT_DIR/.." && ./node_modules/.bin/ts-node -T -e "
import { extractFieldsFromText } from './src/modules/ocr/ocr.service'
const cases: string[] = [
  'Bäckerei Müller GmbH\nHauptstraße 5, 10115 Berlin\nDatum: 18.11.2026\nBrötchen        100,00\nMwSt 19%         19,00\nSumme           119,00 EUR',
  'REWE Markt GmbH\nMilch 1,19\nBrot 2,49\nSUMME EUR 3,68\nMwSt 7% 0,24\nBar 5,00\nRückgeld 1,32',
  'Tankstelle Nord\nSuper 50,00\nMwSt 19% 7,98\nZu zahlen 50,00 EUR',
  'Firma X\nZwischensumme netto: 100,00 EUR\nUSt 19%: 19,00 EUR\nGesamtbetrag: 119,00 EUR',
  'Firma Y\nSumme netto 200,00\nMwSt 19% 38,00\nGesamt 238,00',
]
for (const t of cases) { const r = extractFieldsFromText(t); console.log([r.netAmount, r.vatAmount, r.grossAmount].join('/')) }
" 2>&1)
assert_eq "„Summe 119,00“: the total — net 100, VAT 19, gross 119 (was 119/19/138)" "$(sed -n 1p <<<"$OUT")" "100/19/119"
assert_eq "a till receipt „SUMME EUR 3,68“: its total, the net from it less the VAT (was: no total)" "$(sed -n 2p <<<"$OUT")" "3.44/0.24/3.68"
assert_eq "„Zu zahlen 50,00“: the total (was: none) — not the cash given or the change" "$(sed -n 3p <<<"$OUT")" "42.02/7.98/50"
assert_eq "an invoice with Zwischensumme / Gesamtbetrag: as before" "$(sed -n 4p <<<"$OUT")" "100/19/119"
assert_eq "„Summe netto“ is the net, „Gesamt“ the total" "$(sed -n 5p <<<"$OUT")" "200/38/238"
summary
