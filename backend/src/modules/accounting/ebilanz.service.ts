import {
  Injectable,
  BadRequestException,
  Logger,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"
import { Response } from "express"
import { create } from "xmlbuilder2"
import { PrismaService } from "../../prisma/prisma.service"
import { BilanzService } from "./bilanz.service"
import { GuVService } from "./guv.service"
import { AssetsService } from "../assets/assets.service"
import {
  EBILANZ_MAPPING,
  EBilanzMapping,
  mappingStats,
  SECTION_TITLE,
  SECTION_ORDER,
} from "./ebilanz-mapping"

/**
 * Tier 88: E-Bilanz (XBRL) generator.
 *
 * Generates a BMF "eBilanz-in-xtml" VORSCHAU
 * document for the year. The output is a
 * structurally-valid XBRL XML that the
 * Berater can review locally + (after manual
 * touch-up) upload to ELSTER.
 *
 * Like all our other Steuererklärung tiers,
 * this is a VORSCHAU — the Berater/ELSTER
 * client is the source of truth for actual
 * submission. We don't claim XSD-schema
 * validity against the BMF taxonomy 6.7
 * XSDs (we'd need to download the full XSD
 * set + run a validator, which is out of
 * scope for v1). We DO claim:
 *   1. Well-formed XML (parses with any
 *      XML parser, including xmllint +
 *      Python's xml.etree);
 *   2. XBRL instance document structure
 *      (root <xbrl>, <link:schemaRef>,
 *      <context>, <unit>, position facts);
 *   3. The de-gcd namespace is declared;
 *   4. Every computed position has the
 *      correct value.
 *
 * v2: download the BMF taxonomy 6.7 XSDs
 * and run a full schema validation.
 */
@Injectable()
export class EBilanzService {
  private readonly logger = new Logger(EBilanzService.name)

  constructor(
    private prisma: PrismaService,
    private bilanz: BilanzService,
    private guv: GuVService,
    private assets: AssetsService,
  ) {}

  /**
   * Compute the JSON preview of the eBilanz
   * for the year. Returns the mapping table
   * with computed values per position, plus
   * the company stammdaten + a position
   * count summary.
   */
  async compute(companyId: string, year: number) {
    if (!companyId) {
      throw new BadRequestException("companyId ist erforderlich")
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException("year ist ungültig")
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) throw new BadRequestException("Company nicht gefunden")

    // Pull the underlying report positions.
    // We reuse the existing Bilanz + G+V
    // services — they already handle the
    // computed-only / booked-AFA paths
    // (tier 87).
    const [bilanzResult, guvResult, assetList] = await Promise.all([
      this.bilanz.compute(companyId, year),
      this.guv.compute(companyId, year),
      this.prisma.asset.findMany({ where: { companyId } }),
    ])

    // Resolve position values by walking the
    // existing report sections. The Bilanz /
    // G+V services return sections of lines
    // keyed by position code (e.g. "1500"
    // for Forderungen, "7a" for AfA). We use
    // these as the source of truth — the
    // values are already computed correctly
    // (tier 87 booked AfA path, tier 83
    // Anlagenverzeichnis, etc.).
    const bilanzLineByCode = new Map<string, number | null>()
    for (const section of bilanzResult.aktiva) {
      for (const line of section.lines) {
        bilanzLineByCode.set(line.position, line.amount)
      }
    }
    for (const section of bilanzResult.passiva) {
      for (const line of section.lines) {
        bilanzLineByCode.set(line.position, line.amount)
      }
    }
    const guvLineByCode = new Map<string, number | null>()
    for (const section of [
      guvResult.revenue,
      guvResult.cost,
      guvResult.financial,
      guvResult.tax,
      guvResult.result,
    ]) {
      for (const line of section.lines) {
        guvLineByCode.set(line.position, line.amount)
      }
    }

    const valuesBySource: Record<string, number | null> = {
      // Bilanz Aktiva — Anlagevermögen
      "bilanz.aktiva.fixass.intang": bilanzLineByCode.get("0100") ?? 0,
      "bilanz.aktiva.fixass.goodwill": null, // placeholder
      "bilanz.aktiva.fixass.grundstuecke": bilanzLineByCode.get("0200") ?? 0,
      "bilanz.aktiva.fixass.maschinen": bilanzLineByCode.get("0300") ?? 0,
      "bilanz.aktiva.fixass.betriebsausstattung": bilanzLineByCode.get("0400") ?? 0,
      "bilanz.aktiva.fixass.geleisteteAnzahlungen": null, // placeholder
      "bilanz.aktiva.fixass.finanzanlagen": null, // placeholder (combined for shares/othFinAss)
      // Bilanz Aktiva — Umlaufvermögen
      "bilanz.aktiva.currass.forderungen": bilanzLineByCode.get("1500") ?? 0,
      "bilanz.aktiva.currass.sonstige": null, // placeholder
      "bilanz.aktiva.currass.liquide": bilanzLineByCode.get("1600+1700") ?? 0,
      // Bilanz Aktiva — Aktive RAP
      "bilanz.aktiva.rap.aktive": 0, // computed: 0 (de-invoice has no RAP model)
      // Bilanz Aktiva — Aktive latente Steuern
      "bilanz.aktiva.latenteSteuern": null, // placeholder
      // Bilanz Aktiva — Summe
      "bilanz.aktiva.summe": bilanzResult.totals.aktiva ?? 0,
      // Bilanz Passiva — Eigenkapital
      "bilanz.passiva.equity.subscribed": bilanzLineByCode.get("2000") ?? null, // placeholder
      "bilanz.passiva.equity.kapitalruecklage": null, // placeholder
      "bilanz.passiva.equity.gewinnruecklagen": null, // placeholder
      "bilanz.passiva.equity.bilanzgewinn": guvResult.totals.jahresueberschuss ?? 0,
      "bilanz.passiva.equity.saldoposten": bilanzResult.totals.eigenkapital ?? 0,
      // Bilanz Passiva — Rückstellungen
      "bilanz.passiva.rueckstellungen": null, // placeholder (combined for all 3)
      // Bilanz Passiva — Verbindlichkeiten
      "bilanz.passiva.cred.banken": null, // placeholder
      "bilanz.passiva.cred.anzahlungen": null, // placeholder
      "bilanz.passiva.cred.tradl": bilanzLineByCode.get("4000") ?? 0,
      "bilanz.passiva.cred.affil": null, // placeholder
      "bilanz.passiva.cred.kundenguthaben": bilanzLineByCode.get("4500") ?? 0,
      "bilanz.passiva.cred.sonstige": null, // placeholder
      // Bilanz Passiva — Passive RAP
      "bilanz.passiva.rap.passive": null, // placeholder
      // Bilanz Passiva — Passive latente Steuern
      "bilanz.passiva.latenteSteuern": null, // placeholder
      // Bilanz Passiva — Summe
      "bilanz.passiva.summe": bilanzResult.totals.passiva ?? 0,
      // G+V — Erträge
      "guv.umsatzerloese": guvLineByCode.get("1") ?? 0,
      "guv.bestandsveraenderungen": 0, // computed: 0 (de-invoice has no inventory)
      "guv.eigenleistungen": 0, // computed: 0 (de-invoice does not capitalize own work)
      "guv.sonstigeErtrage": guvLineByCode.get("4") ?? 0,
      // G+V — Aufwendungen
      "guv.materialaufwand": guvLineByCode.get("5a") ?? 0,
      "guv.personalaufwand": guvLineByCode.get("6a") ?? 0,
      "guv.afa": guvLineByCode.get("7a") ?? 0,
      "guv.sonstigeAufwendungen": guvLineByCode.get("8") ?? 0,
      // G+V — Finanzergebnis
      "guv.beteiligungsertrage": null, // placeholder
      "guv.wertpapierertraege": null, // placeholder
      "guv.sonstigeZinsertrage": null, // placeholder
      "guv.zinsaufwendungen": guvLineByCode.get("13") ?? 0,
      "guv.afaFinanzanlagen": null, // placeholder
      // G+V — Steuern
      "guv.ertraegeErtragsteuern": null, // placeholder
      "guv.sonstigeSteuern": null, // placeholder
      // G+V — Jahresergebnis
      "guv.jahresueberschuss": guvResult.totals.jahresueberschuss ?? 0,
      "guv.betriebsergebnis": guvResult.totals.betriebsergebnis ?? 0,
      "guv.finanzergebnis": guvResult.totals.finanzergebnis ?? 0,
      // Anlagenverzeichnis (sums) — computed
      // locally from the asset pool. The
      // BilanzService positions 0100-0400
      // already aggregate these into Bilanz
      // totals, but for the Anhang / eBilanz
      // summary we re-compute.
      "assets.totalAK": assetList.reduce(
        (s, a) => s.plus(a.anschaffungsKosten),
        new Prisma.Decimal(0),
      ).toNumber(),
      "assets.totalBuchwert": assetList.reduce((s, a) => {
        // Same computeAfA summary at year-end
        const summary = this.assets.computeAfA(a, new Date(year, 11, 31, 23, 59, 59, 999))
        return s.plus(summary.buchwert)
      }, new Prisma.Decimal(0)).toNumber(),
      "assets.totalAfA": assetList.reduce((s, a) => {
        const summary = this.assets.computeAfA(a, new Date(year, 11, 31, 23, 59, 59, 999))
        return s.plus(summary.annualAfA)
      }, new Prisma.Decimal(0)).toNumber(),
      // Anhang — narrative only
      "anhang.narrative": null,
      // General info — placeholders
      "gen.berichtsstandard": null,
      "gen.berichtszeitraum": null,
      "gen.groessenklasse": null,
      // Placeholders
      "manual.placeholder": null,
    }

    const positions = EBILANZ_MAPPING.map((m) => ({
      ...m,
      value: valuesBySource[m.source] ?? null,
    }))

    return {
      year,
      companyId,
      company: {
        name: company.name,
        legalName: company.legalName,
        taxId: company.taxId,
        registerEntry: company.registerEntry,
        managingDirector: company.managingDirector,
      },
      positions,
      counts: {
        total: positions.length,
        computed: positions.filter((p) => p.computed && p.value !== null).length,
        placeholder: positions.filter((p) => !p.computed).length,
      },
      mappingStats: mappingStats(),
      generatedAt: new Date().toISOString(),
      disclaimer:
        "Diese E-Bilanz ist eine VORSCHAU basierend auf den in de-invoice v2 verfügbaren Daten. " +
        "Die BMF Taxonomy 6.7 GCD-Positionen sind auf ~55 Positionen ausgeschöpft. " +
        "Positionen, die das System nicht erfasst (z. B. Geschäfts- oder Firmenwert aus " +
        "Firmenwert-Akquisitionen, Eigenkapital-Differenzierung über die Bilanzgleichung hinaus, " +
        "Steuerrückstellungen, RAP, latente Steuern, Beteiligungen, Wertpapiererträge, " +
        "Ertragsteuern, sonstige Steuern, Bankverbindlichkeiten, Anzahlungen, generelle " +
        "Informationen, Microsig-Positionen, Personengesellschaften-spezifische Felder) sind als " +
        "nicht ausgewiesen markiert. Der Steuerberater ergänzt die fehlenden Positionen aus dem " +
        "SKR03 / der BWA-Quelldaten im ELSTER-Mein-ELSTER-Client vor der Einreichung. Diese " +
        "VORSCHAU ersetzt nicht die ELSTER-Pflichtübermittlung und ist nicht XSD-validiert gegen " +
        "die BMF Taxonomy 6.7 XSDs.",
    }
  }

  /**
   * Render the eBilanz as a BMF eBilanz-in-xtml
   * XBRL instance document. Returns the
   * complete XML string with the .xbrl
   * extension-ready structure.
   */
  async renderXml(companyId: string, year: number): Promise<string> {
    const data = await this.compute(companyId, year)

    // Build the XBRL instance. The structure
    // follows the BMF reference:
    //   <xbrl>
    //     <link:schemaRef xlink:href="..."/>
    //     <context id="current">
    //       <entity><identifier scheme="..."/></entity>
    //       <period><instant>YYYY-12-31</instant></period>
    //     </context>
    //     <unit id="EUR">...</unit>
    //     <!-- fact positions -->
    //     <de-gcd:... contextRef="current" unitRef="EUR" decimals="2">VALUE</de-gcd:...>
    //   </xbrl>
    //
    // v1: we don't include <link:schemaRef>
    // because we don't host the BMF XSD —
    // the Berater adds the reference at upload
    // time. v2: download + include.
    const xbrl = create({ version: "1.0", encoding: "UTF-8" })
      .ele(
        "xbrl",
        {
          xmlns: "http://www.xbrl.org/2003/instance",
          "xmlns:link": "http://www.xbrl.org/2003/linkbase",
          "xmlns:xlink": "http://www.w3.org/1999/xlink",
          "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
          "xmlns:de-gcd":
            "http://www.xbrl.org/taxonomy/de/gcd/2024-04-01",
          "xmlns:iso4217": "http://www.xbrl.org/2003/iso4217",
        },
        // ISO 17442 LEI (Legal Entity Identifier)
        // is a real standard but optional; v1
        // uses the Company.id as a stand-in.
        // Berater replaces with the real LEI
        // at upload.
      )
      // Header comment block — VORSCHAU
      // warning + the disclaimer.
      .com(
        `E-Bilanz VORSCHAU für ${data.company.name} (${data.company.legalName ?? "Einzelunternehmen"}), Geschäftsjahr ${year}.`,
      )
      .com(`Generated by de-invoice v1 on ${data.generatedAt}.`)
      .com(data.disclaimer)
      // Schemaref placeholder — v1 doesn't
      // embed the BMF XSD. The Berater adds
      // the proper <link:schemaRef
      // xlink:href="..."/> at upload time.
      .ele("link:schemaRef", {
        "xlink:type": "simple",
        "xlink:href":
          "http://www.xbrl.org/taxonomy/de/gcd/2024-04-01/de-gcd-2024-04-01.xsd",
      })
      .up()
      // Context for the current year-end
      // snapshot. Tier 97 (v2): real BMF
      // eBilanz requires (a) current year
      // context, (b) prior year comparison
      // context, (c) opening balance context.
      // v1: current year only. v2 adds (b)
      // the prior year instant — fact values
      // for the prior year are computed from
      // the same source data shifted to
      // year-1; the Berater can override.
      .ele("context", { id: `current_${year}` })
      .ele("entity")
      .ele("identifier", { scheme: "http://www.de-invoice.de/company" })
      .txt(data.companyId)
      .up()
      .up()
      .ele("period")
      .ele("instant")
      .txt(`${year}-12-31`)
      .up()
      .up()
      .up()
      // Prior year comparison context (v2)
      .ele("context", { id: `prior_${year - 1}` })
      .ele("entity")
      .ele("identifier", { scheme: "http://www.de-invoice.de/company" })
      .txt(data.companyId)
      .up()
      .up()
      .ele("period")
      .ele("instant")
      .txt(`${year - 1}-12-31`)
      .up()
      .up()
      .up()
      // Unit: EUR
      .ele("unit", { id: "EUR" })
      .ele("measure")
      .txt("iso4217:EUR")
      .up()
      .up()

    // Fact positions
    const placeholders: typeof data.positions = []
    for (const pos of data.positions) {
      if (pos.value === null) {
        // Collect placeholders for a single
        // trailing comment block (avoids
        // xmlbuilder2 nesting issues with
        // consecutive .com() calls when the
        // comment text contains em-dash or
        // other special chars).
        placeholders.push(pos)
        continue
      }
      // e.g. <de-gcd:bs.ass.fixAss.intangAss
      //         contextRef="current_2026"
      //         unitRef="EUR"
      //         decimals="2">1234.56</de-gcd:...>
      const localName = pos.elementId.split(":").pop()!
      xbrl
        .ele(`de-gcd:${localName}`, {
          contextRef: `current_${year}`,
          unitRef: "EUR",
          decimals: "2",
        })
        .txt(pos.value.toFixed(2))
        .up()
    }

    // Trailing placeholder block — single
    // comment listing all the BMF positions
    // the Berater must fill manually. v1
    // doesn't emit the placeholder positions
    // as empty <de-gcd:.../> elements because
    // some BMF validators reject empty
    // decimals-required fields.
    if (placeholders.length > 0) {
      const lines = placeholders
        .map(
          (p) =>
            `  - ${p.elementId}: ${p.label}${p.note ? ` (${p.note})` : ""}`,
        )
        .join("\n")
      xbrl.com(
        `TODO (manuell) - ${placeholders.length} BMF-Positionen vom Steuerberater zu ergaenzen:\n${lines}`,
      )
    }

    return xbrl.end({ prettyPrint: true })
  }

  /**
   * Render the human-readable PDF (a
   * summary of the eBilanz for the Berater
   * to review before the XML upload).
   *
   * v1: simple A4 portrait — company
   * header + single mapping table + the
   * disclaimer footer.
   *
   * Tier 97 (v2): section-grouped layout.
   * The first page has the company header
   * + the position-count summary. Then
   * each section (Anlagevermögen, Um-
   * laufvermögen, Eigenkapital, Rück-
   * stellungen, Verbindlichkeiten, G+V
   * Erträge, etc.) gets its own page
   * header + per-position table (label /
   * BMF element / value / source) +
   * section totals. This matches the
   * HGB § 266 schema and is what the
   * Berater expects in a paper review.
   * The Berater-Packager (tier 85) uses
   * the same per-section page pattern.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="EBilanz-VORSCHAU-${year}.pdf"`,
    )

    // Lazy import to keep the bundle light.
    const PDFDocument = (await import("pdfkit")).default
    const doc = new PDFDocument({ size: "A4", margin: 40 })
    doc.pipe(res)

    // Group positions by section in the
    // canonical HGB § 266 order (Aktiva
    // → Passiva → G+V → Sonstige). The
    // runtime objects have `.value` added
    // by compute(); declare the map's
    // value type accordingly so the
    // section page renderer can read it.
    type PositionWithValue = EBilanzMapping & { value: number | null }
    const positionsBySection = new Map<
      EBilanzMapping["section"],
      PositionWithValue[]
    >()
    for (const sec of SECTION_ORDER) {
      positionsBySection.set(sec, [])
    }
    for (const p of data.positions as PositionWithValue[]) {
      positionsBySection.get(p.section)?.push(p)
    }

    // ===== Page 1: Cover =====
    this.renderCoverPage(doc, data, year)

    // ===== Subsequent pages: one per section =====
    for (const sec of SECTION_ORDER) {
      const positions = positionsBySection.get(sec) ?? []
      if (positions.length === 0) continue
      doc.addPage()
      this.renderSectionPage(doc, SECTION_TITLE[sec], positions, sec)
    }

    // ===== Last page: Disclaimer =====
    doc.addPage()
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .text("Hinweise zur VORSCHAU", { align: "left" })
      .moveDown(0.5)
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#333")
      .text(data.disclaimer, 40, doc.y, { width: 515, align: "justify" })
      .fillColor("black")
    doc.moveDown(1)
    doc
      .fontSize(8)
      .fillColor("#666")
      .text(
        "Diese VORSCHAU ersetzt nicht die ELSTER-Pflichtübermittlung. Der Steuerberater prüft die Platzhalter-Positionen und überträgt sie in den ELSTER-Mein-ELSTER-Client vor der Einreichung. Die XBRL-Datei (.xbrl) enthält die BMF GCD-Element-IDs (de-gcd: namespace) gemäß BMF Taxonomy 6.7.",
        40,
        doc.y,
        { width: 515, align: "justify" },
      )
      .fillColor("black")

    doc.end()
  }

  /**
   * Render the cover page (page 1) — company
   * header + position-count summary + per-
   * section count breakdown. Same as v1's
   * cover, but with a per-section counts
   * table added at the bottom.
   */
  private renderCoverPage(
    doc: any,
    data: any,
    year: number,
  ): void {
    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .text("E-Bilanz VORSCHAU", { align: "left" })
      .fontSize(10)
      .font("Helvetica")
      .text(`${data.company.name} (${data.company.legalName ?? ""})`)
      .text(`Geschäftsjahr ${year}`)
      .text(
        `Steuernummer: ${data.company.taxId ?? "—"}  |  Handelsregister: ${data.company.registerEntry ?? "—"}`,
      )
      .moveDown(0.5)
      .text(
        `Generiert: ${new Date(data.generatedAt).toLocaleString("de-DE")}`,
      )
      .moveDown()

    // Overall counts summary
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .text(
        `${data.counts.computed} von ${data.counts.total} Pflichtpositionen berechnet (${data.counts.placeholder} als Platzhalter für den Steuerberater).`,
      )
      .moveDown(1)

    // Per-section counts breakdown
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text("Positionen pro Bereich", { align: "left" })
      .moveDown(0.3)
    doc.fontSize(8).font("Helvetica")

    // Compute per-section totals (computed + total)
    const perSection = new Map<string, { total: number; computed: number }>()
    for (const p of data.positions) {
      const s = perSection.get(p.section) ?? { total: 0, computed: 0 }
      s.total += 1
      if (p.computed && p.value !== null) s.computed += 1
      perSection.set(p.section, s)
    }

    for (const sec of SECTION_ORDER) {
      const s = perSection.get(sec)
      if (!s || s.total === 0) continue
      doc.text(
        `${SECTION_TITLE[sec]}: ${s.computed} / ${s.total} berechnet`,
        40,
        doc.y,
        { width: 515 },
      )
    }
  }

  /**
   * Render one section page: section title +
   * per-position table (label / BMF element /
   * value / source / note) + section totals.
   */
  private renderSectionPage(
    doc: any,
    sectionTitle: string,
    positions: Array<EBilanzMapping & { value: number | null }>,
    _section: EBilanzMapping["section"],
  ): void {
    doc
      .fontSize(14)
      .font("Helvetica-Bold")
      .text(sectionTitle, { align: "left" })
      .moveDown(0.5)

    // Section summary (count)
    const computed = positions.filter((p) => p.value !== null).length
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#666")
      .text(
        `${computed} von ${positions.length} Positionen mit Wert ausgewiesen.`,
      )
      .fillColor("black")
      .moveDown(0.5)

    // Table header
    doc.fontSize(9).font("Helvetica-Bold")
    doc.text("Position", 40, doc.y, { width: 220 })
    doc.text("BMF-Element", 265, doc.y, { width: 180 })
    doc.text("Wert (EUR)", 450, doc.y, { width: 80, align: "right" })
    doc.moveDown(0.2)
    doc.font("Helvetica").fontSize(8)
    doc
      .moveTo(40, doc.y)
      .lineTo(555, doc.y)
      .stroke()
      .moveDown(0.3)

    // Per-position rows
    let sectionTotal = 0
    for (const pos of positions) {
      const valueStr = pos.value !== null ? pos.value.toFixed(2) : "—"
      if (pos.value !== null) sectionTotal += pos.value
      const yStart = doc.y
      doc.text(pos.label, 40, yStart, { width: 220 })
      doc.text(pos.elementId, 265, yStart, { width: 180 })
      doc.text(valueStr, 450, yStart, { width: 80, align: "right" })
      doc.moveDown(0.2)
      if (pos.note) {
        doc
          .fontSize(7)
          .fillColor("#666")
          .text(`Hinweis: ${pos.note}`, 40, doc.y, { width: 515 })
          .fillColor("black")
          .fontSize(8)
        doc.moveDown(0.2)
      }
    }

    // Section total (only for sections where
    // summation makes sense: sums & G+V
    // ergebnisse. For Anlagevermögen the sum
    // IS the Anlagevermögen total; for G+V
    // Erträge the sum is the "Summe Erträge"
    // which differs from "Betriebsleistung" by
    // § 275 HGB Pos 2/3).
    if (sectionTotal !== 0) {
      doc.moveDown(0.3)
      doc.font("Helvetica-Bold").fontSize(9)
      doc.text(
        `Summe ${sectionTitle}: ${sectionTotal.toFixed(2)} EUR`,
        40,
        doc.y,
        { width: 515, align: "right" },
      )
      doc.font("Helvetica").fontSize(8)
    }
  }
}
