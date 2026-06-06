import PDFKit from "pdfkit"
import * as fs from "fs"
import * as path from "path"

interface Customer {
  name: string
  address: any
  vatId?: string | null
}

interface InvoiceItem {
  description: string
  quantity: any
  unit: string | null
  unitPrice: any
  vatRate: any
  netAmount: any
  vatAmount: any
  grossAmount: any
}

interface Invoice {
  invoiceNumber: string
  issueDate: any
  dueDate: any
  customer: Customer
  items: InvoiceItem[]
  subtotal: any
  totalVat: any
  total: any
  notes?: string | null
  currency: string
  templateType?: string
}

interface CompanyInfo {
  name: string
  address: any
  vatId?: any
  taxId?: any
  bankInfo?: any
  logoPath?: string | null
}

export type InvoiceTemplateType = "standard" | "simplified" | "compact"

export async function generateInvoicePDF(
  invoice: Invoice,
  company: CompanyInfo,
  templateType: string = "standard"
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const template = templateType as InvoiceTemplateType
    const doc = new PDFKit({ margin: 50, size: "A4" }) as any
    const chunks: Buffer[] = []

    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const pageWidth = doc.page.width
    const leftMargin = 50
    const rightMargin = pageWidth - 50

    // Calculate layout based on template
    const isCompact = template === "compact"
    const showLogo = template !== "simplified" && company.logoPath

    // Header area Y positions
    const headerStartY = 50
    let currentY = headerStartY

    // Draw logo if available and template allows
    if (showLogo && company.logoPath) {
      const logoPath = resolveLogoPath(company.logoPath)
      if (logoPath && fs.existsSync(logoPath)) {
        try {
          // Logo centered at top, max height 40px
          const imgHeight = 40
          const img = doc.openImage(logoPath)
          const imgWidth = Math.min(img.width * (imgHeight / img.height), 150)
          const imgX = (pageWidth - imgWidth) / 2
          doc.image(logoPath, imgX, currentY, { height: imgHeight })
          currentY += imgHeight + 10
        } catch (err) {
          console.warn("Failed to load logo:", err)
        }
      }
    }

    // Company info header
    const compAddr = company.address || {}

    if (showLogo) {
      // Centered company name below logo
      doc.fontSize(20).font("Helvetica-Bold").text(company.name, leftMargin, currentY, { align: "center", lineBreak: false })
      currentY += 25
      doc.fontSize(9).font("Helvetica")
      const centerX = pageWidth / 2
      if (compAddr.street) doc.text(compAddr.street, leftMargin, currentY, { align: "center", width: pageWidth - 100, lineBreak: false })
      currentY += 13
      if (compAddr.postalCode || compAddr.city) {
        doc.text(`${compAddr.postalCode || ""} ${compAddr.city || ""}`.trim(), leftMargin, currentY, { align: "center", width: pageWidth - 100, lineBreak: false })
      }
      currentY += 13
      if (compAddr.country) doc.text(compAddr.country, leftMargin, currentY, { align: "center", width: pageWidth - 100, lineBreak: false })
      currentY += 20
    } else {
      // Left-aligned company info (no logo)
      doc.fontSize(18).font("Helvetica-Bold").text(company.name, leftMargin, currentY, { align: "left", lineBreak: false })
      currentY += 22
      doc.fontSize(9).font("Helvetica")
      if (compAddr.street) doc.text(compAddr.street, leftMargin, currentY, { lineBreak: false })
      currentY += 12
      if (compAddr.postalCode || compAddr.city) {
        doc.text(`${compAddr.postalCode || ""} ${compAddr.city || ""}`.trim(), leftMargin, currentY, { lineBreak: false })
      }
      currentY += 12
      if (compAddr.country) doc.text(compAddr.country, leftMargin, currentY, { lineBreak: false })
      currentY += 20
    }

    // Invoice title - right aligned to rightMargin. CN is a credit note
    // (German law requires it to be clearly marked as "Gutschrift" to
    // avoid confusion with the original invoice).
    const invoiceTitle = (() => {
      switch ((invoice as any).type) {
        case "CN": return "GUTSCHRIFT"
        case "PI": return "PROFORMARECHNUNG"
        case "RCV": return "QUITTUNG"
        default: return "RECHNUNG"
      }
    })()
    const titleWidth = rightMargin - leftMargin
    doc.fontSize(24).font("Helvetica-Bold").text(invoiceTitle, leftMargin, currentY, { width: titleWidth, align: "right", lineBreak: false })
    doc.fontSize(14).text(invoice.invoiceNumber, leftMargin, currentY + 28, { width: titleWidth, align: "right", lineBreak: false })
    currentY += 35

    // Invoice details — right-aligned block (anchored to right margin)
    const detailsY = currentY + 10
    const detailsLabelX = rightMargin - 180  // label column starts here
    const detailsValueX = rightMargin - 60   // value column starts here, right-aligned
    doc.fontSize(10).font("Helvetica")
    let detailsRow = 0
    doc.text("Ausstellungsdatum:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
    detailsRow++
    // (Währung removed — invoice.currency is always EUR and the field
    //  added visual noise without information. Keep the schema column
    //  in case multi-currency is reintroduced later.)
    // For credit notes, link back to the original invoice so the
    // customer knows what is being reversed.
    if ((invoice as any).type === "CN" && (invoice as any).referenceInvoiceId) {
      const ref = (invoice as any).referenceInvoice
      const refNumber = ref?.invoiceNumber || "—"
      doc.text("Bezug zu Rechnung:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }

    detailsRow = 0
    doc.text(formatDate(invoice.issueDate), detailsValueX, detailsY + detailsRow * 15, { width: 60, align: "right", lineBreak: false })
    detailsRow++
    if ((invoice as any).type === "CN" && (invoice as any).referenceInvoiceId) {
      const ref = (invoice as any).referenceInvoice
      const refNumber = ref?.invoiceNumber || "—"
      doc.text(refNumber, detailsValueX, detailsY + detailsRow * 15, { width: 60, align: "right", lineBreak: false })
      detailsRow++
    }

    currentY = detailsY + detailsRow * 15 + 10

    // Customer address
    const customerY = currentY
    const custAddr = invoice.customer.address || {}
    let custY = customerY
    doc.fontSize(10).font("Helvetica-Bold").text("Rechnungsadresse:", leftMargin, custY, { lineBreak: false })
    custY += 15
    doc.fontSize(10).font("Helvetica")
    doc.text(invoice.customer.name, leftMargin, custY, { lineBreak: false })
    custY += 13
    if (custAddr.street) {
      doc.text(custAddr.street, leftMargin, custY, { lineBreak: false })
      custY += 13
    }
    if (custAddr.postalCode || custAddr.city) {
      doc.text(`${custAddr.postalCode || ""} ${custAddr.city || ""}`.trim(), leftMargin, custY, { lineBreak: false })
      custY += 13
    }
    if (custAddr.country) {
      doc.text(custAddr.country, leftMargin, custY, { lineBreak: false })
      custY += 13
    }
    if (invoice.customer.vatId) {
      doc.text(`UST-IDNr.: ${invoice.customer.vatId}`, leftMargin, custY, { lineBreak: false })
      custY += 13
    }

    // Items table
    const tableStartY = isCompact ? 280 : 320
    let y = tableStartY

    if (isCompact) {
      // Compact table with fewer columns (Brutto column removed)
      // sku + desc are two independent columns so the SKU gets its own
      // header. SKU width 80 holds typical "ART-001" / "SMK-001"; remaining
      // 240px goes to the description.
      const compactColWidths = { sku: 80, desc: 240, qty: 80, price: 130 }
      const compactHeaderHeight = 20

      // Compact table header - no fill, just bottom border
      doc.moveTo(leftMargin, y + compactHeaderHeight).lineTo(rightMargin, y + compactHeaderHeight).lineWidth(0.8).stroke()
      doc.fillColor("#000000")
        .fontSize(9).font("Helvetica-Bold")
        .text("Artikel Nr.", leftMargin + 5, y + 6, { width: compactColWidths.sku - 10, lineBreak: false })
        .text("Beschreibung", leftMargin + compactColWidths.sku, y + 6, { width: compactColWidths.desc - 10, lineBreak: false })
        .text("Menge", leftMargin + compactColWidths.sku + compactColWidths.desc, y + 6, { width: compactColWidths.qty, align: "center", lineBreak: false })
        .text("Einzelpreis", leftMargin + compactColWidths.sku + compactColWidths.desc + compactColWidths.qty, y + 6, { width: compactColWidths.price, align: "center", lineBreak: false })

      y += compactHeaderHeight
      doc.fillColor("#000000").font("Helvetica").fontSize(9).lineWidth(0.3)
      // Center amounts in their columns
      const cQtyX = leftMargin + compactColWidths.sku + compactColWidths.desc
      const cQtyW = compactColWidths.qty
      const cPriceX = leftMargin + compactColWidths.sku + compactColWidths.desc + compactColWidths.qty
      const cPriceW = compactColWidths.price
      invoice.items.forEach((item, i) => {
        const rowHeight = 20
        // Light dotted line between rows instead of fill
        if (i > 0) {
          doc.moveTo(leftMargin, y).lineTo(rightMargin, y).stroke()
        }
        // SKU in its own column (centered); if no linked product, show "—"
        const sku = (item as any).product?.sku || "—"
        doc.font("Helvetica-Bold").fontSize(9)
          .text(sku, leftMargin + 5, y + 5, { width: compactColWidths.sku - 10, align: "center", lineBreak: false })
        doc.font("Helvetica").fontSize(9)
          .text(item.description, leftMargin + compactColWidths.sku, y + 5, { width: compactColWidths.desc - 10, lineBreak: false })
        doc.text(`${formatNumber(toFloat(item.quantity))} ${item.unit || ''}`, cQtyX, y + 5, { width: cQtyW, align: "center", lineBreak: false })
        doc.text(formatCurrency(toFloat(item.unitPrice)), cPriceX, y + 5, { width: cPriceW, align: "center", lineBreak: false })
        y += rowHeight
      })
    } else {
      // Standard table (Brutto column removed; Netto kept as the per-line total)
      // Column widths: sku + desc + qty + price + vat + net must end at rightMargin
      // so the right edge of "Gesamt" column aligns with the totals area on the right.
      const colWidths = { sku: 70, desc: 150, qty: 55, price: 75, vat: 55, net: 90 }
      // (sum: 495; rightMargin - leftMargin = 495 → last column ends exactly at rightMargin)
      const headerHeight = 25
      const rowHeight = 24

      // Table header - no fill, just bottom border
      doc.moveTo(leftMargin, y + headerHeight).lineTo(rightMargin, y + headerHeight).lineWidth(0.8).stroke()
      doc.fillColor("#000000")
        .fontSize(10).font("Helvetica-Bold")
        .text("Artikel Nr.", leftMargin + 5, y + 8, { width: colWidths.sku - 10, lineBreak: false })
        .text("Beschreibung", leftMargin + colWidths.sku, y + 8, { width: colWidths.desc - 10, lineBreak: false })
        .text("Menge", leftMargin + colWidths.sku + colWidths.desc, y + 8, { width: colWidths.qty, align: "center", lineBreak: false })
        .text("Einzelpreis", leftMargin + colWidths.sku + colWidths.desc + colWidths.qty, y + 8, { width: colWidths.price, align: "center", lineBreak: false })
        .text("MwSt", leftMargin + colWidths.sku + colWidths.desc + colWidths.qty + colWidths.price, y + 8, { width: colWidths.vat, align: "center", lineBreak: false })
        // Gesamt header: right-aligned within net column → right edge = rightMargin
        const sNetX = leftMargin + colWidths.sku + colWidths.desc + colWidths.qty + colWidths.price + colWidths.vat
        const sNetW = colWidths.net
        doc.text("Gesamt", sNetX, y + 8, { width: sNetW, align: "right", lineBreak: false })

      y += headerHeight
      doc.font("Helvetica").fontSize(10).lineWidth(0.3)
      // Pre-compute column positions
      const sQtyX = leftMargin + colWidths.sku + colWidths.desc
      const sQtyW = colWidths.qty
      const sPriceX = leftMargin + colWidths.sku + colWidths.desc + colWidths.qty
      const sPriceW = colWidths.price
      const sVatX = leftMargin + colWidths.sku + colWidths.desc + colWidths.qty + colWidths.price
      const sVatW = colWidths.vat
      invoice.items.forEach((item, i) => {
        // Light dotted line between rows
        if (i > 0) {
          doc.moveTo(leftMargin, y).lineTo(rightMargin, y).stroke()
        }
        // SKU in its own column (centered); if no linked product, show "—"
        const sku = (item as any).product?.sku || "—"
        doc.fillColor("#000000")
        doc.font("Helvetica-Bold").fontSize(10)
          .text(sku, leftMargin + 5, y + 7, { width: colWidths.sku - 10, align: "center", lineBreak: false })
        doc.font("Helvetica").fontSize(10)
          .text(item.description, leftMargin + colWidths.sku, y + 7, { width: colWidths.desc - 10, lineBreak: false })
        doc.text(`${formatNumber(toFloat(item.quantity))} ${item.unit || ''}`, sQtyX, y + 7, { width: sQtyW, align: "center", lineBreak: false })
        doc.text(formatCurrency(toFloat(item.unitPrice)), sPriceX, y + 7, { width: sPriceW, align: "center", lineBreak: false })
        doc.text(formatVatRate(toFloat(item.vatRate)), sVatX, y + 7, { width: sVatW, align: "center", lineBreak: false })
        // Per-line total right edge = rightMargin, so it aligns vertically with totals below
        doc.text(formatCurrency(toFloat(item.netAmount)), sNetX, y + 7, { width: sNetW, align: "right", lineBreak: false })
        y += rowHeight
      })
    }

    // Totals - ink-saving design: just borders and bold text, no fills
    const totalsY = y + (isCompact ? 15 : 20)
    const totalsLineY = totalsY
    // Anchor amounts to the SAME right edge as the table's Gesamt column
    const totalsLabelX = leftMargin + (isCompact ? 180 : 220)
    const totalsAmountX = rightMargin - 100  // right-aligned width = 100, ends at rightMargin
    const totalsAmountWidth = 100
    doc.moveTo(totalsAmountX, totalsLineY).lineTo(rightMargin, totalsLineY).lineWidth(0.8).stroke()

    const totalsFontSize = isCompact ? 10 : 11
    const totalsLineHeight = isCompact ? 20 : 22

    doc.fillColor("#000000").font("Helvetica").fontSize(totalsFontSize).lineWidth(0.3)
    doc.text("Zwischensumme (Netto):", totalsLabelX, totalsY + 5, { lineBreak: false })
    doc.text(formatCurrency(toFloat(invoice.subtotal)), totalsAmountX, totalsY + 5, { width: totalsAmountWidth, align: "right", lineBreak: false })
    doc.text("Gesamtbetrag USt:", totalsLabelX, totalsY + totalsLineHeight, { lineBreak: false })
    doc.text(formatCurrency(toFloat(invoice.totalVat)), totalsAmountX, totalsY + totalsLineHeight, { width: totalsAmountWidth, align: "right", lineBreak: false })

    // Gesamtbetrag with bold border box (no fill, just outline)
    const gesamtY = totalsY + totalsLineHeight * 2
    const gesamtHeight = totalsLineHeight + 4
    const gesamtBoxX = totalsLabelX - 5
    const gesamtBoxWidth = rightMargin - gesamtBoxX
    doc.lineWidth(1.0)
    doc.rect(gesamtBoxX, gesamtY, gesamtBoxWidth, gesamtHeight).stroke()
    doc.fillColor("#000000").font("Helvetica-Bold").fontSize(totalsFontSize + 2)
    doc.text("Gesamtbetrag:", gesamtBoxX + 5, gesamtY + 6, { lineBreak: false })
    doc.text(formatCurrency(toFloat(invoice.total)), totalsAmountX, gesamtY + 6, { width: totalsAmountWidth, align: "right", lineBreak: false })

    // Notes
    if (invoice.notes) {
      const notesY = totalsY + (isCompact ? 60 : 80)
      doc.fontSize(9).font("Helvetica-Bold").text("Bemerkungen:", leftMargin, notesY, { lineBreak: false })
      doc.font("Helvetica").text(invoice.notes, leftMargin, notesY + 15, { width: isCompact ? 300 : 400, lineBreak: true })
    }

    // Footer with bank info
    const footerY = doc.page.height - (isCompact ? 80 : 100)
    doc.fontSize(8).fillColor("#000000")
    if (company.bankInfo && typeof company.bankInfo === 'object') {
      doc.text("Zahlungsinformationen:", leftMargin, footerY, { lineBreak: false })
      if (company.bankInfo.bankName) doc.text(`Bank: ${company.bankInfo.bankName}`, leftMargin, footerY + 15, { lineBreak: false })
      if (company.bankInfo.iban) doc.text(`IBAN: ${company.bankInfo.iban}`, leftMargin, footerY + 28, { lineBreak: false })
      if (company.bankInfo.bic) doc.text(`BIC: ${company.bankInfo.bic}`, leftMargin, footerY + 41, { lineBreak: false })
    }

    if (company.vatId) {
      doc.text(`UST-IDNr.: ${company.vatId}`, leftMargin, footerY + 60, { lineBreak: false })
    }

    // Add page number in footer. `doc.page.number` can be undefined
    // in some PDFKit builds (notably when the doc is being torn down
    // asynchronously after `doc.end()`), which previously caused the
    // literal string "undefined" to appear at the right margin of the
    // PDF footer next to the company VAT number. Fall back to the
    // buffered page count from PDFKit's own helper, which is always
    // populated while writing.
    const pageCount = doc.bufferedPageRange
      ? doc.bufferedPageRange().count
      : doc.page?.number ?? 1
    doc.text(
      `Seite ${pageCount}`,
      rightMargin - 40,
      footerY + 60,
      { align: "right", lineBreak: false }
    )

    doc.end()
  })
}

function resolveLogoPath(logoPath: string): string | null {
  // If it's an absolute path, use it directly
  if (path.isAbsolute(logoPath)) {
    return logoPath
  }

  // Check if it's a relative path from public/images
  if (logoPath.startsWith('images/')) {
    // Try to resolve from project root
    const projectRoot = process.cwd()
    const fullPath = path.join(projectRoot, 'frontend', 'public', logoPath)
    if (fs.existsSync(fullPath)) {
      return fullPath
    }
  }

  // Try the provided path as-is
  if (fs.existsSync(logoPath)) {
    return logoPath
  }

  return null
}

function formatDate(dateStr: string | Date): string {
  const date = dateStr instanceof Date ? dateStr : new Date(dateStr)
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })
}

function toFloat(val: string | number): number {
  if (typeof val === 'number') return val
  return parseFloat(val) || 0
}

// German number format: 1.234,56
function formatNumber(val: number): string {
  return val.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

// German currency format: € 1.234,56 (with space after € sign)
function formatCurrency(val: number): string {
  return "€\u00A0" + val.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatVatRate(rate: number): string {
  if (rate === 0.19) return "19%"
  if (rate === 0.07) return "7%"
  return "0%"
}