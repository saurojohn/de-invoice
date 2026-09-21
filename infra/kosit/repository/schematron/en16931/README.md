# EN 16931 UBL validation (CEN/TC 434)

`EN16931-UBL-validation.xslt` — the compiled EN 16931 core schematron for UBL,
version **1.3.16** (last update 2026-03-30).

- Source: https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/tag/validation-1.3.16
  (`en16931-ubl-1.3.16.zip`, 2 650 024 bytes,
  sha256 `bafada015efbc5248bf5e05ad2191e1d9833ef96e9dd5f4bce420a747342da85`),
  file `xslt/EN16931-UBL-validation.xslt`
  (sha256 `39f9d282867f1a49e7708d9e29a53da89643e1ee56f10cec1ebcf1277595fcbd`).
- Licence: European Union Public Licence (EUPL) 1.2, as stated in the file header.
- Pairing: the official KoSIT `validator-configuration-xrechnung` v2026-08-31
  (XRechnung 3.0) uses this CEN version.
- Re-fetch with `infra/kosit/setup.sh` (checksum-pinned).

Added in Tier 412: before it, `scenarios.xml` ran only the XRechnung CIUS
schematron, which contains no EN 16931 core rule.

## CII (Tier 414)

`EN16931-CII-validation.xslt` — the EN 16931 core schematron for UN/CEFACT CII,
same release **1.3.16**, used for the XML inside ZUGFeRD / Factur-X PDFs
(scenario `EN16931-CII` in `scenarios.xml`).

- Source: `en16931-cii-1.3.16.zip` from the same release (226 664 bytes,
  sha256 `1cd53cb8a84d38aedc82c0caede217da983a7934dd663f793a092fd66443c561`),
  file `xslt/EN16931-CII-validation.xslt`
  (sha256 `0b234dea2bbfee739b7761e607a992c17fab88773014ef56355b6158cfb1cc53`).
- The CII D16B schema it runs after is in `../../xsd/cii/uncefact/` — the
  "D16B SCRDM (Subset) / uncoupled clm" tree from the same tag of
  ConnectingEurope/eInvoicing-EN16931 (54 XSD files; tree checksum in
  `setup.sh`).
- Licence: EUPL 1.2 (repository licence); the D16B schemas are UN/CEFACT
  publications distributed there.
