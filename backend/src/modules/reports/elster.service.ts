/**
 * UStVA / UStJA export files (§ 18 UStG).
 *
 * What these files are: the declared amounts under their official
 * Kennzahlen, for review and for transcription into Mein ELSTER. What they
 * are NOT: an ELSTER upload. Tier 417 removed this header's claim that the
 * XML was "suitable for upload … one upload away from being filed": nothing
 * here follows a verified ERiC schema (the container format is §9 item 9 of
 * HANDOFF), there is no signature and no submission path. The Steuernummer
 * handling below is likewise unverified.
 *
 * Kennzahlen (Tier 417): USt 1 A 2026 for the UStVA, USt 2 A 2026 for the
 * UStJA — see ust-kennzahlen.ts. Before, both exports used an invented
 * numbering: bases in "Kz 20-23", tax in "Kz 26-29", input tax in
 * "Kz 56-60" and the amount payable in "Kz 81", which on the form is the
 * 19 % tax base.
 *
 * Amounts are written in cents, signed ("B-Kz081=+000000100000").
 */

import { UstvaData } from './ustva.service';
import { UstjaResult } from './ustja.service';
import { KzEntry, ustvaKennzahlen } from './ust-kennzahlen';

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
 * Tier 107: UStJA ELSTER export input. The annual
 * USt return (§ 18 Abs. 3 UStG) consolidates the 12
 * monthly UStVAs into the BMF Vordruck 2024 Kz
 * fields — same Datenlieferung envelope as UStVA,
 * but the Anlage name is "AnlageUStJA" + the
 * Zeitraum is the full calendar year (no Quartal
 * or Monat). The BMF has required UStJA
 * submission via ELSTER since 2024.
 */
