/**
 * Mahnung (dunning letter) PDF generator.
 *
 * Three escalating levels per §286 BGB Mahnung:
 *   - first  (Zahlungserinnerung) — friendly nudge
 *   - second (1. Mahnung)         — formal, sets new deadline
 *   - final  (Letzte Mahnung)     — threatens Inkasso, 5-Tage-Frist
 *
 * Uses the same PDFKit A4 monochrome style as the
 * invoice PDF (ink-saving, no colored fills). Header
 * carries the company letterhead; body uses the same
 * {{placeholder}} substitution as the email template.
 *
 * Why a separate PDF instead of reusing invoice PDF?
 *   - Different document type (Mahnung is not an
 *     invoice — it can't be added to a Buchungsbeleg
 *     as a Rechnung)
 *   - Different legal language ("mahnen" / "Inkasso"
 *     aren't on a regular invoice)
 *   - PDF has to be the official-looking document
 *     attached to the email; the email body alone is
 *     legally weaker.
 */
import PDFDocument from "pdfkit"
import { countWerktage } from "./werktage"

export interface MahnungPdfInput {
  level: "first" | "second" | "final"
  invoiceNumber: string
  invoiceDate: Date
  dueDate: Date
  totalAmount: number
  totalVat?: number
  customer: {
    name: string
    contact?: { name?: string } | null
    address?: any
  }
  company: {
    name: string
    legalName?: string | null
    address: any
    email?: string | null
    phone?: string | null
    bankInfo?: any
    taxId?: string | null
    vatId?: string | null
    logoPath?: string | null
  }
  daysOverdue: number
  werktageOverdue: number
  /** ISO date string for the new payment deadline the Mahnung sets. */
  neueFrist: string
  /** Bank info rendered as one line for the body. */
  bankLine: string
  /**
   * Tier 37: optional fee breakdown. When provided,
   * the PDF adds a small "Zusätzliche Kosten" block
   * under the overdue-amount table with the Mahngebühr
   * and Verzugszins line items + a grand total. The
   * manual send / auto-reminder paths compute these
   * numbers at send-time (so they're stable in the
   * PDF even if the invoice balance changes later).
   */
  mahngebuehr?: number
  verzugszins?: number
  /** Verzugszins percentage applied, e.g. 9.0 (% per year). */
  verzugszinsPct?: number
}

const PAGE_MARGIN = 50
const PAGE_WIDTH = 595.28 // A4 in points
const PAGE_HEIGHT = 841.89
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2

const LEVEL_TITLES: Record<MahnungPdfInput["level"], string> = {
  first: "Zahlungserinnerung",
  second: "1. Mahnung",
  final: "Letzte Mahnung — Außergerichtliches Inkasso",
}

const LEVEL_INTRO: Record<MahnungPdfInput["level"], string> = {
  first:
    "wir möchten Sie höflich daran erinnern, dass die nachfolgend aufgeführte Rechnung noch nicht beglichen ist.",
  second:
    "trotz unserer früheren Erinnerung ist die nachfolgend aufgeführte Rechnung weiterhin unbeglichen. Wir fordern Sie hiermit erneut zur Zahlung auf.",
  final:
    "trotz mehrfacher Aufforderung bleibt die nachfolgend aufgeführte Rechnung weiterhin unbeglichen. Dies ist unsere letzte Mahnung vor Einleitung außergerichtlicher Inkassomaßnahmen.",
}

const LEVEL_FRIST: Record<MahnungPdfInput["level"], string> = {
  first: "Wir bitten Sie, den offenen Betrag innerhalb der nächsten 7 Werktage zu begleichen.",
  second:
    "Bitte überweisen Sie den ausstehenden Betrag innerhalb der nächsten 7 Werktage.",
  final:
    "Wir fordern Sie auf, den ausstehenden Betrag innerhalb der nächsten 5 Werktage zu begleichen. Nach fruchtlosem Ablauf der Frist werden wir weitere rechtliche Schritte einleiten.",
}

