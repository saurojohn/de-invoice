/**
 * UStVA / UStJA export files (§ 18 UStG).
 *
 * Tier 734 — the UStVA's XML is the declaration as ELSTER's data delivery
 * carries it: the block <Anmeldungssteuern> of the ERiC data type „UStVA",
 * as in the ERiC example „UStVA_2023.xml" (quoted on the ELSTER user forum,
 * thread 429585, 02.08.2023) and as ELSTER's support described it there
 * (namespace http://finkonsens.de/elster/elsteranmeldung/ustva/v<year>,
 * attribute version="<year>"): Erstellungsdatum, DatenLieferant, Steuerfall /
 * Umsatzsteuervoranmeldung with Jahr, Zeitraum (01–12 a month, 41–44 a
 * quarter), the 13-digit Steuernummer (common/steuernummer.ts) and one
 * element per Kennzahl, in the order of their numbers — the schema demands
 * its order (ERiC: „element 'Kz09' is not allowed for content model
 * (Jahr?,Zeitraum?,Steuernummer?,Kz09?,Kz10?,Kz21?,…,Kz98?)").
 * A tax base is a whole number of euros („Tragen Sie bei den
 * Bemessungsgrundlagen bitte nur Beträge in vollen Euro ein", ELSTER's
 * Anleitung zur UStVA 2026), cents dropped in the company's favour; a tax
 * amount has two decimals and a point (the ERiC example: <Kz81>150000</Kz81>,
 * <Kz66>15000.00</Kz66>). Kz 83 is what ELSTER computes from those values —
 * the tax on Kz 81 / 86 / 89 / 93 from the whole-euro base — so it can differ
 * from the invoices' tax by cents (the example: 150 000 × 19 % + 25 000 × 7 %
 * + 1 600 − 15 000 + 200 = 17 050,00 = its Kz 83).
 *
 * What these files are NOT: an ELSTER upload — no signature, no transmission,
 * no check against the official schema (below).
 *
 * Before Tier 734 the file was a <Datenlieferung> of this app's own making —
 * Verarbeitungsinformationen, TransferHeader, <Anlage USTVA="1"> and lines
 * „B-Kz081=+000000146000" in cents — no element ELSTER knows, and a
 * Steuernummer made by appending „00". Not checked against the XSD of 2026
 * (behind the ELSTER developer registration); nothing is transmitted, there
 * is no signature. Whether Mein ELSTER imports it is to be tried there.
 *
 * The UStJA's XML (an ERiC „USt" declaration of another structure, not found
 * in public sources) stays a list of its Kennzahlen in this app's own
 * envelope; only its Steuernummer is now the ELSTER one.
 *
 * Kennzahlen (Tier 417): USt 1 A 2026 for the UStVA, USt 2 A 2026 for the
 * UStJA — see ust-kennzahlen.ts.
 */

import { BadRequestException } from '@nestjs/common';
import { businessTodayIso } from '../../common/business-date'
import { UstvaData } from './ustva.service';
import { UstjaResult } from './ustja.service';
import { formYearNotice, KzEntry, ustvaKennzahlen } from './ust-kennzahlen';

/** Tier 734: the company as the data supplier (<DatenLieferant>). */
export interface ElsterCompany {
  name: string;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ElsterUstvaExportInput {
  /** The computed UStVA data */
  data: UstvaData;
  /**
   * Tier 734: the Steuernummer — for the XML the 13-digit ELSTER form
   * (common/steuernummer.ts); for the list as it can be shown.
   */
  steuernummer: string;
  company: ElsterCompany;
  /** Tier 465: a corrected return (§ 153 AO) — Kz 10 = 1 */
  berichtigt?: boolean;
}

/** Tier 465: Kz 10 "Berichtigte Anmeldung" — a flag, "1" when set. */
const KZ10_LINE = 'B-Kz010=1';

/**
 * Tier 107: UStJA ELSTER export input. The annual USt return (§ 18 Abs. 3
 * UStG) — the 12 monthly UStVAs consolidated into the USt 2 A Kennzahlen.
 */
export interface ElsterUstjaExportInput {
  data: UstjaResult
  /** Tier 734: as for the UStVA */
  steuernummer: string
  companyName: string
  filingId?: string
}

/**
 * Format a cent amount as a 13-character signed field.
 * -123.45 EUR -> "-00000012345"
 * 0            -> "+000000000000"
 */
function fmt13(cents: number): string {
  const sign = cents < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(cents));
  const padded = String(abs).padStart(12, '0');
  return sign + padded;
}

