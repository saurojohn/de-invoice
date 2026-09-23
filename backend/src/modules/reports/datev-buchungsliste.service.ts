import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import {
  buildBuchungenFromDb,
  generateDatevBuchungsstapel,
  encodeDatevCsv,
  resolveDatevAccounts,
  DatevExportInput,
  BuchungsSatz,
  DatevAccountMap,
} from './datev.service'

/**
 * Tier 167: DATEV Buchungsliste (per-Sachkonto
 * aggregation) + automatic revenue-side
 * Sachkonto mapping.
 *
 * The Berater's actual workflow: receive a
 * "Buchungsliste" (Excel, one row per Sachkonto
 * with the period-total) from the Buchhalter, not
 * the raw DATEV Buchungsstapel CSV. The
 * Buchungsstapel is the machine-readable form
 * (one row per Buchung = one Soll/Haben pair),
 * the Buchungsliste is the human-readable form
 * (one row per Sachkonto = the Σ of all rows
 * that touched that account).
 *
 * Tier 167 builds both, packaged in a single
 * self-contained ZIP:
 *
 *   Buchungsliste.csv          (per-Sachkonto
 *                                summary: Konto,
 *                                Name, count,
 *                                Σ Soll, Σ Haben,
 *                                Σ Saldo)
 *   Buchungsstapel.csv         (raw DATEV-format
 *                                ledger, what the
 *                                DATEV client
 *                                imports)
 *   USt-Verprobung.csv         (USt per USt-
 *                                Schlüssel: 0/1/2/3
 *                                + IgE 14-16 +
 *                                §13b 12-13)
 *   Kontenplan.csv             (the Sachkonten
 *                                actually used +
 *                                the SKR03 default
 *                                name)
 *   manifest.json              (per-file sha256
 *                                + per-sheet counts
 *                                so the Berater's
 *                                tooling can verify
 *                                the archive)
 *
 * Plus: a NEW mapping table for revenue-side
 * Sachkonten that the existing `DatevAccountMap`
 * doesn't have:
 *
 *   - revenueReverseCharge: 8120 (Erlöse §13b UStG
 *     — B2B services with foreign EU customer where
 *     the Leistungsempfänger is the Steuerschuldner)
 *   - revenueIgE:           8125 (Erlöse innergem.
 *     Lieferung — §1a UStG, B2B goods across EU
 *     border, the seller reports in ZM)
 *   - revenueExport:        8120 (Erlöse Ausfuhr —
 *     §4 UStG, Drittland, tax-free)
 *
 * These are the same default values the DATEV
 * SKR03 Kontenplan publishes; the user can
 * override via Company.settings.datev.* the
 * same way they override revenue19/revenue7.
 *
 * The new fields are detected from the invoice
 * metadata (customer.country + customer.vatId +
 * invoice.ustBehandlung when set) at export
 * time — we don't need a schema migration
 * because the existing BuchungsSatz already
 * carries konto + ustSchluessel.
 */

export interface BuchungslisteOptions {
  companyId: string
  year: number
  // Optional month filter (1-12). When set,
  // restricts the buchungen to that month for
  // both the Buchungsliste + the Buchungsstapel.
  // When undefined, the whole year is used.
  month?: number
}

export interface SachkontoSummary {
  konto: string
  kontoName: string
  count: number
  sumSoll: number
  sumHaben: number
  saldo: number // = sumSoll - sumHaben (positive = Soll-Saldo)
}

export interface UstVerprobungRow {
  ustSchluessel: string
  description: string
  count: number
  sumNet: number
  sumUst: number
  sumBrutto: number
}

export interface BuchungslisteResult {
  zipBuffer: Buffer
  filename: string
  stats: {
    buchungenCount: number
    sachkontenCount: number
    ustSchluesselCount: number
    year: number
    month?: number
    totalSize: number
  }
}

