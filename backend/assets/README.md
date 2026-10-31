# Bundled assets (Tier 693)

Files the invoice PDF needs to be a real PDF/A-3 (ZUGFeRD / Factur-X), and the
language data of the receipt scanner:

| file | source | licence |
|---|---|---|
| `fonts/LiberationSans-*.ttf`, `LiberationSerif-*.ttf`, `LiberationMono-*.ttf` | liberation-fonts-ttf-2.1.5, github.com/liberationfonts/liberation-fonts | SIL Open Font License 1.1 (`fonts/LICENSE-Liberation-Fonts.txt`) |
| `icc/sRGB-v2-micro.icc` | github.com/saucecontrol/Compact-ICC-Profiles | CC0 1.0 |
| `ocr/deu.traineddata` (Tier 756, the receipt scanner) | tesseract.js's own default for German: `@tesseract.js-data/deu`, `4.0.0_best_int`, unpacked; 2 070 514 bytes, SHA-256 `a1b72cc25753eac167edfef5af4448a8dc34973503a2265c34c84520f896eb03` | Apache 2.0 (`ocr/LICENSE-Apache-2.0.txt`) |

Liberation Sans / Serif / Mono have the metrics of Helvetica / Times / Courier,
so the layout of an invoice does not move when they replace PDFKit's
standard fonts (which PDF/A forbids, as they are not embedded).

## Not in this repository: `gdpdu-01-09-2004.dtd`

The Z3 package of the GoBD export (`datenueberlassung/`) names this DTD, and it
has to lie beside `index.xml`. It is the publisher's (Audicon / Caseware), this
repository is public, and the publisher states no licence to pass it on, so it
is git-ignored: the operator places it here before the image is built. Without
it the export still works and its report says the file is missing.

- Page: caseware.com/de/beschreibungsstandard
- File: `gdpdu-01-09-2004.zip`, 3 943 bytes, SHA-256 `4200236977bdddd23cf7e45dd7a69b25b3573373c8a6c11df6b941a3957fa8cb`
- Inside: `gdpdu-01-09-2004/gdpdu-01-09-2004.dtd`, 9 140 bytes, SHA-256 `af3d4c5a19e991f2d8c53995bc708680bbd7ff9326fde539c55b7e2c63f848a2`