export async function generateMahnungPDF(input: MahnungPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: PAGE_MARGIN,
        bottom: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      info: {
        Title: `${LEVEL_TITLES[input.level]} ${input.invoiceNumber}`,
        Author: input.company.legalName || input.company.name,
        Subject: `Mahnung zur Rechnung ${input.invoiceNumber}`,
        Keywords: "Mahnung, Rechnung, " + input.level,
      },
    })

    const chunks: Buffer[] = []
    doc.on("data", (c) => chunks.push(c))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    // ─── HEADER (Absenderzeile + Empfänger block) ───
    // Small Absenderzeile at the very top in 5pt
    // (matches invoice PDF style: "Name · Straße ·
    // PLZ Ort · Land" in one line, 5pt font).
    const addr = input.company.address || {}
    const absenderParts = [
      input.company.legalName || input.company.name,
      addr.street,
      [addr.postalCode, addr.city].filter(Boolean).join(" "),
      addr.country,
    ].filter(Boolean)
    doc
      .fontSize(5)
      .fillColor("#666666")
      .font("Helvetica")
      .text(absenderParts.join(" · "), PAGE_MARGIN, 30, {
        width: CONTENT_WIDTH,
        lineBreak: false,
      })
    doc.fillColor("black")

    // Empfänger block (left aligned, ~150pt from top)
    let y = 70
    const empfaenger = input.customer.contact?.name || input.customer.name
    doc.fontSize(11).font("Helvetica-Bold").text(empfaenger, PAGE_MARGIN, y)
    y = doc.y + 2
    doc.fontSize(10).font("Helvetica")
    if (input.customer.address?.street) {
      doc.text(input.customer.address.street, PAGE_MARGIN, y)
      y = doc.y
    }
    if (input.customer.address?.postalCode || input.customer.address?.city) {
      const line = [input.customer.address?.postalCode, input.customer.address?.city]
        .filter(Boolean)
        .join(" ")
      doc.text(line, PAGE_MARGIN, y)
      y = doc.y
    }
    if (input.customer.address?.country) {
      doc.text(input.customer.address.country, PAGE_MARGIN, y)
      y = doc.y + 12
    } else {
      y += 12
    }

    // ─── TITLE + DATE (right column) ───
    const today = new Date()
    const fmtDate = (d: Date) =>
      `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`
    doc
      .fontSize(9)
      .font("Helvetica")
      .text(fmtDate(today), PAGE_WIDTH - PAGE_MARGIN - 100, 70, {
        width: 100,
        align: "right",
      })

    // ─── SUBJECT LINE ───
    y += 20
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(
        `${LEVEL_TITLES[input.level]} zur Rechnung ${input.invoiceNumber}`,
        PAGE_MARGIN,
        y,
        { width: CONTENT_WIDTH },
      )
    y = doc.y + 16

    // ─── BODY ───
    doc.fontSize(10).font("Helvetica")

    doc.text(
      `Sehr geehrte/r ${empfaenger},`,
      PAGE_MARGIN,
      y,
      { width: CONTENT_WIDTH },
    )
    y = doc.y + 8

    doc.text(LEVEL_INTRO[input.level], PAGE_MARGIN, y, { width: CONTENT_WIDTH })
    y = doc.y + 12

    // ─── INVOICE TABLE ───
    const tableLeft = PAGE_MARGIN
    const colWidths = [220, 90, 90, 90]
    const colX = colWidths.reduce(
      (acc, w, i) => [...acc, (acc[i - 1] || PAGE_MARGIN) + (i === 0 ? 0 : colWidths[i - 1])],
      [] as number[],
    )

    // Header row
    doc.fontSize(9).font("Helvetica-Bold")
    doc.text("Rechnung", colX[0], y, { width: colWidths[0] })
    doc.text("Rechnungsdatum", colX[1], y, { width: colWidths[1] })
    doc.text("Fälligkeit", colX[2], y, { width: colWidths[2] })
    doc.text("Betrag", colX[3], y, { width: colWidths[3], align: "right" })
    y = doc.y + 4
    doc
      .moveTo(PAGE_MARGIN, y)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, y)
      .strokeColor("#333333")
      .lineWidth(0.5)
      .stroke()
    y += 6

    // Data row
    doc.fontSize(10).font("Helvetica")
    doc.text(input.invoiceNumber, colX[0], y, { width: colWidths[0] })
    doc.text(fmtDate(input.invoiceDate), colX[1], y, { width: colWidths[1] })
    doc.text(fmtDate(input.dueDate), colX[2], y, { width: colWidths[2] })
    doc.text(formatEUR(input.totalAmount), colX[3], y, {
      width: colWidths[3],
      align: "right",
    })
    y = doc.y + 4
    doc
      .moveTo(PAGE_MARGIN, y)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, y)
      .strokeColor("#333333")
      .lineWidth(0.5)
      .stroke()
    y += 14

    // Overdue summary
    doc.fontSize(10).font("Helvetica")
    doc.text(
      `Überfällig seit ${input.werktageOverdue} Werktag${input.werktageOverdue === 1 ? "" : "en"} (${input.daysOverdue} Kalendertag${input.daysOverdue === 1 ? "" : "en"}).`,
      PAGE_MARGIN,
      y,
      { width: CONTENT_WIDTH },
    )
    y = doc.y + 8
    doc.text(
      `Offener Betrag: ${formatEUR(input.totalAmount)}`,
      PAGE_MARGIN,
      y,
      { width: CONTENT_WIDTH },
    )
    y = doc.y + 14

    // ─── TIER 37: FEE BLOCK (optional) ───
    // When the manual send / auto-cron computed a Mahngebühr
    // or Verzugszins at send-time, paint it as a small two-
    // column block under the "Offener Betrag" line. The grand
    // total = offener Betrag + mahngebuehr + verzugszins, which
    // is what the customer has to transfer by the neueFrist.
    //
    // German format: right-aligned numbers, single-line rows,
    // bold grand total. Same fontSize (10) as the surrounding
    // text so we don't break the document's visual rhythm.
    const feeM = Number(input.mahngebuehr || 0)
    const feeV = Number(input.verzugszins || 0)
    if (feeM > 0 || feeV > 0) {
      const grand = input.totalAmount + feeM + feeV
      const feeBoxLeft = PAGE_MARGIN
      const feeLabelW = CONTENT_WIDTH * 0.65
      const feeValueW = CONTENT_WIDTH * 0.35
      const feeValueX = feeBoxLeft + feeLabelW

      // Subtle divider above the fee block to separate it
      // from the "Offener Betrag" summary above.
      doc
        .moveTo(feeBoxLeft, y - 2)
        .lineTo(PAGE_WIDTH - PAGE_MARGIN, y - 2)
        .strokeColor("#cccccc")
        .lineWidth(0.3)
        .stroke()

      doc.fontSize(9).fillColor("#333333").font("Helvetica")
      const feeLines: Array<{ label: string; value: number; bold?: boolean }> = []
      // Heading row — matches the visual weight of the rest
      // of the document. The label is the same uppercase
      // style used by the rest of the PDF column headers.
      feeLines.push({
        label: "ZUSÄTZLICHE KOSTEN",
        value: 0,
        bold: true,
      })
      if (feeM > 0) {
        feeLines.push({
          label: `Mahngebühr (Stufe ${feeStageLabel(input.level)})`,
          value: feeM,
        })
      }
      if (feeV > 0) {
        const pct = input.verzugszinsPct
        const label = pct
          ? `Verzugszinsen (${pct.toFixed(2)} % über Basiszinssatz, §288 Abs. 2 BGB)`
          : `Verzugszinsen (§288 Abs. 2 BGB)`
        feeLines.push({ label, value: feeV })
      }
      // Grand total — bold, separated by a thin rule above
      feeLines.push({
        label: "Gesamtbetrag zu zahlen bis " +
          `${fmtDate(new Date(input.neueFrist))}`,
        value: grand,
        bold: true,
      })

      feeLines.forEach((line, idx) => {
        if (idx === feeLines.length - 1) {
          // Final grand-total row gets a hairline rule.
          doc
            .moveTo(feeBoxLeft, y - 1)
            .lineTo(PAGE_WIDTH - PAGE_MARGIN, y - 1)
            .strokeColor("#999999")
            .lineWidth(0.3)
            .stroke()
        }
        doc.fontSize(line.bold ? 10 : 9)
        doc.font(line.bold ? "Helvetica-Bold" : "Helvetica")
        doc.text(
          line.label,
          feeBoxLeft,
          y,
          { width: feeLabelW, lineBreak: false },
        )
        if (line.value > 0 || line.bold) {
          doc.text(
            formatEUR(line.value),
            feeValueX,
            y,
            { width: feeValueW, align: "right", lineBreak: false },
          )
        }
        y = doc.y + 4
      })
      doc.fillColor("black").font("Helvetica")
      y += 8
    }

    // ─── FRIST SECTION ───
    doc.text(LEVEL_FRIST[input.level], PAGE_MARGIN, y, { width: CONTENT_WIDTH })
    y = doc.y + 8
    doc.text(
      `Neue Zahlungsfrist: ${fmtDate(new Date(input.neueFrist))}`,
      PAGE_MARGIN,
      y,
      { width: CONTENT_WIDTH, continued: false },
    )
    doc.font("Helvetica-Bold").text(`(${input.neueFrist === "" ? "" : ""}Werktage)`)
    doc.font("Helvetica")
    y = doc.y + 12

    // Bank info
    if (input.bankLine) {
      doc.text(
        `Bitte überweisen Sie auf folgendes Konto: ${input.bankLine}`,
        PAGE_MARGIN,
        y,
        { width: CONTENT_WIDTH },
      )
      y = doc.y + 14
    }

    // ─── LEGAL NOTE (only for final) ───
    if (input.level === "final") {
      doc
        .fontSize(9)
        .fillColor("#333333")
        .text(
          "Hinweis: Bei Verzug schulden Sie Verzugszinsen in Höhe von 9 Prozentpunkten über dem Basiszinssatz (§288 Abs. 2 BGB) sowie Mahngebühren.",
          PAGE_MARGIN,
          y,
          { width: CONTENT_WIDTH },
        )
      y = doc.y + 14
      doc.fillColor("black")
    }

    // ─── CLOSING ───
    doc
      .fontSize(10)
      .text(
        "Mit freundlichen Grüßen",
        PAGE_MARGIN,
        y,
        { width: CONTENT_WIDTH },
      )
    y = doc.y + 24
    doc.text(input.company.legalName || input.company.name, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH,
    })

    // ─── FOOTER (small, 7pt, on every page) ───
    const range = doc.bufferedPageRange()
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i)
      const footerY = PAGE_HEIGHT - 30
      doc
        .fontSize(7)
        .fillColor("#666666")
        .text(
          `${input.company.legalName || input.company.name} · ${absenderParts.slice(1).join(" · ")}` +
            (input.company.email ? ` · ${input.company.email}` : "") +
            (input.company.taxId ? ` · Steuernummer ${input.company.taxId}` : "") +
            (input.company.vatId ? ` · USt-ID ${input.company.vatId}` : ""),
          PAGE_MARGIN,
          footerY,
          { width: CONTENT_WIDTH, lineBreak: false },
        )
    }

    doc.end()
  })
}