/**
 * Render a numeric field as a Kz (Kennzahl) line of the list (and of the
 * UStJA file). "B" prefix = Betrag (amount).
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

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Tier 734: a tax base as the form takes it — whole euros, the cents dropped in the company's favour. */
const wholeEuros = (n: number) => Math.floor(r2(n));

/** Tier 734: the rates at which ELSTER computes the tax of a base Kennzahl itself. */
const ELSTER_TAX_RATE: Record<string, number> = { '81': 0.19, '86': 0.07, '89': 0.19, '93': 0.07 };
/** …the tax amounts that are declared as such, owed / deducted. */
const OWED_TAX = ['36', '47', '85', '98'];
const INPUT_TAX = ['61', '66', '67'];

/**
 * Tier 734: the UStVA's Kennzahlen as ELSTER takes them — bases in whole
 * euros, Kz 83 as ELSTER computes it from them (see the header).
 */
export function elsterUstvaValues(data: UstvaData): { entries: Array<KzEntry & { xml: string }>; kz83: number; kz83Invoices: number } {
  const all = ustvaKennzahlen(data);
  const v = (kz: string) => all.find((e) => e.kz === kz)?.value ?? 0;
  let owed = 0;
  for (const [kz, rate] of Object.entries(ELSTER_TAX_RATE)) owed += r2(wholeEuros(v(kz)) * rate);
  for (const kz of OWED_TAX) owed += v(kz);
  const input = INPUT_TAX.reduce((s, kz) => s + v(kz), 0);
  const kz83 = r2(owed - input - v('39'));
  const entries = all
    .filter((e) => e.kz !== '' && e.kz !== '83' && e.value !== 0)
    .map((e) => ({ ...e, xml: e.kind === 'base' ? String(wholeEuros(e.value)) : r2(e.value).toFixed(2) }))
    .filter((e) => e.xml !== '0')
    .concat([{ ...all.find((e) => e.kz === '83')!, value: kz83, xml: kz83.toFixed(2) }])
    .sort((a, b) => Number(a.kz) - Number(b.kz));
  return { entries, kz83, kz83Invoices: v('83') };
}

/** Tier 734: Zeitraum of the UStVA — the month 01–12, a quarter 41–44. */
function elsterZeitraum(data: UstvaData): string {
  if (data.month) return String(data.month).padStart(2, '0');
  if (data.quarter) return String(40 + data.quarter);
  throw new BadRequestException(
    'Eine Voranmeldung gilt für einen Monat oder ein Quartal — für das ganze Jahr ist die Umsatzsteuererklärung (UStJA) da.',
  );
}

/**
 * Tier 734: the UStVA as ELSTER's <Anmeldungssteuern> (see the header).
 * Returned as a UTF-8 string (no BOM).
 */
