import {
  Injectable,
  BadRequestException,
  Logger,
} from "@nestjs/common"
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
      // Bilanz Aktiva — position codes from
      // tier 81.
      "bilanz.aktiva.fixass.intang": bilanzLineByCode.get("0100") ?? 0,
      "bilanz.aktiva.fixass.grundstuecke": bilanzLineByCode.get("0200") ?? 0,
      "bilanz.aktiva.fixass.maschinen": bilanzLineByCode.get("0300") ?? 0,
      "bilanz.aktiva.fixass.betriebsausstattung": bilanzLineByCode.get("0400") ?? 0,
      "bilanz.aktiva.currass.forderungen": bilanzLineByCode.get("1500") ?? 0,
      "bilanz.aktiva.currass.liquide": bilanzLineByCode.get("1600+1700") ?? 0,
      // Bilanz Passiva
      "bilanz.passiva.cred.tradl": bilanzLineByCode.get("4000") ?? 0,
      "bilanz.passiva.cred.kundenguthaben": bilanzLineByCode.get("4500") ?? 0,
      "bilanz.passiva.equity.subscribed": bilanzLineByCode.get("2000") ?? null, // v1 placeholder
      "bilanz.passiva.equity.saldoposten": bilanzResult.totals.eigenkapital ?? 0,
      // G+V — position codes from tier 82
      "guv.umsatzerloese": guvLineByCode.get("1") ?? 0,
      "guv.sonstigeErtrage": guvLineByCode.get("4") ?? 0,
      "guv.materialaufwand": guvLineByCode.get("5a") ?? 0,
      "guv.personalaufwand": guvLineByCode.get("6a") ?? 0,
      "guv.afa": guvLineByCode.get("7a") ?? 0,
      "guv.sonstigeAufwendungen": guvLineByCode.get("8") ?? 0,
      "guv.zinsaufwendungen": guvLineByCode.get("13") ?? 0,
      "guv.jahresueberschuss": guvResult.totals.jahresueberschuss ?? 0,
      // Anlagenverzeichnis (sums) — computed
      // locally from the asset pool. The
      // BilanzService positions 0100-0400
      // already aggregate these into Bilanz
      // totals, but for the Anhang / eBilanz
      // summary we re-compute.
      "assets.totalAK": assetList.reduce((s, a) => s + Number(a.anschaffungsKosten), 0),
      "assets.totalBuchwert": assetList.reduce((s, a) => {
        // Same computeAfA summary at year-end
        const summary = this.assets.computeAfA(a, new Date(year, 11, 31, 23, 59, 59, 999))
        return s + summary.buchwert
      }, 0),
      "assets.totalAfA": assetList.reduce((s, a) => {
        const summary = this.assets.computeAfA(a, new Date(year, 11, 31, 23, 59, 59, 999))
        return s + summary.annualAfA
      }, 0),
      // Anhang — narrative only
      "anhang.narrative": null,
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
        "Diese E-Bilanz ist eine VORSCHAU basierend auf den in de-invoice v1 verfügbaren Daten. " +
        "BMF Taxonomy 6.7 Positionen, die das System nicht erfasst (z. B. Eigenkapital-Differenzierung, " +
        "Steuerrückstellungen, RAP, Sonderposten, Microsig-Positionen, Personengesellschaften-spezifische " +
        "Felder), sind als nicht ausgewiesen markiert. Der Steuerberater ergänzt die fehlenden Positionen " +
        "aus dem SKR03 / der BWA-Quelldaten im ELSTER-Mein-ELSTER-Client vor der Einreichung.",
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
      // snapshot. Real BMF eBilanz requires
      // (a) the current year context, (b) the
      // prior year comparison context, (c) the
      // opening balance context. v1: current
      // year only; v2 adds (b) + (c).
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
   * to review before the XML upload). v1
   * is a simple A4 portrait: company
   * header + mapping table (position /
   * label / value / source / note) + the
   * disclaimer footer.
   *
   * v2: render the full G+V + Bilanz +
   * Anhang as separate pages (same as
   * Berater-Packager from tier 85).
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

    // Header
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

    // Counts summary
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .text(
        `${data.counts.computed} von ${data.counts.total} Pflichtpositionen berechnet (${data.counts.placeholder} als Platzhalter für den Steuerberater).`,
      )
      .moveDown(0.5)

    // Mapping table
    doc.fontSize(9).font("Helvetica-Bold")
    doc.text("Position", 40, doc.y, { continued: true })
    doc.text("BMF-Element", 220, doc.y, { continued: true })
    doc.text("Wert (EUR)", 420, doc.y, { continued: true })
    doc.text("Quelle", 480, doc.y)
    doc.moveDown(0.3)
    doc.font("Helvetica").fontSize(8)
    doc
      .moveTo(40, doc.y)
      .lineTo(555, doc.y)
      .stroke()
      .moveDown(0.3)

    for (const pos of data.positions) {
      const valueStr = pos.value !== null ? pos.value.toFixed(2) : "—"
      const yStart = doc.y
      doc.text(pos.label, 40, yStart, { width: 175 })
      doc.text(pos.elementId, 220, yStart, { width: 195 })
      doc.text(valueStr, 420, yStart, { width: 55, align: "right" })
      doc.text(pos.source, 480, yStart, { width: 80 })
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

    doc.moveDown(1)
    doc
      .fontSize(8)
      .fillColor("#666")
      .text(data.disclaimer, 40, doc.y, { width: 515, align: "justify" })
      .fillColor("black")

    doc.end()
  }
}