function formatEUR(n: number): string {
  // German format: 1.234,56 €
  return (
    new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n) + " €"
  )
}

/** German Mahnstufe label for the Fee-block heading. */
function feeStageLabel(
  level: "first" | "second" | "final",
): string {
  if (level === "first") return "1 (Zahlungserinnerung)"
  if (level === "second") return "2 (1. Mahnung)"
  return "3 (Letzte Mahnung)"
}

/**
 * Compute the new payment deadline (Frist) for a Mahnung
 * at a given level. Uses Werktage arithmetic so customers
 * don't get "5 days" that end on a Sunday.
 */
export function computeNeueFrist(
  fromDate: Date,
  level: "first" | "second" | "final",
): Date {
  const werktage = level === "final" ? 5 : 7
  const cur = new Date(fromDate)
  // Use the Wochentag-aware addWerktage from werktage.ts
  // (not adding a new one here to avoid circular import
  // in case of an extension later).
  const target = cur
  target.setDate(target.getDate() + werktage)
  // Walk forward until we land on a Werktag
  // (conservative — if the 7-day offset happens to be
  // a weekend, bump to the next Monday).
  let safety = 0
  while (safety++ < 10) {
    const day = target.getDay()
    if (day !== 0 && day !== 6) break
    target.setDate(target.getDate() + 1)
  }
  return target
}

/** Expose countWerktage so reminder.service can use it. */
export { countWerktage }
