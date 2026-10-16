# Bundled assets (Tier 693)

Files the invoice PDF needs to be a real PDF/A-3 (ZUGFeRD / Factur-X):

| file | source | licence |
|---|---|---|
| `fonts/LiberationSans-*.ttf`, `LiberationSerif-*.ttf`, `LiberationMono-*.ttf` | liberation-fonts-ttf-2.1.5, github.com/liberationfonts/liberation-fonts | SIL Open Font License 1.1 (`fonts/LICENSE-Liberation-Fonts.txt`) |
| `icc/sRGB-v2-micro.icc` | github.com/saucecontrol/Compact-ICC-Profiles | CC0 1.0 |

Liberation Sans / Serif / Mono have the metrics of Helvetica / Times / Courier,
so the layout of an invoice does not move when they replace PDFKit's
standard fonts (which PDF/A forbids, as they are not embedded).
