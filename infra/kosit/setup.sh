#!/usr/bin/env bash
# setup-kosit.sh — Downloads the KoSIT Validator + JDK 17
# + UBL 2.1 XSDs + XRechnung 3.0.2 schematron to ./infra/{kosit,java}.
#
# Run once before `bash backend/e2e/140-tier116-kosIT.sh` or
# when you want to validate XRechnung documents against the
# full EN 16931 rule set (150+ rules).
#
# Outputs:
#   infra/java/jdk-17.0.13+11/Contents/Home/bin/java  (~300MB)
#   infra/kosit/validator.jar                          (~10MB)
#   infra/kosit/scenarios.xml
#   infra/kosit/repository/                            (~2.5MB)
#     xsd/maindoc/UBL-Invoice-2.1.xsd
#     xsd/common/UBL-Common*.xsd
#     xsd/common/UBL-QualifiedDataTypes-2.1.xsd
#     xsd/common/UBL-UnqualifiedDataTypes-2.1.xsd
#     xsd/common/CCTS_CCT_SchemaModule-2.1.xsd
#     xsd/common/UBL-ExtensionContentDataType-2.1.xsd
#     schematron/ubl/XRechnung-UBL-validation.xsl
#     schematron/ubl/XRechnung-UBL-validation.sch
#     schematron/common.sch
#     report.xsl
#
# Idempotent — re-running is safe; existing files are left
# alone.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

KOSIT_DIR="$SCRIPT_DIR"
JAVA_DIR="$(dirname "$SCRIPT_DIR")/java"

note() { echo -e "\033[1;34m[setup-kosit]\033[0m $1"; }
ok() { echo -e "\033[1;32m[setup-kosit] OK\033[0m $1"; }
fail() { echo -e "\033[1;31m[setup-kosit] FAIL\033[0m $1" >&2; exit 1; }

# ───── 1. JDK 17 (Eclipse Temurin portable) ─────
JDK_DIR="$JAVA_DIR/jdk-17.0.13+11"
if [[ -x "$JDK_DIR/Contents/Home/bin/java" ]]; then
  ok "JDK 17 already present: $JDK_DIR"
else
  note "Downloading JDK 17 (Eclipse Temurin, ~185MB)..."
  mkdir -p "$JAVA_DIR"
  cd "$JAVA_DIR"
  JDK_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.13_11.tar.gz"
  if curl -sSL -o /tmp/jdk17.tar.gz "$JDK_URL"; then
    tar -xzf /tmp/jdk17.tar.gz
    rm /tmp/jdk17.tar.gz
    ok "JDK 17 installed: $JDK_DIR"
  else
    fail "JDK 17 download failed (URL: $JDK_URL). Install via 'brew install openjdk@17' instead."
  fi
  cd "$KOSIT_DIR"
fi

# ───── 2. KoSIT Validator JAR (v1.6.2) ─────
if [[ -f "$KOSIT_DIR/validator.jar" ]]; then
  ok "validator.jar already present"
else
  note "Downloading KoSIT Validator 1.6.2 (~10MB)..."
  curl -sSL -o "$KOSIT_DIR/validator.jar" \
    "https://github.com/itplr-kosit/validator/releases/download/v1.6.2/validator-1.6.2-standalone.jar"
  ok "validator.jar installed"
fi

# ───── 3. UBL 2.1 XSDs (maindoc + common) ─────
REPO_DIR="$KOSIT_DIR/repository"
mkdir -p "$REPO_DIR/xsd/maindoc" "$REPO_DIR/xsd/common" "$REPO_DIR/schematron/ubl" "$REPO_DIR/schematron/cii"
if [[ -f "$REPO_DIR/xsd/maindoc/UBL-Invoice-2.1.xsd" ]]; then
  ok "UBL 2.1 XSDs already present"
