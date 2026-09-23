import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { EuerService } from './euer.service'
import { AnlageSService } from './anlage-s.service'
// Tier 92: Anlage V (Vermietung und Verpachtung).
import { AnlageVService } from './anlage-v.service'
// Tier 98: Anlage KAP (Kapitalerträge,
// § 20 EStG) — sibling of Anlage S / V.
import { AnlageKAPService } from './anlage-kap.service'
// Tier 100: Anlage G (Gewerbebetrieb, § 15
// EStG) — 4th Anlage form. Pairs with the EÜR.
// Filing order: EÜR → S → V → KAP → G → BWA.
// Anlage G comes AFTER KAP because it's a
// separate form (not the EÜR) and the Berater
// wants to review all Anlagen before the HGB
// reports.
import { AnlageGService } from './anlage-g.service'
// Tier 101: Anlage N (Arbeitnehmereinkünfte,
// § 3 EStG) — 5th Anlage form. For
// Arbeitnehmer + Beamte + Teilzeit-Beschäftigte.
// Filing order: EÜR → S → V → KAP → G → N →
// BWA. Anlage N comes AFTER G because it covers
// a separate Einkunftsart (Anstellung vs.
// Gewerbe) and is filled from a different data
// source (Lohnsteuerbescheinigung, not Buchungen).
import { AnlageNService } from './anlage-n.service'
// Tier 102: KSt 1 (Körperschaftsteuererklärung,
// § 1 Abs. 1 KStG) — primary tax form for
// Kapitalgesellschaften (GmbH, AG, KGaA).
// Anlage G is NOT applicable for GmbH — KSt 1
// replaces it. Filing order: EÜR → S → V →
// KAP → G (if PersG) → KSt 1 (if GmbH/AG) →
// N → BWA. KSt 1 is mutually exclusive with
// Anlage G: the packager includes ONE of them,
// not both. The Rechtsform decides.
import { KSt1Service } from './kst1.service'
// Tier 103: Anlage R (Einkünfte aus Renten und
// Bezügen, § 22 EStG) — 6th Anlage form.
// For retirees / pension recipients (DRV,
// BAV, Riester, Rürup, private Rente). Filing
// order: EÜR → S → V → KAP → G → N → R → BWA.
// Anlage R is mutually exclusive with Rente-
// bezüge from the Geschäftsführer (vs. the
// company itself, which has no Rente).
import { AnlageRService } from './anlage-r.service'
// Tier 104: Anlage Kind (Kinderfreibetrag +
// Kindergeld, § 32 / § 33 / § 33a EStG) —
// 7th Anlage form. For families with children.
// Filing order: EÜR → S → V → KAP → G → N →
// R → Kind → SO → UStJA → GewSt → BWA.
import { AnlageKindService } from './anlage-kind.service'
// Tier 109: Anlage SO (Sonstige Einkünfte,
// § 22 EStG) — 8th Anlage form. Catch-all
// for private Veräußerungsgeschäfte (Krypto /
// Gold / Aktien innerhalb Spekulationsfrist)
// and wiederkehrende Bezüge. Optional —
// auto-include when transactions.length > 0
// OR wiederkehrendeBezuege > 0.
import { AnlageSOService } from './anlage-so.service'
// Tier 113 v2: Anlage SO v2 — same shape as v1 plus
// the loss-verrechnung block (§ 23 Abs. 3 Satz 3-5
// EStG) and the Kz 99 (Verlustvortrag) line. The
// Berater packager now uses the v2 renderer (which
// includes both the v1 math and the new block).
import { AnlageSOV2Service } from './anlage-so-v2.service'
// Tier 110: Anlage AUS (Ausländische Einkünfte,
// § 34d EStG) — 9th Anlage form. The
// international dimension. Freistellung vs
// Anrechnung per DBA, § 8b KStG for KapG
// dividends, Progressionsvorbehalt. Optional —
// auto-include when entries.length > 0.
import { AnlageAUSService } from './anlage-aus.service'
// Tier 105: UStJA (Umsatzsteuerjahreserklärung,
// § 18 Abs. 3 UStG). The annual USt return that
// consolidates the 12 monthly UStVAs. Always
// included for every company with USt obligation
// (Kleinunternehmer § 19 UStG file once a year
// instead of monthly UStVA; the UStJA is then
// their only return). Filing order: EÜR → S → V →
// KAP → G → N → KSt 1 → R → Kind → UStJA →
// GewSt → BWA.
import { UstjaService } from '../reports/ustja.service'
// Tier 106: GewSt-Erklärung (Gewerbesteuererklärung,
// BMF Vordruck GewSt 1A 2024). The standalone
// trade tax return — for ALL gewerbliche companies
// (Einzelunternehmen, PersG, AND KapG). Always
// included (separate Steuerart from ESt/KSt/USt,
// sits between UStJA and the HGB reports).
import { GewstService } from './gewst.service'
import { BilanzService } from './bilanz.service'
import { GuVService } from './guv.service'
import { AnhangService } from './anhang.service'
import { AssetsService } from '../assets/assets.service'
// Tier 95: BwaService for the year-end BWA
// (Betriebswirtschaftliche Auswertung) PDF.
import { BwaService } from '../reports/bwa.service'
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
 *   04_BWA.pdf                   (tier 95, December)
 *   05_Bilanz.pdf                (tier 81)
 *   06_Gewinn-und-Verlustrechnung.pdf   (tier 82)
 *   07_Anhang.pdf                (tier 84)
 *   08_Anlagenverzeichnis.csv    (tier 83)
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
 * Tier 95: BWA is always included. We render
 * the December BWA (full year summary) — the
 * Berater can see the full-year operating
 * result alongside the Bilanz + G+V + Anhang
 * in the year-end ZIP. The BWA's 14 lines
 * (tier 93) include the new Raumkosten /
 * Versicherungen / Werbung / Instandhaltung /
 * Zinserträge / Steuern buckets so the
 * Berater sees the same granular breakdown
 * they'd get from a real DATEV BWA.
 *
 * v2 work (not in scope):
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
    // Tier 98: Anlage KAP service.
    private anlageKAP: AnlageKAPService,
    // Tier 100: Anlage G service.
    private anlageG: AnlageGService,
    // Tier 101: Anlage N service.
    private anlageN: AnlageNService,
    // Tier 102: KSt 1 service.
    private kst1: KSt1Service,
    // Tier 103: Anlage R service.
    private anlageR: AnlageRService,
    // Tier 104: Anlage Kind service.
    private anlageKind: AnlageKindService,
    // Tier 109: Anlage SO service.
    private anlageSo: AnlageSOService,
    // Tier 113 v2: Anlage SO v2 service — loss-
    // verrechnung + CSV/expense import. The v1
    // service is kept for backward compat (the
    // /anlage-so + /anlage-so.pdf endpoints still
    // call v1). The Berater packager uses v2 to
    // get the Kz 99 line + the loss-verrechnung
    // summary block on the PDF.
    private anlageSoV2: AnlageSOV2Service,
    // Tier 110: Anlage AUS service.
    private anlageAus: AnlageAUSService,
    private ustja: UstjaService,
    private gewst: GewstService,
    private bilanz: BilanzService,
    private guv: GuVService,
    private anhang: AnhangService,
    private assets: AssetsService,
    // Tier 95: BWA service for the year-end BWA PDF.
    private bwa: BwaService,
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

    // Generate all 5 core PDFs + the BWA in
    // parallel via renderToBuffer (PassThrough
    // fake-Response captures the PDFKit output
    // for each service's renderPdf).
    //
    // Tier 95: BWA is rendered for the December
    // BWA (month=12) — the full-year summary the
    // Berater wants to see alongside Bilanz +
    // G+V at year-end. The earlier months are
    // available via the regular /bwa endpoint.
    const yearEndSnapshot = new Date(year, 11, 31, 23, 59, 59, 999)
    const [
      euerPdf,
      anlageSPdf,
      bilanzPdf,
      guvPdf,
      anhangPdf,
      bwaPdf,
      assetList,
    ] = await Promise.all([
      this.renderToBuffer((sink) => this.euer.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.anlageS.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.bilanz.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.guv.renderPdf(companyId, year, sink)),
      this.renderToBuffer((sink) => this.anhang.renderPdf(companyId, year, sink)),
      // Tier 95: BWA for December (full year).
      this.renderToBuffer((sink) =>
        this.bwa.renderPdf(companyId, year, 12, sink),
      ),
      // Tier 427: an asset sold during the year belongs in the year's
      // Anlagenverzeichnis as an Abgang — with its book value at the sale and
      // the AfA up to it. It used to disappear from the list the moment it
      // was sold, so the Berater saw neither the disposal nor its AfA.
      this.prisma.asset.findMany({
        where: {
          companyId,
          OR: [
            { verkauftAm: null },
            { verkauftAm: { gte: new Date(yearEndSnapshot.getFullYear(), 0, 1) } },
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

    // Tier 98: Anlage KAP is conditional on
    // (a) the opt-in flag in settings OR
    // (b) at least one bank transaction in
    // the year that matches a Zinsertrag /
    // Dividende heuristic. An always-0 Anlage
    // KAP PDF would mislead the Berater —
    // looks like missing data, not "this
    // company has no investment income".
    const anlageKAPOptIn = settings.anlageKAP === true
    const yearStartSnapshot = new Date(year, 0, 1)
    const bankTxInYear = await this.prisma.bankTransaction.findMany({
      where: {
        companyId,
        valueDate: { gte: yearStartSnapshot, lte: yearEndSnapshot },
      },
      select: { amount: true, purpose: true, counterpartyIban: true },
    })
    const matchedKapTxs = bankTxInYear.filter(
      (tx) =>
        Number(tx.amount) > 0 &&
        /Zins(en)?|Habenzins|Gutschriftszins|Dividende|Ausschüttung/i.test(
          tx.purpose || '',
        ),
    )
    const includeAnlageKAP = anlageKAPOptIn || matchedKapTxs.length > 0

    // Tier 100: Anlage G is conditional on
    // (a) the opt-in flag in settings OR
    // (b) at least one paid/sent/overdue
    // invoice in the year (Gewerbe heuristic)
    // AND the company is NOT a Kapitalgesellschaft
    // (GmbH/AG/KGaA — they file KSt 1 instead,
    // NOT Anlage G). Anlage G and KSt 1 are
    // MUTUALLY EXCLUSIVE: Anlage G is for
    // Einkommensteuer-pflichtige natürliche
    // Personen (§ 15 EStG), KSt 1 is for
    // KSt-pflichtige Körperschaften (§ 1 KStG).
    // The opt-in flag is the forcing function
    // when the heuristic is wrong (e.g. a
    // GmbH-Geschäftsführer with Mitunternehmer-
    // Einkünfte from a separate PersG).
    const anlageGOptIn = settings.anlageG === true
    const invoiceCount = await this.prisma.invoice.count({
      where: {
        companyId,
        issueDate: { gte: yearStartSnapshot, lte: yearEndSnapshot },
        status: { in: ['paid', 'sent', 'overdue'] },
      },
    })
    // Read rechtsform early (also used for KSt 1
    // below) — repeat the look-up only if needed.
    const companyForRechtsform = company
    const rechtsformEarly = (companyForRechtsform as any)?.rechtsform || 'GmbH'
    const isKapitalgesellschaftEarly = [
      'GmbH',
      'AG',
      'KGaA',
      'UG',
    ].includes(rechtsformEarly)
    const includeAnlageG = anlageGOptIn || (invoiceCount > 0 && !isKapitalgesellschaftEarly)

    // Tier 101: Anlage N is conditional on
    // (a) the opt-in flag in settings OR
    // (b) the Lohnsteuerbescheinigung for the
    // year has a non-zero Bruttoarbeitslohn.
    // For pure Freelancer / pure Gewerbe
    // companies (no employment income), the
    // section is empty and excluded.
    const anlageNOptIn = settings.anlageN === true
    const lsbAll = (settings.lohnsteuerbescheinigungen as any) || {}
    const lsbForYear = lsbAll[year] || {}
    const bruttoInYear = Number(lsbForYear.bruttoArbeitslohn) || 0
    const includeAnlageN = anlageNOptIn || bruttoInYear > 0

    // Tier 102: KSt 1 is conditional on
    // (a) the company is a Kapitalgesellschaft
    // (GmbH, AG, KGaA, UG) per Company.rechtsform
    // OR (b) the opt-in flag in settings. The
    // Rechtsform is the primary gate; the opt-in
    // is for cases where the user has a GmbH
    // but the Rechtsform field hasn't been set.
    // Anlage G and KSt 1 are MUTUALLY EXCLUSIVE:
    // Anlage G is for Einkommensteuer-pflichtige
    // natürliche Personen (§ 15 EStG), KSt 1
    // is for KSt-pflichtige Körperschaften
    // (§ 1 KStG). A GmbH is a Körperschaft and
    // files KSt 1, NOT Anlage G. A GbR/OHG is
    // a Personengesellschaft and files Anlage G
    // (for the Einkommensteuer of the Gesellschafter).
    // Reuse the early Rechtsform check from above.
    const isKapitalgesellschaft = isKapitalgesellschaftEarly
    const kst1OptIn = settings.kst1 === true
    const includeKst1 = kst1OptIn || isKapitalgesellschaft

    // Tier 103: Anlage R is conditional on
    // (a) the opt-in flag in settings OR
    // (b) the Rentenbezüge for the year have a
    // non-zero total (any of drv/bav/riester/
    // ruerup/privat/sonstige > 0). The opt-in is
    // for cases where the user knows they have
    // to file Anlage R but haven't entered the
    // Rentenbescheid yet.
    const anlageROptIn = settings.anlageR === true
    const rentenAllForYear = ((settings.renten as any) || {})[year] || {}
    const rentenTotal = (Number(rentenAllForYear.drv) || 0) +
      (Number(rentenAllForYear.bav) || 0) +
      (Number(rentenAllForYear.riester) || 0) +
      (Number(rentenAllForYear.ruerup) || 0) +
      (Number(rentenAllForYear.privat) || 0) +
      (Number(rentenAllForYear.sonstige) || 0)
    const includeAnlageR = anlageROptIn || rentenTotal > 0

    // Tier 104: Anlage Kind is conditional on
    // (a) the opt-in flag in settings OR
    // (b) the Kinder list for the year has at
    // least one entry. The opt-in is for cases
    // where the user knows they have to file
    // Anlage Kind but haven't entered the
    // Kinder list yet.
    const anlageKindOptIn = settings.anlageKind === true
    const kinderAllForYear = ((settings.kinder as any) || {})[year] || []
    const kinderCount = Array.isArray(kinderAllForYear)
      ? kinderAllForYear.length
      : 0
    const includeAnlageKind = anlageKindOptIn || kinderCount > 0

    // Tier 109: Anlage SO auto-include heuristic —
    // include when the user has entered at least one
    // private Veräußerungsgeschäft OR has
    // wiederkehrende Bezüge. v1 ignores the
    // werbungskosten field as the auto-include signal
    // (that's paired with wiederkehrendeBezuege).
    // The opt-in flag `anlageSo === true` forces
    // inclusion regardless of the heuristic.
    const anlageSoOptIn = settings.anlageSo === true
    const anlageSoAllForYear = ((settings.anlageSO as any) || {})[year] || {}
    const soTxCount = Array.isArray(anlageSoAllForYear.transactions)
      ? anlageSoAllForYear.transactions.filter(
          (t: any) => t && (t.description || t.acquisitionDate || t.saleDate),
        ).length
      : 0
    const soWiederkehrendeBezuege = Number(
      anlageSoAllForYear.wiederkehrendeBezuege,
    ) || 0
    const includeAnlageSo =
      anlageSoOptIn || soTxCount > 0 || soWiederkehrendeBezuege > 0

    // Tier 110: Anlage AUS auto-include heuristic —
    // include when the user has entered at least one
    // foreign income entry. The opt-in flag
    // `anlageAus === true` forces inclusion
    // regardless of the heuristic. The § 8b KStG
    // rule (5% non-deductible for KapG dividends)
    // is applied inside the AnlageAUSService
    // based on the Company's rechtsform.
    const anlageAusOptIn = settings.anlageAus === true
    const anlageAusAllForYear = ((settings.anlageAUS as any) || {})[year] || {}
    const ausEntryCount = Array.isArray(anlageAusAllForYear.entries)
      ? anlageAusAllForYear.entries.filter(
          (e: any) =>
            e && (e.country || e.countryName || e.description || e.grossAmount > 0),
        ).length
      : 0
    const includeAnlageAus = anlageAusOptIn || ausEntryCount > 0

    // Append each PDF (numbered so the
    // Berater can sort them in their
    // filing system). Anlage V slot is
    // reserved between Anlage S and BWA
    // — the Berater expects "S → V → BWA"
    // ordering for typical filings. BWA
    // sits between V and Bilanz because
    // it's the bridge between the Anlage
    // forms and the HGB reports. Anlage
    // KAP (tier 98) sits AFTER V — capital
    // income is a separate Einkunftsart
    // from rental income, so filing order
    // is S → V → KAP → BWA.
    archive.append(euerPdf, { name: '01_Anlage-EUR.pdf' })
    archive.append(anlageSPdf, { name: '02_Anlage-S.pdf' })

    // Tier 92: Anlage V (optional).
    // Tier 98: Anlage KAP (optional).
    // Tier 100: Anlage G (optional).
    // Tier 101: Anlage N (optional).
    // Tier 102: KSt 1 (optional, but for GmbH the
    // PRIMARY form, mutually exclusive with Anlage G).
    // Tier 103: Anlage R (optional, for retirees).
    // Tier 104: Anlage Kind (optional, for families).
    // The 9-way conditional shifts all subsequent
    // file numbers. The order is V → KAP → G → N →
    // KSt 1 → R → Kind: rental, capital, gewerbe,
    // arbeitnehmer, kst, rente, kind. Each included
    // form pushes the next slot by 1.
    const files: {
      euer: string
      anlageS: string
      anlageV?: string
      anlageKAP?: string
      anlageG?: string
      anlageN?: string
      kst1?: string
      anlageR?: string
      anlageKind?: string
      anlageSo?: string
      anlageAus?: string
      ustja: string
      gewst: string
      bwa: string
      bilanz: string
      guv: string
      anhang: string
      assetCsv: string
    } = {
      euer: '01_Anlage-EUR.pdf',
      anlageS: '02_Anlage-S.pdf',
      ustja: '00_UStJA.pdf', // will be re-set below
      gewst: '00_GewSt.pdf', // will be re-set below
      bwa: '00_BWA.pdf', // will be re-set below
      bilanz: '00_Bilanz.pdf', // will be re-set below
      guv: '00_Gewinn-und-Verlustrechnung.pdf',
      anhang: '00_Anhang.pdf',
      assetCsv: '00_Anlagenverzeichnis.csv',
    }
    let optionalSlot = 2 // V is the 1st optional after EUR+S
    if (includeAnlageV) {
      const anlageVPdf = await this.renderToBuffer((sink) =>
        this.anlageV.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const vName = `${String(optionalSlot).padStart(2, '0')}_Anlage-V.pdf`
      archive.append(anlageVPdf, { name: vName })
      files.anlageV = vName
    }
    if (includeAnlageKAP) {
      const anlageKAPPdf = await this.renderToBuffer((sink) =>
        this.anlageKAP.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const kapName = `${String(optionalSlot).padStart(2, '0')}_Anlage-KAP.pdf`
      archive.append(anlageKAPPdf, { name: kapName })
      files.anlageKAP = kapName
    }
    if (includeAnlageG) {
      const anlageGPdf = await this.renderToBuffer((sink) =>
        this.anlageG.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const gName = `${String(optionalSlot).padStart(2, '0')}_Anlage-G.pdf`
      archive.append(anlageGPdf, { name: gName })
      files.anlageG = gName
    }
    if (includeAnlageN) {
      const anlageNPdf = await this.renderToBuffer((sink) =>
        this.anlageN.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const nName = `${String(optionalSlot).padStart(2, '0')}_Anlage-N.pdf`
      archive.append(anlageNPdf, { name: nName })
      files.anlageN = nName
    }
    if (includeKst1) {
      const kst1Pdf = await this.renderToBuffer((sink) =>
        this.kst1.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const kst1Name = `${String(optionalSlot).padStart(2, '0')}_KSt1.pdf`
      archive.append(kst1Pdf, { name: kst1Name })
      files.kst1 = kst1Name
    }
    if (includeAnlageR) {
      const anlageRPdf = await this.renderToBuffer((sink) =>
        this.anlageR.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const rName = `${String(optionalSlot).padStart(2, '0')}_Anlage-R.pdf`
      archive.append(anlageRPdf, { name: rName })
      files.anlageR = rName
    }
    if (includeAnlageKind) {
      const anlageKindPdf = await this.renderToBuffer((sink) =>
        this.anlageKind.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const kindName = `${String(optionalSlot).padStart(2, '0')}_Anlage-Kind.pdf`
      archive.append(anlageKindPdf, { name: kindName })
      files.anlageKind = kindName
    }
    // Tier 109: Anlage SO (Sonstige Einkünfte,
    // § 22 EStG) is OPTIONAL — auto-include when
    // transactions.length > 0 OR
    // wiederkehrendeBezuege > 0. Sits between
    // Anlage Kind and UStJA. Position: depends
    // on the optional count (currently 8th
    // optional, so when all are included SO is
    // at slot 10, just before UStJA at 11).
    // Tier 109 also added the `anlageSo` opt-in
    // flag (Company.settings.anlageSo === true).
    //
    // Tier 113 v2: Anlage SO PDF now rendered by
    // AnlageSOV2Service (same v1 layout + the new
    // Verlustverrechnung block + the Kz 99 line).
    // v1 service stays in place for the legacy
    // /anlage-so.pdf endpoint. Filename in the
    // packager is unchanged so existing Berater
    // download scripts still find it.
    if (includeAnlageSo) {
      const anlageSoPdf = await this.renderToBuffer((sink) =>
        this.anlageSoV2.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const soName = `${String(optionalSlot).padStart(2, '0')}_Anlage-SO.pdf`
      archive.append(anlageSoPdf, { name: soName })
      files.anlageSo = soName
    }
    // Tier 110: Anlage AUS (Ausländische Einkünfte,
    // § 34d EStG) is OPTIONAL — auto-include when
    // entries.length > 0. Sits between Anlage SO
    // and UStJA. Position: depends on the
    // optional count (currently 9th optional, so
    // when all are included AUS is at slot 11,
    // just before UStJA at 12). Tier 110 also
    // added the `anlageAus` opt-in flag
    // (Company.settings.anlageAus === true).
    if (includeAnlageAus) {
      const anlageAusPdf = await this.renderToBuffer((sink) =>
        this.anlageAus.renderPdf(companyId, year, sink),
      )
      optionalSlot++
      const ausName = `${String(optionalSlot).padStart(2, '0')}_Anlage-AUS.pdf`
      archive.append(anlageAusPdf, { name: ausName })
      files.anlageAus = ausName
    }
    // Tier 105: UStJA (Umsatzsteuerjahreserklärung)
    // is ALWAYS included for every company with USt
    // obligation. Sits between the Anlage series and
    // the HGB reports (BWA / Bilanz / G+V / Anhang) —
    // it's a separate Steuerart (USt, not ESt/KSt),
    // so it logically belongs with the other
    // Steuererklärungen even though it isn't an
    // "Anlage" form. Position: optionalSlot + 1
    // (3 when 0 optionals, 11 when all 8 are
    // included).
    const ustjaPdf = await this.renderToBuffer((sink) =>
      this.ustja.renderPdf(companyId, year, sink),
    )
    const ustjaSlot = optionalSlot + 1
    const ustjaName = `${String(ustjaSlot).padStart(2, '0')}_UStJA.pdf`
    archive.append(ustjaPdf, { name: ustjaName })
    files.ustja = ustjaName

    // Tier 106: GewSt-Erklärung (Gewerbesteuererklärung,
    // BMF Vordruck GewSt 1A 2024) is ALWAYS included
    // for every gewerbliche company (Einzelunternehmen,
    // PersG, AND KapG). Sits between UStJA and BWA.
    // Position: optionalSlot + 2 (4 when 0 optionals,
    // 12 when all 8 are included).
    const gewstPdf = await this.renderToBuffer((sink) =>
      this.gewst.renderPdf(companyId, year, sink),
    )
    const gewstSlot = optionalSlot + 2
    const gewstName = `${String(gewstSlot).padStart(2, '0')}_GewSt.pdf`
    archive.append(gewstPdf, { name: gewstName })
    files.gewst = gewstName

    // Compute the position of BWA, Bilanz,
    // G+V, Anhang, Anlagenverzeichnis. UStJA
    // (slot N+1) + GewSt (slot N+2) are always
    // included, so the trailing starts at N+3.
    // Tier 109 added Anlage SO as the 8th
    // optional, pushing the trailing from N+2
    // (pre-tier-105) → N+3 (post-tier-106) →
    // unchanged here (SO is conditional, only
    // shifts when included). The bwaNum below
    // is now gewstSlot + 1 regardless of SO.
    const bwaNum = String(gewstSlot + 1).padStart(2, '0')
    const bilanzNum = String(gewstSlot + 2).padStart(2, '0')
    const guvNum = String(gewstSlot + 3).padStart(2, '0')
    const anhangNum = String(gewstSlot + 4).padStart(2, '0')
    const assetCsvNum = String(gewstSlot + 5).padStart(2, '0')
    files.bwa = `${bwaNum}_BWA.pdf`
    files.bilanz = `${bilanzNum}_Bilanz.pdf`
    files.guv = `${guvNum}_Gewinn-und-Verlustrechnung.pdf`
    files.anhang = `${anhangNum}_Anhang.pdf`
    files.assetCsv = `${assetCsvNum}_Anlagenverzeichnis.csv`

    // Tier 95: BWA (always included — full-year
    // summary that complements the HGB
    // reports). The 14-line breakdown
    // (tier 93) is included in the PDF.
    archive.append(bwaPdf, { name: files.bwa })

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
   *
   * Tier 95: BWA is always included as a
   * December (full-year) PDF. The 14-line
   * breakdown gives the Berater the same
   * granular view they'd get from a real
   * DATEV BWA.
   */
  private buildManifest(
    company: { name: string; legalName: string | null; taxId: string | null; vatId: string | null },
    year: number,
    files: { euer: string; anlageS: string; anlageV?: string; anlageKAP?: string; anlageG?: string; anlageN?: string; kst1?: string; anlageR?: string; anlageKind?: string; anlageSo?: string; anlageAus?: string; ustja: string; gewst: string; bwa: string; bilanz: string; guv: string; anhang: string; assetCsv: string },
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
    if (files.anlageKAP) {
      lines.push(`| \`${files.anlageKAP}\` | Anlage KAP (Einkünfte aus Kapitalvermögen) gem. § 20 EStG — Vorschau. Für Privatinvestoren mit Zinserträgen / Dividenden. Nur enthalten, wenn Banktransaktionen als Zins-/Dividendeneingang klassifiziert wurden ODER \`settings.anlageKAP === true\`. Sparer-Pauschbetrag 1.000 EUR (2.000 EUR Zusammenveranlagung) berücksichtigt. 25% Abgeltungssteuer + 5.5% Soli werden erwartet (üblicherweise bereits von der Bank einbehalten). |`)
    }
    if (files.anlageG) {
      lines.push(`| \`${files.anlageG}\` | Anlage G (Einkünfte aus Gewerbebetrieb) gem. § 15 EStG — Vorschau. Für gewerbliche Einzelunternehmen und Personengesellschaften. Pairs with EÜR: § 8/9 GewStG Hinzurechnungen (Kz 4100 — 25% Miete/Pacht) + Kürzungen (Kz 5100 — 50% Kfz-Nutzungsanteil) werden automatisch aus den Buchungen abgeleitet. Die restlichen Hinzu-/Kürzungen sind Platzhalter. Gewerbesteuer-Schätzung (3.5% Steuermesszahl × Hebesatz) ist SEHR grob. Nur enthalten, wenn Rechnungen im Jahr vorhanden ODER \`settings.anlageG === true\`. Für Kapitalgesellschaften (GmbH/AG) ist stattdessen die KSt 1 abzugeben. |`)
    }
    if (files.anlageN) {
      lines.push(`| \`${files.anlageN}\` | Anlage N (Einkünfte aus nichtselbständiger Arbeit) gem. § 3 EStG — Vorschau. Für Arbeitnehmer, Beamte, Gesellschafter-Geschäftsführer mit Anstellung, Teilzeit-Beschäftigte. Daten aus Company.settings.lohnsteuerbescheinigungen (per-year Map der BMF Kz 3-10). Werbungskosten mit Arbeitnehmer-Pauschbetrag 1.230 EUR + manuell eingetragene Werte (Entfernungspauschale, Fortbildung, etc.). Sonderausgaben + Außergewöhnliche Belastungen als Platzhalter. Nur enthalten, wenn Lohnsteuerbescheinigung für das Jahr erfasst ODER \`settings.anlageN === true\`. |`)
    }
    if (files.kst1) {
      lines.push(`| \`${files.kst1}\` | KSt 1 (Körperschaftsteuererklärung) gem. § 1 Abs. 1 KStG — Vorschau. PRIMARY tax form für Kapitalgesellschaften (GmbH, AG, KGaA, UG). Anlage G ist NICHT zutreffend — KSt 1 ersetzt es. KSt 15% + Soli 5.5% + GewSt (default Hebesatz 400 %, kein Freibetrag für GmbH) + KSt-Anrechnung auf GewSt (§ 35 EStG / § 26 KStG: 3.8 × Messbetrag). Liest G+V Jahresüberschuss aus GuVService. KSt-Korrekturen (vGAs, Spenden, Verlustabzug, § 8b KStG) als Platzhalter. Nur enthalten, wenn Company.rechtsform in [GmbH, AG, KGaA, UG] ODER \`settings.kst1 === true\`. |`)
    }
    if (files.anlageR) {
      lines.push(`| \`${files.anlageR}\` | Anlage R (Einkünfte aus Renten und Bezügen) gem. § 22 EStG — Vorschau. Für Rentner / Pensionäre (DRV, BAV, Riester, Rürup, private Leibrenten). Besteuerungsanteil aus BMF-Tabelle (2026: 81 %), Ertragsanteil 50 % (v1) für private Leibrenten. Werbungskosten-Pauschbetrag 102 EUR (Kz 210) auto. Daten aus Company.settings.renten[year]. Nur enthalten, wenn Rentenbezüge für das Jahr erfasst ODER \`settings.anlageR === true\`. |`)
    }
    if (files.anlageKind) {
      lines.push(`| \`${files.anlageKind}\` | Anlage Kind (Kinderfreibetrag + Kindergeld) gem. § 32 / § 33 / § 33a EStG — Vorschau. Für Familien mit Kindern. Kindergeld 250 EUR/Kind (1-3), max 1.000 EUR für 4+ Kinder (Stand 2024). Kinderfreibetrag 7.932 EUR/Kind (6.612 EUR sächliches Existenzminimum + 1.320 EUR BEAfA). Im Festsetzungs-Bescheid wird das MEISTGÜNSTIGE aus (Kindergeld) vs (Kinderfreibetrag × Steuersatz) angewendet. Daten aus Company.settings.kinder[year] (Array von { name, birthDate, kindergeldEligible }). Nur enthalten, wenn Kinder für das Jahr erfasst ODER \`settings.anlageKind === true\`. |`)
    }
    lines.push(`| \`${files.ustja}\` | UStJA (Umsatzsteuerjahreserklärung) gem. § 18 Abs. 3 UStG (BMF Vordruck 2024) — Vorschau. Aggregiert die 12 monatlichen UStVAs (Jan–Dez) zu einer Jahres-USt. Kz 66 (Summe USt) = Σ Monate; Kz 67 (Summe Vorsteuer) = Σ Monate; Kz 68 (Verbleibender Betrag/Zahllast) = Kz 66 - Kz 67; Kz 39 (Sondervorauszahlung) = 1/11 der Jan-UStVA; Kz 69 (Restzahlung) = Kz 68 - Kz 39. BMF-Sätze 19%/7% per Stand 2024. Berater prüft § 1a/§ 13b UStG-Korrekturen, igL-Bestätigungen und EU-OSS-Sachverhalte. v1: vereinfachtes Modell ohne native ELSTER-XML-Übermittlung — Berater überträgt die Zahlen manuell in ELSTER oder seine StB-Software. IMMER enthalten. |`)
    lines.push(`| \`${files.gewst}\` | GewSt-Erklärung (Gewerbesteuererklärung) gem. BMF Vordruck GewSt 1A 2024 — Vorschau. Kz 5 (Steuermessbetrag) = Gewerbeertrag nach Freibetrag × 0.035; Kz 7 (Hebesatz) = Gemeinde-Hebesatz (default 400, konfigurierbar); Kz 10 (festzusetzende GewSt) = Kz 5 × Kz 7 / 100; Kz 11 (Summe Vorauszahlungen) = Q1 + Q2 + Q3 + Q4 aus den 4 Quartalsbescheiden (manuell vom Berater); Kz 12 (Differenz) = Kz 10 - Kz 11. Reused aus Anlage G (tier 100) für Gewerbeertrag + Freibetrag + Hebesatz — single source of truth. Für Einzelunternehmen + PersG mit 24.500 EUR Freibetrag (§ 11 Abs. 1 GewStG); für KapG ohne Freibetrag aber mit KSt-Anrechnung (3.8 × Kz 5 in KSt 1). IMMER enthalten. |`)
    lines.push(`| \`${files.bwa}\` | BWA (Betriebswirtschaftliche Auswertung) gem. DATEV-Standard — Vorschau für Dezember ${year} (Jahressumme). 14 DATEV-Bucket-Codes: Umsatzerlöse / 4 Betriebliche Aufwands-Unterkategorien / Sonstige / Zinserträge (0 in v1) / Zinsaufwendungen / 2 Steuer-Buckets. Jahresergebnis = Betriebsergebnis + Finanzergebnis - Steuern. |`)
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
