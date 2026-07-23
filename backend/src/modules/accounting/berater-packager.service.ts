import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { EuerService } from './euer.service'
import { AnlageSService } from './anlage-s.service'
// Tier 92: Anlage V (Vermietung und Verpachtung).
import { AnlageVService } from './anlage-v.service'
import { BilanzService } from './bilanz.service'
import { GuVService } from './guv.service'
import { AnhangService } from './anhang.service'
import { AssetsService } from '../assets/assets.service'
import { Response } from 'express'
import { PassThrough } from 'stream'
import * as archiver from 'archiver'

/**
 * Tier 85: Anlage Steuererklärung packager.
 *
 * Bundles every VORSCHAU report a Berater
 * (Steuerberater) needs at year-end into a
 * single ZIP that the Mandant can hand over:
 *
 *   01_Anlage-EUR.pdf            (tier 76)
 *   02_Anlage-S.pdf              (tier 80)
 *   03_Anlage-V.pdf              (tier 92, optional)
 *   04_Bilanz.pdf                (tier 81)
 *   05_Gewinn-und-Verlustrechnung.pdf   (tier 82)
 *   06_Anhang.pdf                (tier 84)
 *   07_Anlagenverzeichnis.csv    (tier 83)
 *   MANIFEST.md                  (this file)
 *
 * The packager reuses the existing PDF
 * renderers via a PassThrough stream (a
 * stand-in for `res` that captures the PDF
 * bytes instead of writing to a real HTTP
 * response). No refactor of the 5 report
 * services is needed.
 *
 * Tier 92: Anlage V is included conditionally
 * — only when the company has either
 * (a) `settings.anlageV === true` opt-in OR
 * (b) at least one building asset
 * (Grundstueck/Gebaeude). Otherwise the PDF
 * would just show 0s and confuse the Berater.
 *
 * Why PassThrough: each report's renderPdf
 * does `res.setHeader(...)` + `doc.pipe(res) +
 * doc.end()`. A PassThrough satisfies all of
 * those calls (setHeader is a no-op, pipe
 * flows chunks, end() finalises). We collect
 * the chunks and append them as a Buffer
 * entry in the ZIP archive.
 *
 * v1 honestly: the packager is a "delivery
 * packager" — every file inside is a VORSCHAU
 * that the Berater reviews and either accepts
 * or replaces with their own numbers from the
 * SKR03. Same disclaimer as each individual
 * report, plus a top-level "this package is
 * for review, not for filing" notice in the
 * MANIFEST.
 *
 * v2 work (not in scope):
 *   - Add DATEV Buchungsstapel CSV (already
 *     in the GoBD archive — could re-share)
 *   - Add the E-Bilanz XBRL export
 *   - Cryptographic manifest signature
 *     (SHA-256 over the whole package, so the
 *     Berater can verify nothing was tampered
 *     with in transit)
 */
@Injectable()
export class BeraterPackagerService {
  private readonly logger = new Logger(BeraterPackagerService.name)

  constructor(
    private prisma: PrismaService,
    private euer: EuerService,
    private anlageS: AnlageSService,
    private anlageV: AnlageVService,
    private bilanz: BilanzService,
    private guv: GuVService,
    private anhang: AnhangService,
    private assets: AssetsService,
  ) {}