else
  note "Downloading UBL 2.1 XSDs..."
  OASIS_BASE="https://docs.oasis-open.org/ubl/os-UBL-2.1/xsd"
  curl -sSL "$OASIS_BASE/maindoc/UBL-Invoice-2.1.xsd" -o "$REPO_DIR/xsd/maindoc/UBL-Invoice-2.1.xsd"
  for f in UBL-CommonAggregateComponents-2.1.xsd UBL-CommonBasicComponents-2.1.xsd UBL-CommonExtensionComponents-2.1.xsd; do
    curl -sSL "$OASIS_BASE/common/$f" -o "$REPO_DIR/xsd/common/$f"
  done
  for f in UBL-QualifiedDataTypes-2.1.xsd UBL-ExtensionContentDataType-2.1.xsd UBL-UnqualifiedDataTypes-2.1.xsd CCTS_CCT_SchemaModule-2.1.xsd; do
    curl -sSL "$OASIS_BASE/common/$f" -o "$REPO_DIR/xsd/common/$f"
  done
  ok "UBL 2.1 XSDs installed"
fi

# ───── 4. XRechnung 3.0.2 schematron ─────
if [[ -f "$REPO_DIR/schematron/ubl/XRechnung-UBL-validation.xsl" ]]; then
  ok "XRechnung 3.0.2 schematron already present"
else
  note "Downloading XRechnung 3.0.2 schematron (v2.5.0)..."
  TMP=$(mktemp -d)
  cd "$TMP"
  curl -sSL -o xrechnung.zip \
    "https://github.com/itplr-kosit/xrechnung-schematron/releases/download/v2.5.0/xrechnung-3.0.2-schematron-2.5.0.zip"
  unzip -o -q xrechnung.zip
  # Copy ubl + common into the schematron directory
  cp schematron/ubl/XRechnung-UBL-validation.sch "$REPO_DIR/schematron/ubl/"
  cp schematron/ubl/XRechnung-UBL-validation.xsl "$REPO_DIR/schematron/ubl/"
  cp schematron/common.sch "$REPO_DIR/schematron/"
  cp -R schematron/ubl/. "$REPO_DIR/schematron/ubl/" 2>/dev/null || true
  cp -R schematron/cii/. "$REPO_DIR/schematron/cii/" 2>/dev/null || true
  cd "$KOSIT_DIR"
  rm -rf "$TMP"
  ok "XRechnung 3.0.2 schematron installed"
fi

# ───── 5. Default report.xsl (KoSIT's printable report template) ─────
if [[ -f "$REPO_DIR/report.xsl" ]]; then
  ok "report.xsl already present"
else
  note "Downloading report.xsl..."
  curl -sSL -o "$REPO_DIR/report.xsl" \
    "https://raw.githubusercontent.com/itplr-kosit/validator/v1.6.2/src/test/resources/examples/simple/repository/report.xsl"
  # The report.xsl uses unparsed-text('some.txt') — we need a
  # placeholder file.
  echo "de-invoice" > "$REPO_DIR/some.txt"
  ok "report.xsl + some.txt installed"
fi

# ───── 6. scenarios.xml (if missing) ─────
if [[ ! -f "$KOSIT_DIR/scenarios.xml" ]]; then
  note "Note: scenarios.xml is checked into the repo. If you deleted it, restore it from git."
  fail "scenarios.xml missing"
fi

# ───── 7. Smoke test ─────
note "Smoke test: KoSIT Validator --help"
JAVA_BIN="$JDK_DIR/Contents/Home/bin/java"
"$JAVA_BIN" -jar "$KOSIT_DIR/validator.jar" --help 2>&1 | head -1
if [[ $? -eq 0 ]]; then
  ok "KoSIT Validator is working"
else
  fail "KoSIT Validator smoke test failed"
fi

echo
ok "Setup complete. Run the e2e test:"
echo "    bash backend/e2e/140-tier116-kosIT.sh"
echo
echo "Or validate an XRechnung document via the API:"
echo "    GET /api/v1/invoices/:id/xrechnung/validate?engine=kosit&companyId=..."