export function generateUstvaElsterXml(input: ElsterUstvaExportInput): string {
  const { data, steuernummer, company } = input;
  const year = String(data.year);
  const { entries } = elsterUstvaValues(data);
  const supplier = [
    ['Name', company.name],
    ['Strasse', company.street],
    ['PLZ', company.postalCode],
    ['Ort', company.city],
    ['Telefon', company.phone],
    ['Email', company.email],
  ]
    .filter(([, value]) => value && String(value).trim())
    .map(([tag, value]) => `      <${tag}>${escapeXml(String(value).trim())}</${tag}>`)
    .join('\n');
  const kz = [
    // Tier 465: a corrected return carries Kz 10 = 1
    ...(input.berichtigt ? ['        <Kz10>1</Kz10>'] : []),
    ...entries.map((e) => `        <Kz${e.kz}>${e.xml}</Kz${e.kz}>`),
  ].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v${year}" version="${year}">
  <Erstellungsdatum>${businessTodayIso().replace(/-/g, '')}</Erstellungsdatum>
  <DatenLieferant>
${supplier}
  </DatenLieferant>
  <Steuerfall>
    <Umsatzsteuervoranmeldung>
      <Jahr>${year}</Jahr>
      <Zeitraum>${elsterZeitraum(data)}</Zeitraum>
      <Steuernummer>${escapeXml(steuernummer)}</Steuernummer>
${kz}
    </Umsatzsteuervoranmeldung>
  </Steuerfall>
</Anmeldungssteuern>
`;
}

/**
 * The UStVA's Kennzahlen as a list to transcribe into Mein ELSTER (the
 * format=ascii download).
 */
export function generateUstvaAsciiPreview(input: ElsterUstvaExportInput): string {
  const { data, steuernummer, company } = input;
  const { kz83, kz83Invoices } = elsterUstvaValues(data);
  const entries = ustvaKennzahlen(data).map((e) => (e.kz === '83' ? { ...e, value: kz83 } : e));
  const footer = [`# ${data.counts.invoices} Rechnungen, ${data.counts.expenses} Ausgaben zugrundegelegt.`];
  // Tier 734: Kz 83 as ELSTER computes it from the whole-euro bases
  if (Math.abs(kz83 - kz83Invoices) >= 0.005) {
    footer.unshift(`# Kz 83 wie ELSTER sie aus den Bemessungsgrundlagen in vollen Euro berechnet; nach der Steuer laut Rechnungen ${kz83Invoices.toFixed(2)} €.`);
  }
  const text = fillInList('UStVA', 'USt 1 A 2026', data.year, company.name, steuernummer, data.periodLabel, entries, ['83'], footer);
  // Tier 465: a corrected return — Kz 10 above the amounts.
  return input.berichtigt
    ? text.replace(/\n\n/, `\n\n${KZ10_LINE}   # Berichtigte Anmeldung (§ 153 AO)\n`)
    : text;
}

/**
 * Tier 417: a readable list of the Kennzahlen to enter in Mein ELSTER — the
 * "ASCII preview" called itself a "Mein-ELSTER-Paste-Format", which does not
 * exist. Each line keeps the B-Kz form plus the form's label.
 */
function fillInList(
  what: string,
  form: string,
  year: number,
  companyName: string,
  steuernummer: string,
  period: string,
  entries: KzEntry[],
  always: string[],
  footer: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${what} — Kennzahlen zur Übertragung in Mein ELSTER (Vordruck ${form})`);
  const notice = formYearNotice(year);
  if (notice) lines.push(`# Achtung: ${notice}`);
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
  const { data, steuernummer, companyName, filingId } = input
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
      <Eingangsdatum>${businessTodayIso()}</Eingangsdatum>
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
  const { data, steuernummer, companyName } = input
  return fillInList('UStJA', 'USt 2 A 2026', data.year, companyName, steuernummer, data.periodLabel, ustjaEntries(data), [], [
    `# Umsatzsteuer ${data.totals.umsatzsteuer.toFixed(2)} € − Vorsteuer ${data.totals.vorsteuer.toFixed(2)} € = verbleibende Umsatzsteuer ${data.totals.zahllast.toFixed(2)} €`,
    `# Vorauszahlungssoll (berechnet) ${data.totals.vorauszahlungssoll.toFixed(2)} € — maßgeblich ist das festgesetzte Soll`,
    `# ${data.counts.monthsWithData}/12 Monate mit Daten konsolidiert.`,
  ])
}