  /**
   * Stream the Berater packager ZIP to the
   * client. Same streaming pattern as
   * GobdArchiveService (archiver v8 class-
   * based API, zip level 9).
   *
   * Tier 92: Anlage V is generated
   * conditionally — only if the company has
   * building assets (Grundstueck/Gebaeude)
   * OR `settings.anlageV === true`. An
   * always-0 Anlage V PDF would just confuse
   * the Berater (looks like missing data,
   * not "this company is not a Vermieter").
   */
  async streamPackage(companyId: string, year: number, res: Response): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) {
      res.status(404).json({ error: 'Company nicht gefunden' })
      return
    }

    const filename = `Berater-Paket_${year}_${this.sanitizeName(company.name)}.zip`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    const archive = new (archiver as any).ZipArchive({ zlib: { level: 9 } })
    archive.on('error', (err: Error) => {
      this.logger.warn(`Berater packager error: ${err.message}`)
      if (!res.headersSent) res.status(500).end()
      else res.end()
    })
    archive.pipe(res)

    // Generate all 5 core PDFs in parallel
    // via renderToBuffer (PassThrough
    // fake-Response captures the PDFKit
    // output for each service's renderPdf).
    const yearEndSnapshot = new Date(year, 11, 31, 23, 59, 59, 999)
    const [
      euerPdf,
      anlageSPdf,
      bilanzPdf,
      guvPdf,
      anhangPdf,
      assetList,
    ] = await Promise.all([
      this.renderToBuffer((sink) => this.euer.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.anlageS.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.bilanz.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.guv.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.anhang.renderPdf(companyId, year, sink)),
      this.prisma.asset.findMany({
        where: {
          companyId,
          OR: [
            { verkauftAm: null },
            { verkauftAm: { gte: yearEndSnapshot } },
          ],
        },
        orderBy: { anschaffungsDatum: 'asc' },
      }),
    ])

    // Tier 92: Anlage V is conditional on
    // (a) the opt-in flag in settings OR
    // (b) at least one building asset in the
    // Anlagenverzeichnis. We check the asset
    // list we just pulled.
    const hasBuildingAssets = assetList.some(
      (a) => a.type === 'Grundstueck' || a.type === 'Gebaeude',
    )
    const settings = (company.settings ?? {}) as Record<string, unknown>
    const anlageVOptIn = settings.anlageV === true
    const includeAnlageV = hasBuildingAssets || anlageVOptIn

    // Append each PDF (numbered so the
    // Berater can sort them in their
    // filing system). Anlage V slot is
    // reserved between Anlage S and Bilanz
    // — the Berater expects "S → V → Bilanz"
    // ordering for typical filings.
    archive.append(euerPdf, { name: '01_Anlage-EUR.pdf' })
    archive.append(anlageSPdf, { name: '02_Anlage-S.pdf' })

    // Tier 92: Anlage V (optional).
    const files: {
      euer: string
      anlageS: string
      anlageV?: string
      bilanz: string
      guv: string
      anhang: string
      assetCsv: string
    } = {
      euer: '01_Anlage-EUR.pdf',
      anlageS: '02_Anlage-S.pdf',
      bilanz: includeAnlageV ? '04_Bilanz.pdf' : '03_Bilanz.pdf',
      guv: includeAnlageV ? '05_Gewinn-und-Verlustrechnung.pdf' : '04_Gewinn-und-Verlustrechnung.pdf',
      anhang: includeAnlageV ? '06_Anhang.pdf' : '05_Anhang.pdf',
      assetCsv: includeAnlageV ? '07_Anlagenverzeichnis.csv' : '06_Anlagenverzeichnis.csv',
    }
    if (includeAnlageV) {
      const anlageVPdf = await this.renderToBuffer((sink) =>
        this.anlageV.renderPdf(companyId, year, sink),
      )
      archive.append(anlageVPdf, { name: '03_Anlage-V.pdf' })
      files.anlageV = '03_Anlage-V.pdf'
    }

    archive.append(bilanzPdf, { name: files.bilanz })
    archive.append(guvPdf, { name: files.guv })
    archive.append(anhangPdf, { name: files.anhang })

    // Anlagenverzeichnis as CSV (lightweight
    // — the actual PDF render lives in the
    // asset pool; the CSV is what the Berater
    // will paste into their DATEV / Anlagen-
    // grid). The CSV includes computed Buchwert
    // + annualAfA so the Berater sees the
    // same numbers as the Bilanz / G+V.
    const csv = this.buildAssetCsv(assetList, yearEndSnapshot)
    archive.append(csv, { name: files.assetCsv })

    // MANIFEST — explains what each file is
    // + the v1 honesty disclaimer.
    const manifest = this.buildManifest(company, year, files)
    archive.append(manifest, { name: 'MANIFEST.md' })

    // Finalize the archive.
    await archive.finalize()
  }

  /**
   * Capture the output of a renderPdf call
   * into a Buffer. The renderPdf methods
   * call `res.setHeader(...)` + `doc.pipe(res) +
   * doc.end()`. A PassThrough stream doesn't
   * have setHeader, so we wrap it in a tiny
   * shim that satisfies the Express Response
   * interface just enough.
   *
   * Critical: the 'end' / 'finish' listeners
   * MUST be attached BEFORE the render
   * call — Node event emitters are sync,
   * so a listener attached after the event
   * fires is missed. The Promise is created
   * eagerly with the listeners attached,
   * then the render is kicked off.
   */
  private async renderToBuffer(
    render: (sink: Response) => Promise<void>,
  ): Promise<Buffer> {
    const chunks: Buffer[] = []
    const stream = new PassThrough()
    const fakeRes: any = Object.assign(stream, {
      setHeader: () => {
        // no-op: the packager sets the
        // outer ZIP headers itself.
      },
      getHeader: () => undefined,
      set: () => {
        // no-op
      },
      status: () => fakeRes,
    })

    // Create the Promise eagerly, with all
    // listeners attached. The 'finish' event
    // on a PassThrough fires when the stream
    // is fully closed (all data consumed + end
    // called). The 'data' events accumulate
    // chunks into our buffer.
    const done = new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('error', (e: Error) => reject(e))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('finish', () => resolve(Buffer.concat(chunks)))
    })

    // Now kick off the render. This is async
    // because of the DB calls; the synchronous
    // pipe + end happen after the DB calls
    // return. By the time the 'finish' event
    // fires, our listener is already attached.
    render(fakeRes).catch((e) => {
      this.logger.warn(`renderToBuffer render error: ${e.message}`)
    })
    return done
  }

  /**
   * Build the Anlagenverzeichnis CSV. The
   * header row is German; the per-row data
   * includes computed Buchwert + annual AfA
   * so the Berater can spot-check against
   * the Bilanz 0100-0500 and the G+V 7a.
   */
  private buildAssetCsv(
    assets: Array<{
      id: string
      type: string
      bezeichnung: string
      anschaffungsDatum: Date
      anschaffungsKosten: any
      nutzungsdauerMonate: number
      restwert: any
      afaMethode: string
      bilanzKonto: string | null
      notiz: string | null
      verkauftAm: Date | null
      verkaufsPreis: any
    }>,
    snapshot: Date,
  ): string {
    const lines: string[] = []
    lines.push('Anlagenverzeichnis (de-invoice v1)')
    lines.push(
      [
        'Position',
        'Typ',
        'Bezeichnung',
        'Anschaffungsdatum',
        'AHK (EUR)',
        'ND (Monate)',
        'Restwert (EUR)',
        'AfA-Methode',
        'Bilanz-Konto',
        'Buchwert 31.12. (EUR)',
        'Jahres-AfA (EUR)',
        'Verkauft am',
        'Verkaufspreis (EUR)',
        'Notiz',
      ].join(';'),
    )
    for (const a of assets) {
      const afa = this.assets.computeAfA(a, snapshot)
      const fmtEur = (n: number) =>
        new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
      const fmtDate = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '')
      lines.push(
        [
          a.bilanzKonto || '',
          a.type,
          a.bezeichnung,
          fmtDate(a.anschaffungsDatum),
          fmtEur(Number(a.anschaffungsKosten)),
          a.nutzungsdauerMonate,
          fmtEur(Number(a.restwert)),
          a.afaMethode,
          a.bilanzKonto || '',
          fmtEur(afa.buchwert),
          fmtEur(afa.annualAfA),
          fmtDate(a.verkauftAm),
          a.verkaufsPreis != null ? fmtEur(Number(a.verkaufsPreis)) : '',
          a.notiz || '',
        ]
          .map((c) => this.csvEscape(c))
          .join(';'),
      )
    }
    return lines.join('\n')
  }

  private csvEscape(v: string | number): string {
    const s = String(v)
    if (!/[;"\n]/.test(s)) return s
    return '"' + s.replace(/"/g, '""') + '"'
  }

  /**
   * Build the MANIFEST.md. German, plain
   * text, readable in any editor or the
   * Berater's DMS. The disclaimer at the
   * top makes the v1 scope explicit.
   *
   * Tier 92: Anlage V is an optional row —
   * only included when the company has
   * building assets (Vermietung use case)
   * OR `settings.anlageV === true`.
   */
  private buildManifest(
    company: { name: string; legalName: string | null; taxId: string | null; vatId: string | null },
    year: number,
    files: { euer: string; anlageS: string; anlageV?: string; bilanz: string; guv: string; anhang: string; assetCsv: string },
  ): string {
    const lines: string[] = []
    lines.push(`# Berater-Paket ${year} — ${company.legalName || company.name}`)
    lines.push('')
    lines.push('Dieses Paket enthält automatisch generierte VORSCHAU-Reports aus de-invoice v1.')
    lines.push('Es ist als Grundlage für die Prüfung durch den Steuerberater gedacht — nicht')
    lines.push('für die direkte Einreichung beim Finanzamt. Die Reports sind ehrliche Vorschauen:')
    lines.push('Positionen, die das System nicht berechnen kann, sind als "nicht ausgewiesen"')
    lines.push('markiert. Der Berater ergänzt diese aus dem SKR03, dem Anlagenverzeichnis')
    lines.push('und den Steuerbescheiden, bevor die finale Einreichung erfolgt.')
    lines.push('')
    lines.push('## Inhalt')
    lines.push('')
    lines.push(`| Datei | Beschreibung |`)
    lines.push(`| --- | --- |`)
    lines.push(`| \`${files.euer}\` | Anlage EÜR (Einnahmen-Überschuss-Rechnung) gem. § 18 EStG — Vorschau. Vorrangig für Kleinunternehmer und Einnahmen-Überschuss-Rechner. |`)
    lines.push(`| \`${files.anlageS}\` | Anlage S (Einkünfte aus selbständiger Arbeit) gem. § 18 EStG — Vorschau. Für Selbständige / Freiberufler. |`)
    if (files.anlageV) {
      lines.push(`| \`${files.anlageV}\` | Anlage V (Einkünfte aus Vermietung und Verpachtung) gem. § 21 EStG — Vorschau. Für Vermieter. Nur enthalten, wenn die Gesellschaft Mietobjekte (Grundstücke / Gebäude) im Anlagenverzeichnis führt. |`)
    }
    lines.push(`| \`${files.bilanz}\` | Bilanz gem. § 266 HGB (Aktiva / Passiva) — Vorschau. Stichtag 31.12.${year}. |`)
    lines.push(`| \`${files.guv}\` | Gewinn- und Verlustrechnung gem. § 275 Abs. 2 HGB (Gesamtkostenverfahren) — Vorschau. |`)
    lines.push(`| \`${files.anhang}\` | Anhang zum Jahresabschluss gem. § 284 / § 285 HGB — Vorschau. Bilanzierungs- und Bewertungsmethoden + Pflichtangaben. |`)
    lines.push(`| \`${files.assetCsv}\` | Anlagenverzeichnis (CSV) — alle Sachanlagen mit linearer AfA, Buchwert zum 31.12. und Jahres-AfA. |`)
    lines.push(`| \`MANIFEST.md\` | Diese Datei — Inhaltsverzeichnis + Vorgehensweise für den Berater. |`)
    lines.push('')
    lines.push('## Stammdaten')
    lines.push('')
    lines.push(`- **Firma:** ${company.legalName || company.name}`)
    lines.push(`- **Geschäftsjahr:** ${year}`)
    lines.push(`- **Stichtag:** 31.12.${year}`)
    if (company.taxId) lines.push(`- **Steuernummer:** ${company.taxId}`)
    if (company.vatId) lines.push(`- **USt-IdNr.:** ${company.vatId}`)
    lines.push(`- **Erstellt am:** ${new Date().toISOString()}`)
    lines.push('')
    lines.push('## Vorgehensweise für den Berater')
    lines.push('')
    lines.push('1. Alle 5 PDFs gegen das Hauptbuch / die Summen- und Saldenliste abgleichen.')
    lines.push('2. Die "nicht ausgewiesen" markierten Positionen aus dem SKR03, dem Anlagen-')
    lines.push('   verzeichnis und den Steuerbescheiden ergänzen.')
    lines.push('3. Die § 285 HGB Pflichtangaben im Anhang (Section V) ausfüllen.')
    lines.push('4. Die Anlagenverzeichnis-CSV gegen das eigene Anlagenverzeichnis abgleichen.')
    lines.push('5. Den finalen Jahresabschluss an die de-invoice-Zahlen anlehnen (oder die')
    lines.push('   de-invoice-Daten an den finalen Abschluss anpassen — Buchführungskreis).')
    lines.push('')
    lines.push('## Hinweise zur Datenbasis')
    lines.push('')
    lines.push('- **Umsatzerlöse:** aus Rechnungen (paid + sent + overdue) inkl. Gutschriften (negativ).')
    lines.push('- **Aufwendungen:** aus gebuchten / abzugsfähigen Ausgaben (Material, Personal, sonstige, Zinsen).')
    lines.push('- **Forderungen / Verbindlichkeiten:** aus offenen Posten zum Stichtag 31.12.')
    lines.push('- **Kundenguthaben:** positive Salden aus dem CustomerCredit-Ledger.')
    lines.push('- **AfA:** lineare AfA über Nutzungsdauer pro Sachanlage; Buchwert zum 31.12. = AK - kumulierte AfA.')
    lines.push('- **Eigenkapital:** Saldoposten in der Bilanz — der Berater ersetzt ihn mit den')
    lines.push('  tatsächlichen Eigenkapital-Positionen aus dem SKR03 / Handelsregister.')
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push('Generiert von **de-invoice** (Tier 85: Anlage Steuererklärung packager).')
    lines.push('Bei Fragen: de-invoice Berater-Dokumentation.')
    return lines.join('\n')
  }

  private sanitizeName(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  }
}
