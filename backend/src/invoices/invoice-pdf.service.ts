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
  // Contact info — used by the letterhead block at the top of
  // the invoice (printed as email · phone on a single line).
  email?: string
  phone?: string
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

    // Header area Y positions. The header now uses FIXED Y
    // coordinates per the latest user request — the layout is no
    // longer a vertical stack but a 2x2 grid:
    //
    //   +--------------------------------------------------+
    //   |                  [Logo 居中]   [Company 右上]  |
    //   |                                                  |
    //   |  [Customer 左上]                  [RECHNUNG 右] |
    //   |                                                  |
    //   |  [Items table spanning full width            ]  |
    //   +--------------------------------------------------+
    //
    // Top row: Logo (center) + Company name + address (right).
    // Middle row: Customer address (left, where company name
    // USED to be) + RECHNUNG title + details (right).
    // Bottom: items table starts at a Y that follows the
    // customer block's bottom.
    const headerStartY = 50

    // Draw logo if available and template allows. Logo lives in
    // the top band, centered horizontally, height 68 (3-round
    // sizing: 40 → 52 → 68).
    if (showLogo && company.logoPath) {
      const logoPath = resolveLogoPath(company.logoPath)
      if (logoPath && fs.existsSync(logoPath)) {
        try {
          const imgHeight = 68
          const img = doc.openImage(logoPath)
          const imgWidth = Math.min(img.width * (imgHeight / img.height), 220)
          const imgX = (pageWidth - imgWidth) / 2
          doc.image(logoPath, imgX, headerStartY, { height: imgHeight })
        } catch (err) {
          console.warn("Failed to load logo:", err)
        }
      }
    }

    // Company info header — top-right, same Y band as the logo.
    // Per user: "公司名和地址都放到右上角和 logo 同一排".
    // Anchored to rightMargin; the block's right edge lands at
    // the page's right margin.
    const compAddr = company.address || {}
    const rightBlockWidth = rightMargin - leftMargin

    if (showLogo) {
      // Top-right: company name + address stack, right-aligned.
      // Starts at y=50 (headerStartY) to align with the logo's
      // top edge — that's the "同一排" requirement.
      doc.fontSize(20).font("Helvetica-Bold").text(company.name, leftMargin, headerStartY, { width: rightBlockWidth, align: "right", lineBreak: false })
      doc.fontSize(9).font("Helvetica")
      let cy = headerStartY + 25
      if (compAddr.street) {
        doc.text(compAddr.street, leftMargin, cy, { width: rightBlockWidth, align: "right", lineBreak: false })
        cy += 12
      }
      if (compAddr.postalCode || compAddr.city) {
        doc.text(`${compAddr.postalCode || ""} ${compAddr.city || ""}`.trim(), leftMargin, cy, { width: rightBlockWidth, align: "right", lineBreak: false })
        cy += 12
      }
      if (compAddr.country) {
        doc.text(compAddr.country, leftMargin, cy, { width: rightBlockWidth, align: "right", lineBreak: false })
        cy += 12
      }
      // Optional contact line under the address.
      const contactParts: string[] = []
      if (company.email) contactParts.push(company.email)
      if (company.phone) contactParts.push(company.phone)
      if (contactParts.length) {
        doc.fontSize(8).font("Helvetica").text(contactParts.join("  ·  "), leftMargin, cy + 2, { width: rightBlockWidth, align: "right", lineBreak: false })
      }
    } else {
      // No logo path on this company. Fall back to a left-aligned
      // letterhead at the top of the page.
      doc.fontSize(18).font("Helvetica-Bold").text(company.name, leftMargin, headerStartY, { lineBreak: false })
      doc.fontSize(9).font("Helvetica")
      let cy = headerStartY + 22
      if (compAddr.street) {
        doc.text(compAddr.street, leftMargin, cy, { lineBreak: false })
        cy += 12
      }
      if (compAddr.postalCode || compAddr.city) {
        doc.text(`${compAddr.postalCode || ""} ${compAddr.city || ""}`.trim(), leftMargin, cy, { lineBreak: false })
        cy += 12
      }
      if (compAddr.country) {
        doc.text(compAddr.country, leftMargin, cy, { lineBreak: false })
      }
    }

    // Middle row Y band: the customer's address block lives on
    // the LEFT at this y (per user: "客户的 Rechnungsadresse 往上
    // 拉放到之前公司名这一排，设置靠左边"), and the RECHNUNG
    // title + invoice details on the RIGHT.
    //
    // Pick the middle row Y. We anchor it just below the logo
    // block (headerStartY + 68 + 14 = 132 — that's roughly where
    // the company name USED to be in the v3/v4 layout).
    const middleRowY = headerStartY + 68 + 14  // 132

    // Customer address — left side of the middle row. Sits at
    // the same Y as the RECHNUNG title to its right.
    const custAddr = invoice.customer.address || {}
    let custY = middleRowY
    // Sender line ("Absenderzeile"). Per user request:
    //   - "sender 公司名+地址 只要一行" — single-line format
    //   - "缩小50%，方便用于寄信封" — 50% smaller (10pt → 5pt) so
    //     it works as the return-address line printed on a window
    //     envelope. Tiny, not meant to be read at normal reading
    //     distance — just visible to the postman if the envelope
    //     gets misrouted.
    //
    // Format: "Name · Straße · PLZ Ort · Land" joined with " · ".
    // Skip empty address parts so we don't render stray separators.
    const senderParts: string[] = [company.name]
    if (compAddr.street) senderParts.push(compAddr.street)
    const pcCity = `${compAddr.postalCode || ""} ${compAddr.city || ""}`.trim()
    if (pcCity) senderParts.push(pcCity)
    if (compAddr.country) senderParts.push(compAddr.country)
    doc.fontSize(5).font("Helvetica").text(senderParts.join(" · "), leftMargin, custY, { lineBreak: false })
    custY += 10
    // Customer block — font 11pt (was 10pt; +10% per user request).
    // Note: the original "Rechnungsadresse:" label has been moved up
    // and replaced with the sender's own company name + address
    // (per the user's request). We don't repeat a "Rechnungsadresse:"
    // label down here — the sender block above acts as the
    // invoice-letterhead label.
    doc.fontSize(11).font("Helvetica")
    doc.text(invoice.customer.name, leftMargin, custY, { lineBreak: false })
    custY += 14
    if (custAddr.street) {
      doc.text(custAddr.street, leftMargin, custY, { lineBreak: false })
      custY += 14
    }
    if (custAddr.postalCode || custAddr.city) {
      doc.text(`${custAddr.postalCode || ""} ${custAddr.city || ""}`.trim(), leftMargin, custY, { lineBreak: false })
      custY += 14
    }
    if (custAddr.country) {
      doc.text(custAddr.country, leftMargin, custY, { lineBreak: false })
      custY += 14
    }
    if (invoice.customer.vatId) {
      doc.text(`UST-IDNr.: ${invoice.customer.vatId}`, leftMargin, custY, { lineBreak: false })
      custY += 14
    }

    // RECHNUNG title + invoice number — right side of the middle
    // row. Same Y as the customer block on the left, so the two
    // blocks share the same horizontal band.
    const invoiceTitle = (() => {
      switch ((invoice as any).type) {
        case "CN": return "GUTSCHRIFT"
        case "PI": return "PROFORMARECHNUNG"
        case "RCV": return "QUITTUNG"
        default: return "RECHNUNG"
      }
    })()
    doc.fontSize(24).font("Helvetica-Bold").text(invoiceTitle, leftMargin, middleRowY, { width: rightBlockWidth, align: "right", lineBreak: false })
    doc.fontSize(14).text(invoice.invoiceNumber, leftMargin, middleRowY + 28, { width: rightBlockWidth, align: "right", lineBreak: false })

    // Invoice details — right side, just below RECHNUNG title.
    // Anchored to right margin, two columns (label + value).
    const detailsY = middleRowY + 58
    const detailsLabelX = rightMargin - 180
    const detailsValueX = rightMargin - 60
    doc.fontSize(10).font("Helvetica")
    let detailsRow = 0
    const customerNumber = (invoice as any).customer?.customerNumber
    if (customerNumber) {
      doc.text("Kundennummer:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    doc.text("Ausstellungsdatum:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
    detailsRow++
    if ((invoice as any).type === "CN" && (invoice as any).referenceInvoiceId) {
      const ref = (invoice as any).referenceInvoice
      doc.text("Bezug zu Rechnung:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }

    detailsRow = 0
    if (customerNumber) {
      doc.text(customerNumber, detailsValueX, detailsY + detailsRow * 15, { width: 60, align: "right", lineBreak: false })
      detailsRow++
    }
    doc.text(formatDate(invoice.issueDate), detailsValueX, detailsY + detailsRow * 15, { width: 60, align: "right", lineBreak: false })
    detailsRow++
    if ((invoice as any).type === "CN" && (invoice as any).referenceInvoiceId) {
      const ref = (invoice as any).referenceInvoice
      const refNumber = ref?.invoiceNumber || "—"
      doc.text(refNumber, detailsValueX, detailsY + detailsRow * 15, { width: 60, align: "right", lineBreak: false })
      detailsRow++
    }

    // Items table Y — follow the larger of (a) customer block end
    // or (b) invoice details end. This is the previous bug fix
    // from the v4 revision; the explicit logic lives here so the
    // table doesn't intrude on either block.
    const detailsEndY = detailsY + detailsRow * 15 + 10
    const tableStartY = isCompact
      ? Math.max(280, Math.max(custY, detailsEndY) + 20)
      : Math.max(280, Math.max(custY, detailsEndY) + 20)
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
          .text(sku, leftMargin, y + 5, { width: compactColWidths.sku, align: "center", lineBreak: false })
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
          .text(sku, leftMargin, y + 7, { width: colWidths.sku, align: "center", lineBreak: false })
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

  // The logo upload endpoint stores just the bare filename
  // (e.g. 'logo.png') in Company.logoPath, with the actual file
  // living at frontend/public/images/<name>. Anchor the lookup
  // to the project root via __dirname (this file lives at
  // backend/src/invoices/, so go up 3 levels), NOT process.cwd()
  // — the backend is started from backend/ and CWD doesn't reach
  // the project root the way the upload fix expected.
  //
  // Also accept the older 'images/<name>' form in case any DB row
  // was saved that way (compatibility shim).
  const projectRoot = path.resolve(__dirname, '..', '..', '..')
  const candidateNames = [
    path.join(projectRoot, 'frontend', 'public', 'images', path.basename(logoPath)),
  ]
  if (logoPath.startsWith('images/') || logoPath.startsWith('/images/')) {
    candidateNames.push(
      path.join(projectRoot, 'frontend', 'public', logoPath.replace(/^\//, '')),
    )
  }

  for (const candidate of candidateNames) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  // Last resort: try the path as-is (relative to CWD). Will
  // usually miss for the same reason as the upload bug, but
  // doesn't hurt to try.
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