@Injectable()
export class DatevBuchungslisteService {
  private readonly logger = new Logger(DatevBuchungslisteService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the per-company datev config and
   * merge in the Tier 167 revenue-side
   * extensions. Falls back to SKR03 defaults
   * for every field the user hasn't
   * overridden.
   *
   * Why extend the config and not hard-code
   * 8120/8125: some Berater use completely
   * different accounts (e.g. SKR04 uses
   * 4410/4420/4430 for the same situations).
   * The user can override per-company via
   * Company.settings.datev.* the same way as
   * the existing revenue19/revenue7.
   */
  private resolveAccounts(company: any): DatevAccountMap & {
    revenueReverseCharge: string
    revenueIgE: string
    revenueExport: string
  } {
    const settings = (company.settings as any) || {}
    const datev = settings.datev || {}
    const base = resolveDatevAccounts(datev)
    return {
      ...base,
      revenueReverseCharge:
        datev.revenueReverseCharge ?? '8120',
      revenueIgE: datev.revenueIgE ?? '8125',
      revenueExport: datev.revenueExport ?? '8120',
    }
  }

  /**
   * Build the Tier 167 archive: Buchungsliste
   * + Buchungsstapel + USt-Verprobung +
   * Kontenplan + manifest.
   */
  async buildArchive(opts: BuchungslisteOptions): Promise<BuchungslisteResult> {
    if (!opts.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const year = opts.year
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException(
        `Ungültiges Jahr: ${opts.year} (2000-2100)`,
      )
    }
    if (
      opts.month !== undefined &&
      (!Number.isInteger(opts.month) || opts.month < 1 || opts.month > 12)
    ) {
      throw new BadRequestException(
        `Ungültiger Monat: ${opts.month} (1-12)`,
      )
    }
    const company = await this.prisma.company.findUnique({
      where: { id: opts.companyId },
    })
    if (!company) {
      throw new BadRequestException('Unternehmen nicht gefunden')
    }

    const startDate = new Date(Date.UTC(year, (opts.month ?? 1) - 1, 1))
    const endDate = opts.month
      ? new Date(Date.UTC(year, opts.month, 1))
      : new Date(Date.UTC(year + 1, 0, 1))

    // Reuse buildBuchungenFromDb (Tier 26)
    // and the existing SKR03 mapping. The new
    // revenue-side accounts (8120/8125) are
    // layered on top in the per-Sachkonto
    // summary stage.
    const buchungen: BuchungsSatz[] = await buildBuchungenFromDb(
      this.prisma,
      opts.companyId,
      startDate,
      endDate,
    )
    this.logger.log(
      `Datev Buchungsliste for ${company.name} ` +
        `(${opts.companyId}) year=${year}` +
        (opts.month ? ` month=${opts.month}` : '') +
        `: ${buchungen.length} Buchungen`,
    )

    // 1. Buchungsliste — per-Sachkonto
    //    summary. Each Sachkonto gets:
    //      konto, name (from SKR03 if known),
    //      count, sumSoll, sumHaben, saldo
    //    Sort by Konto ASC for the
    //    DATEV-typical presentation.
    const summaries = this.summarizeBySachkonto(buchungen)
    const buchungslisteCsv = this.renderBuchungslisteCsv(summaries)

    // 2. Buchungsstapel — raw DATEV CSV. Reuse
    //    generateDatevBuchungsstapel (Tier 26)
    //    so the format is byte-identical to the
    //    /api/v1/reports/datev-export
    //    endpoint. The Berater can use either
    //    the Buchungsstapel alone (machine
    //    import) or the Buchungsliste alone
    //    (human review) — they're both in
    //    the archive.
    const buchungsstapelCsv = generateDatevBuchungsstapel({
      company: {
        name: company.name,
        taxId: company.taxId ?? undefined,
        beraterNr: (company as any).settings?.datev?.beraterNr || '00000',
        mandantenNr: (company as any).settings?.datev?.mandantenNr || '00001',
      },
      startDate,
      endDate,
      buchungen,
      buchungsLaufNr:
        (company as any).settings?.datev?.laufNr?.[year] || 1,
    } as DatevExportInput)

    // 3. USt-Verprobung. The Berater needs
    //    to see "we declared 19% USt on
    //    €X.XX, 7% USt on €Y.YY, 0% USt on
    //    €Z.ZZ" all in one place so they
    //    can reconcile against the
    //    USt-Voranmeldung. The format is
    //    one row per USt-Schlüssel with
    //    sumNet + sumUst + sumBrutto.
    const ustVerprobung = this.buildUstVerprobung(buchungen)
    const ustVerprobungCsv = this.renderUstVerprobungCsv(ustVerprobung)

    // 4. Kontenplan. Every Sachkonto we
    //    used in the year, with the SKR03
    //    default name (when known) and the
    //    Saldo. This is the "what accounts
    //    are active" snapshot that the
    //    Berater can paste into their own
    //    Kontenplan-Werkzeug.
    const accounts = this.resolveAccounts(company)
    const kontenplanCsv = this.renderKontenplanCsv(summaries, accounts)

    // 5. manifest.json. Per-file sha256 +
    //    per-sheet row counts. The Berater
    //    can re-verify the archive
    //    independently (same BSI TR-03127
    //    self-hash pattern as Tier 166).
    const crypto = require('crypto') as typeof import('crypto')
    const buchungslisteBytes = Buffer.from(buchungslisteCsv, 'utf-8')
    const buchungsstapelBytes = encodeDatevCsv(buchungsstapelCsv)
    const ustVerprobungBytes = Buffer.from(ustVerprobungCsv, 'utf-8')
    const kontenplanBytes = Buffer.from(kontenplanCsv, 'utf-8')
    const manifestPre = {
      schemaVersion: 1,
      generator: 'de-invoice DATEV Buchungsliste',
      generatedAt: new Date().toISOString(),
      company: {
        id: company.id,
        name: company.name,
        taxId: company.taxId,
      },
      year,
      month: opts.month ?? null,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      // Per-file sha256. The Berater can
      // `shasum -a 256` each file in the
      // archive and confirm these match —
      // proves the bytes haven't been
      // changed since export.
      files: [
        {
          path: 'Buchungsliste.csv',
          size: buchungslisteBytes.length,
          sha256: crypto
            .createHash('sha256')
            .update(buchungslisteBytes)
            .digest('hex'),
        },
        {
          path: 'Buchungsstapel.csv',
          size: buchungsstapelBytes.length,
          sha256: crypto
            .createHash('sha256')
            .update(buchungsstapelBytes)
            .digest('hex'),
        },
        {
          path: 'USt-Verprobung.csv',
          size: ustVerprobungBytes.length,
          sha256: crypto
            .createHash('sha256')
            .update(ustVerprobungBytes)
            .digest('hex'),
        },
        {
          path: 'Kontenplan.csv',
          size: kontenplanBytes.length,
          sha256: crypto
            .createHash('sha256')
            .update(kontenplanBytes)
            .digest('hex'),
        },
      ],
      counts: {
        buchungen: buchungen.length,
        sachkonten: summaries.length,
        ustSchluessel: ustVerprobung.length,
      },
    }
    const manifestBytes = Buffer.from(
      JSON.stringify(manifestPre, null, 2),
      'utf-8',
    )
    const selfHash = crypto
      .createHash('sha256')
      .update(manifestBytes)
      .digest('hex')

    // Build the ZIP. archiver v8 — see
    // gobd-export.service.ts (Tier 166) for
    // the same pattern. Don't use
    // `archiver.create` (v6/v7) — v8 is
    // `new archiverLib.ZipArchive({zlib:...})`.
     
    const archiverLib: any = require('archiver')
    const zip = new archiverLib.ZipArchive({ zlib: { level: 6 } })
    const chunks: Buffer[] = []
    zip.on('data', (chunk: Buffer) => chunks.push(chunk))
    const stamp = new Date().toISOString().slice(0, 10)
    const periodLabel = opts.month
      ? `${year}-${String(opts.month).padStart(2, '0')}`
      : String(year)
    const safeCompanyName = company.name.replace(/[^\w.-]/g, '_')

    // Order: structured data first, manifest
    // last (the manifest's sha256 covers the
    // data files; if the manifest is appended
    // first, the bytes change when we add the
    // other files).
    zip.append(buchungslisteBytes, { name: 'Buchungsliste.csv' })
    zip.append(buchungsstapelBytes, { name: 'Buchungsstapel.csv' })
    zip.append(ustVerprobungBytes, { name: 'USt-Verprobung.csv' })
    zip.append(kontenplanBytes, { name: 'Kontenplan.csv' })
    zip.append(
      Buffer.from(
        JSON.stringify(
          {
            ...manifestPre,
            // Same BSI TR-03127 §4.3
            // self-hash pattern as Tier 166:
            // the manifest includes its own
            // SHA-256 (preimage = the manifest
            // serialised WITHOUT this
            // selfHash field). The Berater
            // removes selfHash, re-serialises,
            // and hashes to verify the
            // manifest itself hasn't been
            // tampered with.
            selfHash: {
              algorithm: 'sha256',
              value: selfHash,
              covers: 'all keys except selfHash',
            },
          },
          null,
          2,
        ),
        'utf-8',
      ),
      { name: 'manifest.json' },
    )

    await zip.finalize()
    const zipBuffer = Buffer.concat(chunks)
    const filename = `DATEV-Buchungsliste-${periodLabel}-${safeCompanyName}-${stamp}.zip`

    return {
      zipBuffer,
      filename,
      stats: {
        buchungenCount: buchungen.length,
        sachkontenCount: summaries.length,
        ustSchluesselCount: ustVerprobung.length,
        year,
        month: opts.month,
        totalSize: zipBuffer.length,
      },
    }
  }

  /**
   * Group a list of BuchungsSatz rows by Sachkonto
   * (konto — the Soll-Konto). For each Sachkonto,
   * compute:
   *   - count: number of Buchungen touching it
   *   - sumSoll: Σ betrag where this account is Soll
   *   - sumHaben: Σ betrag where this account is Haben
   *   - saldo: sumSoll - sumHaben
   *
   * The BuchungsSatz also has a `gegenkonto` (Haben)
   * — we need to count that account too, but on
   * the Haben side. So each row contributes to
   * two accounts: konto as Soll, gegenkonto as
   * Haben. (Some Buchungen have a Soll/Haben flip
   * via the `shVz` field — we respect that.)
   */
  private summarizeBySachkonto(
    buchungen: BuchungsSatz[],
  ): SachkontoSummary[] {
    const map = new Map<string, SachkontoSummary>()
    const add = (konto: string, betrag: number, side: 'S' | 'H') => {
      const existing = map.get(konto)
      if (existing) {
        if (side === 'S') existing.sumSoll += betrag
        else existing.sumHaben += betrag
        existing.count++
      } else {
        map.set(konto, {
          konto,
          kontoName: SKR03_NAMES[konto]
            ?? (/^\d{5}$/.test(konto) ? (Number(konto) >= 70000 ? 'Kreditor' : 'Debitor') : ''),
          count: 1,
          sumSoll: side === 'S' ? betrag : 0,
          sumHaben: side === 'H' ? betrag : 0,
          saldo: side === 'S' ? betrag : -betrag,
        })
      }
    }
    // Tier 423: a row with a tax key carries the gross amount — DATEV splits
    // the tax off the Gegenkonto onto the tax account. Do the same here, so
    // the list shows 8400 net and 1776 with the tax, as in DATEV.
    for (const b of buchungen) {
      const raw = Number(b.betrag) || 0
      if (raw === 0) continue
      const betrag = Math.abs(raw)
      const flip = raw < 0
      const declared: 'S' | 'H' = b.shVz === 'H' ? 'H' : 'S'
      const kontoSide: 'S' | 'H' = flip ? (declared === 'S' ? 'H' : 'S') : declared
      const gegenSide: 'S' | 'H' = kontoSide === 'S' ? 'H' : 'S'
      const tax = b.steuerKonto ? Math.abs(Number(b.ustBetrag) || 0) : 0
      add(b.konto, betrag, kontoSide)
      add(b.gegenkonto, Math.round((betrag - tax) * 100) / 100, gegenSide)
      if (tax > 0) add(b.steuerKonto!, tax, gegenSide)
    }
    for (const s of map.values()) {
      s.saldo = s.sumSoll - s.sumHaben
      // Round to 2 decimals — DATEV uses 2dp
      // for EUR amounts.
      s.sumSoll = Math.round(s.sumSoll * 100) / 100
      s.sumHaben = Math.round(s.sumHaben * 100) / 100
      s.saldo = Math.round(s.saldo * 100) / 100
    }
    return Array.from(map.values()).sort((a, b) =>
      a.konto.localeCompare(b.konto),
    )
  }

  private renderBuchungslisteCsv(rows: SachkontoSummary[]): string {
    const header = [
      'Konto',
      'KontoBezeichnung',
      'AnzahlBuchungen',
      'SummeSoll',
      'SummeHaben',
      'Saldo',
    ]
    const lines: string[] = [header.join(';')]
    for (const r of rows) {
      lines.push(
        [
          r.konto,
          r.kontoName,
          r.count,
          r.sumSoll.toFixed(2).replace('.', ','),
          r.sumHaben.toFixed(2).replace('.', ','),
          r.saldo.toFixed(2).replace('.', ','),
        ].join(';'),
      )
    }
    // Add a totals row for the Berater's
    // Rechnungsprüfung — the sum of all Salden
    // MUST be 0 (every Soll has a matching
    // Haben). If it's not, there's a bug in
    // buildBuchungenFromDb.
    const totalSoll = rows.reduce((s, r) => s + r.sumSoll, 0)
    const totalHaben = rows.reduce((s, r) => s + r.sumHaben, 0)
    const totalSaldo = rows.reduce((s, r) => s + r.saldo, 0)
    lines.push(
      [
        'TOTAL',
        '',
        rows.reduce((s, r) => s + r.count, 0),
        totalSoll.toFixed(2).replace('.', ','),
        totalHaben.toFixed(2).replace('.', ','),
        totalSaldo.toFixed(2).replace('.', ','),
      ].join(';'),
    )
    return lines.join('\n')
  }

  private buildUstVerprobung(buchungen: BuchungsSatz[]): UstVerprobungRow[] {
    // One row per DATEV tax key. Tier 423: a row's amount is gross and its
    // ustBetrag the tax in it (they used to be separate net and tax rows,
    // told apart by invented keys). A credit note is negative and subtracts.
    // For igE / § 13b (18/19, 91/94) the row is net and the tax owed — equal
    // to the input tax — is derived from the rate.
    const map = new Map<string, UstVerprobungRow>()
    for (const b of buchungen) {
      if (b.ustSchluessel === undefined) continue // bank, payments, EB
      const key = b.ustSchluessel || '0'
      const sign = Number(b.betrag) < 0 ? -1 : 1
      const gross = Math.abs(Number(b.betrag) || 0) * sign
      const tax = Math.abs(Number(b.ustBetrag) || 0) * sign
      const row = map.get(key) ?? {
        ustSchluessel: key,
        description: UST_DESCRIPTION[key] ?? `Schlüssel ${key}`,
        count: 0,
        sumNet: 0,
        sumUst: 0,
        sumBrutto: 0,
      }
      row.count++
      row.sumNet += gross - tax
      row.sumUst += tax
      map.set(key, row)
    }
    for (const row of map.values()) {
      const rate = UST_RATE[row.ustSchluessel] ?? 0
      if (row.sumUst === 0 && rate > 0 && SELF_ASSESSED.has(row.ustSchluessel)) {
        row.sumUst = row.sumNet * rate
      }
      row.sumNet = Math.round(row.sumNet * 100) / 100
      row.sumUst = Math.round(row.sumUst * 100) / 100
      row.sumBrutto = Math.round((row.sumNet + row.sumUst) * 100) / 100
    }
    return Array.from(map.values()).sort((a, b) =>
      Number(a.ustSchluessel) - Number(b.ustSchluessel),
    )
  }

  private renderUstVerprobungCsv(rows: UstVerprobungRow[]): string {
    const header = [
      'UStSchluessel',
      'Beschreibung',
      'Anzahl',
      'SummeNetto',
      'SummeUSt',
      'SummeBrutto',
    ]
    const lines: string[] = [header.join(';')]
    for (const r of rows) {
      lines.push(
        [
          r.ustSchluessel,
          r.description,
          r.count,
          r.sumNet.toFixed(2).replace('.', ','),
          r.sumUst.toFixed(2).replace('.', ','),
          r.sumBrutto.toFixed(2).replace('.', ','),
        ].join(';'),
      )
    }
    return lines.join('\n')
  }

  private renderKontenplanCsv(
    summaries: SachkontoSummary[],
    _accounts: DatevAccountMap & {
      revenueReverseCharge: string
      revenueIgE: string
      revenueExport: string
    },
  ): string {
    // Two sections:
    //   Section 1: SKR03 default mapping
    //   Section 2: actually used in this period
    // The Berater can use Section 1 to confirm
    // "the per-company override didn't break
    // anything" and Section 2 for the actual
    // Buchungsliste.
    const lines: string[] = []
    // Tier 423: the accounts this company actually books on (its overrides
    // included), not a fixed list that disagreed with SKR03.
    lines.push('# Kontenzuordnung (SKR03-Standard, ggf. überschrieben)')
    lines.push('Konto;KontoBezeichnung;Verwendung')
    for (const [field, label] of ACCOUNT_USAGE) {
      const konto = (_accounts as any)[field]
      if (konto) lines.push([konto, SKR03_NAMES[konto] ?? '', label].join(';'))
    }
    lines.push('10000-69999;Debitoren;ein Personenkonto je Kunde')
    lines.push('70000;Diverse Kreditoren;Ausgaben ohne Lieferant')
    lines.push('70001-99999;Kreditoren;ein Personenkonto je Lieferant')
    lines.push('')
    lines.push('# Aktive Konten in diesem Zeitraum')
    lines.push('Konto;KontoBezeichnung;Saldo')
    for (const s of summaries) {
      lines.push(
        [
          s.konto,
          s.kontoName || '(unbekannt)',
          s.saldo.toFixed(2).replace('.', ','),
        ].join(';'),
      )
    }
    return lines.join('\n')
  }
}

/**
 * Subset of the SKR03 Kontenplan that this
 * project touches. The full SKR03 has ~2000
 * accounts; we only need the names for the
 * ~15 accounts we actually book against.
 * Missing entries render as blank in the CSV
 * (the Berater recognises the account by
 * number, not by name).
 */
const ACCOUNT_USAGE: [string, string][] = [
  ['bank', 'Bank'],
  ['cash', 'Kasse'],
  ['transit', 'Geldtransit'],
  ['receivable', 'Forderungen (Sammelkonto)'],
  ['payable', 'Verbindlichkeiten (Sammelkonto)'],
  ['revenue19', 'Erlöse 19 %'],
  ['revenue7', 'Erlöse 7 %'],
  ['revenue0', 'innergemeinschaftliche Lieferungen'],
  ['revenueExport', 'Ausfuhrlieferungen'],
  ['revenueExempt', 'sonstige steuerfreie Umsätze'],
  ['revenue13b', 'Leistungen nach § 13b UStG'],
  ['revenueEuServices', 'Leistungen im übrigen EU-Gebiet (§ 13b)'],
  ['revenueThirdCountryServices', 'Leistungen im Drittland'],
  ['revenueKleinunternehmer', 'Erlöse Kleinunternehmer'],
  ['vatPayable19', 'Umsatzsteuer 19 %'],
  ['vatPayable7', 'Umsatzsteuer 7 %'],
  ['outputVatIgE', 'Umsatzsteuer igE'],
  ['outputVat13b', 'Umsatzsteuer § 13b'],
  ['inputVat19', 'Vorsteuer 19 %'],
  ['inputVat7', 'Vorsteuer 7 %'],
  ['inputVatIgE', 'Vorsteuer igE'],
  ['inputVatReverseCharge', 'Vorsteuer § 13b'],
  ['expenseDefault', 'Aufwand ohne eigenes Konto'],
]

const SKR03_NAMES: Record<string, string> = {
  '1000': 'Kasse',
  '1360': 'Geldtransit',
  '1200': 'Bank',
  '1600': 'Verbindlichkeiten aus Lieferungen und Leistungen',
  '1406': 'Forderungen aus Lieferungen und Leistungen',
  '1571': 'Abziehbare Vorsteuer 7 %',
  '1574': 'Abziehbare Vorsteuer aus innergemeinschaftlichem Erwerb 19 %',
  '1576': 'Abziehbare Vorsteuer 19 %',
  '1577': 'Abziehbare Vorsteuer nach § 13b UStG 19 %',
  '1590': 'Durchlaufende Posten',
  '1771': 'Umsatzsteuer 7 %',
  '1774': 'Umsatzsteuer aus innergemeinschaftlichem Erwerb 19 %',
  '1776': 'Umsatzsteuer 19 %',
  '1787': 'Umsatzsteuer nach § 13b UStG 19 %',
  '8100': 'Steuerfreie Umsätze § 4 Nr. 8 ff. UStG',
  '8195': 'Erlöse als Kleinunternehmer (§ 19 UStG)',
  '8336': 'Erlöse aus im anderen EU-Land steuerpflichtigen Leistungen (§ 13b)',
  '8337': 'Erlöse aus Leistungen nach § 13b UStG',
  '8338': 'Erlöse aus im Drittland steuerbaren Leistungen',
  '4900': 'Sonstige betriebliche Aufwendungen',
  '8400': 'Erlöse 19% USt',
  '8300': 'Erlöse 7% USt',
  '8125': 'Erlöse 0% USt (innergemeinschaftliche Lieferung)',
  '8120': 'Steuerfreie Umsätze § 4 Nr. 1a UStG (Ausfuhr)',
  '9000': 'Saldenvorträge Sachkonten',
}

/**
 * DATEV tax key → rate and description (Tier 423: DATEV's standard keys; see
 * datev-ust-schluessel.ts).
 */
const UST_RATE: Record<string, number> = {
  '0': 0,
  '2': 0.07,
  '3': 0.19,
  '5': 0.16,
  '7': 0.16,
  '8': 0.07,
  '9': 0.19,
  '18': 0.07,
  '19': 0.19,
  '91': 0.07,
  '94': 0.19,
}
const SELF_ASSESSED = new Set(['18', '19', '91', '94'])

const UST_DESCRIPTION: Record<string, string> = {
  '0': 'ohne Steuerschlüssel (steuerfrei / nicht steuerbar / ohne Vorsteuer)',
  '2': 'Umsatzsteuer 7 %',
  '3': 'Umsatzsteuer 19 %',
  '5': 'Umsatzsteuer 16 %',
  '7': 'Vorsteuer 16 %',
  '8': 'Vorsteuer 7 %',
  '9': 'Vorsteuer 19 %',
  '18': 'innergemeinschaftlicher Erwerb 7 % (USt = Vorsteuer)',
  '19': 'innergemeinschaftlicher Erwerb 19 % (USt = Vorsteuer)',
  '91': '§ 13b UStG 7 %, Leistungsempfänger schuldet (USt = Vorsteuer)',
  '94': '§ 13b UStG 19 %, Leistungsempfänger schuldet (USt = Vorsteuer)',
}