export interface ElsterUstjaExportInput {
  data: UstjaResult
  taxNumber: string
  companyName: string
  filingId?: string
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
function kzLine(kz: number | string, cents: number): string {
  return `B-Kz${String(kz).padStart(3, '0')}=${fmt13(cents)}`;
}

/**
 * Tier 417: the Kennzahl lines of a form, from ust-kennzahlen.ts. A base
 * whose tax the form computes itself (Kz 81, 86, 89, 93; 177, 275, 781,
 * 793) is written without that tax. Lines without a Kennzahl or with 0 are
 * left out, except `always`.
 */
function kzLines(entries: KzEntry[], always: string[] = []): string[] {
  return entries
    .filter((e) => e.kz !== '' && (e.value !== 0 || always.includes(e.kz)))
    .map((e) => kzLine(e.kz, Math.round(e.value * 100)));
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

  // Tier 417: the official USt 1 A 2026 Kennzahlen (ust-kennzahlen.ts);
  // Kz 83 (verbleibende Vorauszahlung / Überschuss) is always written.
  const kzBlock = kzLines(ustvaKennzahlen(data), ['83']).join('\n        ');

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
  return fillInList('UStVA', 'USt 1 A 2026', companyName, steuernummer, data.periodLabel, ustvaKennzahlen(data), ['83'], [
    `# ${data.counts.invoices} Rechnungen, ${data.counts.expenses} Ausgaben zugrundegelegt.`,
  ]);
}

/**
 * Tier 417: a readable list of the Kennzahlen to enter in Mein ELSTER — the
 * "ASCII preview" called itself a "Mein-ELSTER-Paste-Format", which does not
 * exist. Each line keeps the B-Kz form of the XML plus the form's label.
 */
function fillInList(
  what: string,
  form: string,
  companyName: string,
  steuernummer: string,
  period: string,
  entries: KzEntry[],
  always: string[],
  footer: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${what} — Kennzahlen zur Übertragung in Mein ELSTER (Vordruck ${form})`);
  lines.push(`# Keine amtliche Upload-Datei. Bemessungsgrundlagen werden im Formular in vollen Euro eingetragen;`);
  lines.push(`# die Steuer zu Kz 81/86/89/93 (bzw. 177/275/781/793) berechnet ELSTER selbst.`);
  lines.push(`# Firma:        ${companyName}`);
  lines.push(`# Steuernr.:    ${steuernummer}`);
  lines.push(`# Zeitraum:     ${period}`);
  lines.push(`# Erstellt am:  ${new Date().toLocaleString('de-DE')}`);
  lines.push(``);
  for (const e of entries) {
    if (e.kz === '' ? e.value === 0 : e.value === 0 && !always.includes(e.kz)) continue;
    const kz = e.kz === '' ? '# ohne Kz' : kzLine(e.kz, Math.round(e.value * 100));
    const tax = e.tax != null && e.tax !== 0 ? ` (Steuer lt. Rechnungen: ${e.tax.toFixed(2)} €)` : '';
    lines.push(`${kz}   # ${e.label}${e.kz === '' ? `: ${e.value.toFixed(2)} €` : ''}${tax}`);
  }
  lines.push(``);
  lines.push(...footer);
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

// =============================================================
// Tier 107: UStJA — Umsatzsteuerjahreserklärung ELSTER
// XML (BMF Vordruck 2024, Anlage UStJA).
//
// The annual USt return. Same Datenlieferung
// envelope as the UStVA, but:
//   - AnlageName = "AnlageUStJA" (vs UStVA's
//     "AnlageUStVA")
//   - Zeitraum has neither Quartal nor Monat
//     (whole year only)
//   - Kz numbers are the USt 2 A 2026 fields
//     (Tier 417, ust-kennzahlen.ts)
//
// The 12 monthly UStVAs have already been
// consolidated by the service (see
// UstjaService.compute). What we add here is
// the XML / Kennzahlen-list serialisation — not
// an ELSTER upload (see the header).
// =============================================================

/**
 * Tier 417: the UStJA's lines already carry their USt 2 A 2026 Kennzahl
 * (ust-kennzahlen.ts). Back to KzEntry form: a tax line's value is its `vat`,
 * anything else its `net` / `amount`.
 */
function ustjaEntries(data: UstjaResult): KzEntry[] {
  return data.lines.map((l) => {
    const taxOnly = l.net == null && l.amount == null
    return {
      kz: l.kennziffer,
      label: l.label,
      value: taxOnly ? l.vat ?? 0 : l.net ?? l.amount ?? 0,
      kind: taxOnly ? 'tax' : 'base',
      tax: taxOnly ? undefined : l.vat,
    }
  })
}

/**
 * Build the full <Datenlieferung> XML for UStJA.
 * Returns a UTF-8 string (no BOM).
 */
export function generateUstjaElsterXml(input: ElsterUstjaExportInput): string {
  const { data, taxNumber, companyName, filingId } = input
  const steuernummer = normaliseSteuernummer(taxNumber)
  const jahr = String(data.year)

  // Tier 417: USt 2 A 2026 Kennzahlen, as the UStJA lines carry them.
  const kzBlock = kzLines(ustjaEntries(data)).join('\n        ')

  // Transfer header — Anlage = "AnlageUStJA"
  // (vs UStVA's "AnlageUStVA"). Vorgang = "UStJA".
  const vorgang = filingId ? `Vorgang_${filingId}` : 'Vorgang_UStJA'

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
      <DatenArt>UStJA</DatenArt>
      <AnlageName>AnlageUStJA</AnlageName>
      <Vorgang>UStJA</Vorgang>
      <Zeitraum>
        <Jahr>${jahr}</Jahr>
      </Zeitraum>
    </TransferHeader>
  </Verarbeitungsinformationen>

  <Nutzdaten>
    <Anlage USTJA="1">
      <Steuernummer>${escapeXml(steuernummer)}</Steuernummer>
      <Name>${escapeXml(companyName)}</Name>
      <Zeitraum>
        <Jahr>${jahr}</Jahr>
      </Zeitraum>
      <Kennzahlen>
        ${kzBlock}
      </Kennzahlen>
    </Anlage>
  </Nutzdaten>
</Datenlieferung>
`
}

/**
 * Build a CSV-style "ASCII" preview of the UStJA —
 * useful for developers / tax consultants who
 * want to sanity-check the numbers before
 * uploading to ELSTER.
 */
export function generateUstjaAsciiPreview(input: ElsterUstjaExportInput): string {
  const { data, taxNumber, companyName } = input
  const steuernummer = normaliseSteuernummer(taxNumber)
  return fillInList('UStJA', 'USt 2 A 2026', companyName, steuernummer, data.periodLabel, ustjaEntries(data), [], [
    `# Umsatzsteuer ${data.totals.umsatzsteuer.toFixed(2)} € − Vorsteuer ${data.totals.vorsteuer.toFixed(2)} € = verbleibende Umsatzsteuer ${data.totals.zahllast.toFixed(2)} €`,
    `# Vorauszahlungssoll (berechnet) ${data.totals.vorauszahlungssoll.toFixed(2)} € — maßgeblich ist das festgesetzte Soll`,
    `# ${data.counts.monthsWithData}/12 Monate mit Daten konsolidiert.`,
  ])
}
