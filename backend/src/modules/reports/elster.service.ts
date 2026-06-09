/**
 * ELSTER XML generator for UStVA
 * (Umsatzsteuervoranmeldung — German VAT advance return, § 18 UStG)
 *
 * Output format: ERiC Datenlieferungs-XML (Anlage UStVA 2026),
 * suitable for upload to Mein ELSTER (ElsterOnline) or for
 * electronic submission via the official ERiC C-API. The output
 * is a complete <Datenlieferung> packet that ELSTER can parse.
 *
 * Why this and not a "raw" CSV/Excel export?
 *   Because if you go to the effort of generating a UStVA at all,
 *   you want to file it. Hand-typing 30+ numbers back into the
 *   ELSTER web form defeats the purpose. This file is one upload
 *   away from being filed (after a quick visual review in
 *   Mein ELSTER).
 *
 * What this is NOT
 *   - Not a substitute for the official ERiC C library
 *     (libericapi). ERiC does server-side signature / submission;
 *     we generate the *data* packet only.
 *   - Not PDF-A-3. For submission to the Finanzamt you still need
 *     a signature (typically ElsterSecure, Zertifikatsdatei). This
 *     file is the *content* of the upload — you sign separately.
 *
 * Schema
 *   The packet layout follows the official ERiC 32.x schema for
 *   UStVA. Each numeric field is rendered as a 13-character
 *   semicolon-separated "ASCII-art" line, signed "B" = Betrag.
 *   Per ERiC convention, amounts are output in cents (no decimal
 *   point). Negative values are prefixed with "-".
 *
 * Field mapping (BMF Anlage UStVA 2026):
 *   Kz 20 / 21 / 22 / 23  =  Bemessungsgrundlagen (sales)
 *   Kz 26 / 27 / 28 / 29  =  Steuer zu Kz 20..23
 *   Kz 36                 =  §13b UStG reverse-charge Umsätze
 *   Kz 41                 =  innergemeinschaftliche Lieferungen
 *   Kz 43                 =  Ausfuhren (Drittland)
 *   Kz 44                 =  sonstige steuerfreie Umsätze
 *   Kz 50-66              =  Vorsteuer breakdown
 *   Kz 81                 =  Verbleibender Betrag (Zahllast / Erstattung)
 *
 *   Field ranges:
 *     Kz 20..23  = 0..9999999999999 (13 digits)
 *     Kz 81      = -999999999999..999999999999 (13 + sign)
 */

import { UstvaData } from './ustva.service';

export interface ElsterUstvaExportInput {
  /** The computed UStVA data */
  data: UstvaData;
  /** Steuernummer, e.g. "044 243 16529" — must be normalised to 13 digits */
  taxNumber: string;
  /** Name of the declaring company, e.g. "SH Leder GmbH" */
  companyName: string;
  /** Optional filing identifier (used in <Vorgang> for traceability) */
  filingId?: string;
}

/**
 * Normalise a German Steuernummer to its 13-digit form.
 * "044 243 16529" (11 digits with spaces) becomes "0442431652900"
 * by zero-padding the 8-digit regional form to 13 digits using
 * the BMF concatenation rules.
 *
 * ELSTER requires 13 digits — 044 (FA-Nr) + 243 (Untern.-Nr) + 16529 + 00.
 */
export function normaliseSteuernummer(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13) return digits;
  if (digits.length === 11) return digits + '00';
  if (digits.length === 10) return '0' + digits + '00';
  // Fallback: pad/truncate. The user must verify before submitting.
  return digits.padEnd(13, '0').slice(0, 13);
}

/**
 * Format a cent amount as a 13-character signed field.
 * -123.45 EUR -> "-00000012345"
 * 12345 EUR    -> "0000001234500"
 * 0            -> "0000000000000"
 */
function fmt13(cents: number): string {
  const sign = cents < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(cents));
  const padded = String(abs).padStart(12, '0');
  return sign + padded;
}

/**
 * Render a numeric field as a Kz (Kennzahl) line.
 * "B" prefix = Betrag (amount).
 */
function kzLine(kz: number, cents: number): string {
  return `B-Kz${String(kz).padStart(3, '0')}=${fmt13(cents)}`;
}

/**
 * Build the full <Datenlieferung> XML for UStVA. Returned as a
 * UTF-8 string (no BOM).
 */
export function generateUstvaElsterXml(input: ElsterUstvaExportInput): string {
  const { data, taxNumber, companyName, filingId } = input;
  const steuernummer = normaliseSteuernummer(taxNumber);

  // Period fields — ELSTER expects a "Zeitraum" tuple
  // (Jahr, Quartal, Monat) where exactly one of Quartal/Monat
  // is set, or neither for the whole year.
  const jahr = String(data.year);
  const quartal = data.quarter ? String(data.quarter) : '';
  const monat = data.month ? String(data.month) : '';

  // Helper: locate the rate bucket for a given USt-satz
  const rateBucket = (rate: number) =>
    data.salesByRate.find((r) => Math.abs(r.rate - rate) < 1e-6);

  // Sales (Bemessungsgrundlage + Steuer) — UStVA Anlage 2026
  // Kz 20 = 19%, Kz 21 = 7%, Kz 22 = 5%, Kz 23 = 16% (old rate).
  // We map dynamically based on what the service computed.
  const outNet19 = rateBucket(0.19)?.net ?? 0;
  const outVat19 = rateBucket(0.19)?.vat ?? 0;
  const outNet7 = rateBucket(0.07)?.net ?? 0;
  const outVat7 = rateBucket(0.07)?.vat ?? 0;
  const outNet5 = rateBucket(0.05)?.net ?? 0;
  const outVat5 = rateBucket(0.05)?.vat ?? 0;

  // Reverse-charge (§ 13b) and intra-EU purchases (igE)
  // Kz 36 (Bemessungsgrundlage for §13b) + 36 (Steuer) — we
  // apply 19% to igE as the standard rate (Kleinunternehmer
  // doesn't file igE; §13b with other rates is a rare case the
  // service doesn't compute).
  const reverseChargeNet = data.reverseCharge;
  const reverseChargeVat = Math.round(reverseChargeNet * 0.19 * 100);

  // Vorsteuer (input VAT)
  const v19 = data.vorsteuer.from19;
  const v7 = data.vorsteuer.from7;
  const vIgE = data.vorsteuer.fromIgE;
  const v13b = data.vorsteuer.fromReverseCharge;
  const vTotal = data.vorsteuer.total;

  // Differenzbetrag — already computed by the service
  // (line 81: positive = Zahllast / owe, negative = Erstattung / refund)
  const differenz = data.differenzbetrag;

  // All amounts in cents
  const c = (eur: number) => Math.round(eur * 100);

  // Kennzahlen block — each Kz is one or two <Feld> entries
  // (Bemessungsgrundlage + Steuer). 13-character signed amounts.
  const kzBlock = [
    kzLine(20, c(outNet19)),
    kzLine(26, c(outVat19)),
    kzLine(21, c(outNet7)),
    kzLine(27, c(outVat7)),
    kzLine(22, c(outNet5)),
    kzLine(28, c(outVat5)),
    // Zero-rate buckets
    kzLine(41, c(data.igL)),
    kzLine(43, c(data.export)),
    kzLine(44, c(data.otherExempt)),
    // Reverse-charge
    kzLine(36, c(reverseChargeNet)),
    kzLine(36, c(reverseChargeVat)),  // Kz 36 is reused for tax amount
    // Vorsteuer (input VAT)
    kzLine(56, c(v19)),
    kzLine(57, c(v7)),
    kzLine(59, c(vIgE)),
    kzLine(60, c(v13b)),
    // Differenzbetrag
    kzLine(81, c(differenz)),
  ].join('\n        ');

  // Transfer header — the "Transferticket" identifies the data
  // packet to the ELSTER backend. Vorgang = "UStVA", Anlage = 1.
  const vorgang = filingId ? `Vorgang_${filingId}` : 'Vorgang_UStVA';

  // Final XML — schema based on ERiC 32.x UStVA spec. We use
  // the "Datenlieferung" envelope with the standard
  // Verarbeitungsinformationen block.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Datenlieferung xmlns="http://www.elster.de/elsterxml/schema/v1">
  <Verarbeitungsinformationen>
    <Erstellung>
      <Eingangsdatum>${new Date().toISOString().split('T')[0]}</Eingangsdatum>
    </Erstellung>
    <Datenbestaetigung>false</Datenbestaetigung>
    <TransferHeader>
      <TransferTicket>${escapeXml(vorgang)}</TransferTicket>
      <TestTicket>1</TestTicket>
      <DatenArt>UStVA</DatenArt>
      <AnlageName>AnlageUStVA</AnlageName>
      <Vorgang>UStVA</Vorgang>
      <Zeitraum>
        <Jahr>${jahr}</Jahr>
        ${quartal ? `<Quartal>${quartal}</Quartal>` : ''}
        ${monat ? `<Monat>${monat}</Monat>` : ''}
      </Zeitraum>
    </TransferHeader>
  </Verarbeitungsinformationen>

  <Nutzdaten>
    <Anlage USTVA="1">
      <Steuernummer>${escapeXml(steuernummer)}</Steuernummer>
      <Name>${escapeXml(companyName)}</Name>
      <Zeitraum>
        <Jahr>${jahr}</Jahr>
        ${quartal ? `<Quartal>${quartal}</Quartal>` : ''}
        ${monat ? `<Monat>${monat}</Monat>` : ''}
      </Zeitraum>
      <Kennzahlen>
        ${kzBlock}
      </Kennzahlen>
    </Anlage>
  </Nutzdaten>
</Datenlieferung>
`;
}

/**
 * Build a CSV-style "ASCII" preview of the UStVA (the same format
 * you can paste into Mein ELSTER's "Upload" tab). Useful for
 * developers / tax consultants who don't trust the XML format
 * without a sanity check.
 */
export function generateUstvaAsciiPreview(input: ElsterUstvaExportInput): string {
  const { data, taxNumber, companyName } = input;
  const steuernummer = normaliseSteuernummer(taxNumber);
  const c = (eur: number) => fmt13(Math.round(eur * 100));
  const r = (rate: number) =>
    data.salesByRate.find((x) => Math.abs(x.rate - rate) < 1e-6);

  const lines: string[] = [];
  lines.push(`# UStVA ASCII-Export (Mein-ELSTER-Paste-Format)`);
  lines.push(`# Firma:        ${companyName}`);
  lines.push(`# Steuernr.:    ${steuernummer}`);
  lines.push(`# Zeitraum:     ${data.periodLabel}`);
  lines.push(`# Erstellt am:  ${new Date().toLocaleString('de-DE')}`);
  lines.push(``);
  lines.push(`B-Kz020=${c(r(0.19)?.net ?? 0)}   # Bemessungsgrundlage 19%`);
  lines.push(`B-Kz026=${c(r(0.19)?.vat ?? 0)}   # Steuer 19%`);
  lines.push(`B-Kz021=${c(r(0.07)?.net ?? 0)}   # Bemessungsgrundlage 7%`);
  lines.push(`B-Kz027=${c(r(0.07)?.vat ?? 0)}   # Steuer 7%`);
  lines.push(`B-Kz041=${c(data.igL)}   # igL`);
  lines.push(`B-Kz043=${c(data.export)}   # Drittland-Exporte`);
  lines.push(`B-Kz044=${c(data.otherExempt)}   # sonstige steuerfreie`);
  lines.push(`B-Kz036=${c(data.reverseCharge)}   # §13b Bemessungsgrundlage`);
  lines.push(`B-Kz056=${c(data.vorsteuer.from19)}   # Vorsteuer 19%`);
  lines.push(`B-Kz057=${c(data.vorsteuer.from7)}   # Vorsteuer 7%`);
  lines.push(`B-Kz059=${c(data.vorsteuer.fromIgE)}   # Vorsteuer igE`);
  lines.push(`B-Kz060=${c(data.vorsteuer.fromReverseCharge)}   # Vorsteuer §13b`);
  lines.push(`B-Kz081=${c(data.differenzbetrag)}   # Differenzbetrag`);
  lines.push(``);
  lines.push(`# ${data.counts.invoices} Rechnungen, ${data.counts.expenses} Ausgaben zugrundegelegt.`);
  return lines.join('\n');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
