import PDFKit from "pdfkit"
import * as fs from "fs"
import * as path from "path"
import QRCode from "qrcode"

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
  // Tier 52/54: Skonto fields drive the "Zahlbar bis
  // X mit Y% Skonto, bis Z ohne Abzug" footer line.
  // Both nullable; both set = render the line.
  skontoPercent?: any
  skontoDays?: any
  // Tier 53/54: type='CN' carries the original
  // invoiceNumber so the PDF header can read
  // "Gutschrift zu <original>".
  type?: string
  referenceInvoiceId?: string | null
  referenceInvoice?: { invoiceNumber: string } | null
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
  // Extended contact info — used by the letterhead (fax and
  // website, each on their own row) and by the right-side
  // Impressum / footer block in the bottom-right corner of
  // the PDF (Handelsregister, Geschäftsführer, otherInfo).
  // Earlier versions of the CompanyInfo type omitted these,
  // so the invoice controller couldn't forward them to the
  // PDF generator (TypeScript would reject unknown
  // properties), and the Impressum block rendered as empty
  // because `(company as any).registerEntry` was always
  // undefined. Adding them here lets the controller actually
  // pass the full company record down.
  legalName?: string
  fax?: string
  website?: string
  registerEntry?: string
  managingDirector?: string
  otherInfo?: string
}

export type InvoiceTemplateType = "standard" | "simplified" | "compact"

/**
 * Tier 7.5: visual config the renderer
 * reads at PDF-build time. Sourced from
 * the InvoiceTemplate row (custom) or
 * a built-in preset (standard /
 * simplified / compact). The shape
 * matches InvoiceTemplateService's
 * TemplateConfig (kept loose here to
 * avoid a circular import).
 *
 * `accentColor` is currently unused but
 * kept in the type so future
 * renderers (e.g. the bank-info bar in
 * the footer) can pick it up without
 * changing the call site.
 */
export interface InvoiceRenderConfig {
  primaryColor?: string
  accentColor?: string
  textColor?: string
  fontFamily?: 'Helvetica' | 'Times-Roman' | 'Courier'
  layoutDensity?: 'comfortable' | 'compact'
  showLogo?: boolean
  footerText?: string
  paymentTermsText?: string
  showAbsenderzeile?: boolean
  reverseChargeNote?: string
  // Tier 27: §1a UStG note for innergemeinschaftliche
  // Lieferungen. Rendered at the same position as
  // reverseChargeNote (footerY - 28) but only when
  // invoice.euTransaction === true. An invoice can't
  // be BOTH reverseCharge and euTransaction, so only
  // one of the two is ever visible.
  euTransactionNote?: string
  kleineUnternehmerNote?: string
}

export async function generateInvoicePDF(
  invoice: Invoice,
  company: CompanyInfo,
  templateType: string = "standard",
  renderConfig?: InvoiceRenderConfig
): Promise<Buffer> {
  // Tier 224: pre-generate the GiroCode (EPC QR
  // code) PNG before opening the PDFKit doc. The
  // `qrcode` lib's toBuffer is async, and the
  // rest of the PDFKit construction is synchronous
  // inside a new-Promise executor. Awaiting here
  // adds ~5-15ms (one-time cost) and keeps the
  // rest of the function unchanged. Tier 224 chose
  // readability over a Promise.resolve chain.
  //
  // null when the company has no IBAN — the
  // renderer checks for null and skips the QR
  // block entirely. EC level M per EPC069-12 v2
  // recommendation. 360px width is 4x the 90pt
  // display size, plenty for a crisp 300dpi PDF.
  const qrPayload = buildEpcQrPayload(company, invoice)
  let qrBuffer: Buffer | null = null
  if (qrPayload) {
    try {
      qrBuffer = await QRCode.toBuffer(qrPayload, {
        errorCorrectionLevel: 'M',
        type: 'png',
        margin: 1,
        width: 360,
      })
    } catch {
      // Malformed IBAN, etc. — render without
      // the QR. The left-side IBAN/BIC text
      // block is still there as fallback.
      qrBuffer = null
    }
  }
  return new Promise((resolve, reject) => {
    const template = templateType as InvoiceTemplateType
    // Tier 7.5: build the font name for a
    // given style. The renderer used to
    // call .font(fontFor('regular')) or
    // .font(fontFor('bold')) directly;
    // now we route through a helper so
    // the fontFamily from the template
    // config actually shows up in the
    // PDF. Style is "regular" or "bold"
    // (the only two the existing PDF
    // uses). For Times/Courier the bold
    // variant is "Times-Bold" /
    // "Courier-Bold" — the suffix is
    // always "-Bold", which keeps the
    // helper trivial.
    const fontFamily = renderConfig?.fontFamily || "Helvetica"
    // PDFKit's bold variants:
    //   - Helvetica → "Helvetica-Bold"
    //   - Times-Roman → "Times-Bold"
    //   - Courier → "Courier-Bold"
    // Notice the leading dash for
    // Helvetica and the missing dash
    // for Times / Courier. The
    // validation in the controller
    // restricts fontFamily to these 3
    // values, so this map is the only
    // place that needs to know.
    const BOLD_FONT: Record<string, string> = {
      Helvetica: 'Helvetica-Bold',
      'Times-Roman': 'Times-Bold',
      Courier: 'Courier-Bold',
    }
    const fontFor = (style: 'regular' | 'bold'): string =>
      style === 'bold' ? BOLD_FONT[fontFamily] || `${fontFamily}-Bold` : fontFamily

    // Apply primaryColor to the
    // PDFKit default fill. Most of the
    // PDF is text, and text inherits
    // the default fill. Where we draw
    // shapes (the line under the items
    // table) we use the primary color.
    const primaryColor = renderConfig?.primaryColor || "#000000"
    const textColor = renderConfig?.textColor || "#000000"
    // Page margin: 10pt on all sides (down from 20pt). The
    // smaller bottom margin gives the footer blocks enough
    // room to fit on page 1 even with the full 4-row bank
    // info AND the page number text written at the very
    // bottom of the page. A4 = 841.89pt, so with 10pt
    // margin the maxY is 831.89pt — enough for 4-5 footer
    // lines + 1 page-number line + a 10pt buffer.
    // Page margins: top/left/right restored to the original
    // 50pt (the user wanted the "upper, left, right margins
    // back to the original values"). Bottom margin stays at
    // 10pt so the 4-row bank info + 4-row Impressum + bottom-
    // center "Seite X" still fit on a single A4 page without
    // triggering an addPage. PDFKit's `margins` option takes
    // a per-side object — `margin` (singular) is the all-sides
    // shortcut and would clobber this.
    const doc = new PDFKit({ margins: { top: 50, left: 50, right: 50, bottom: 10 }, size: "A4" }) as any
    const chunks: Buffer[] = []

    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const pageWidth = doc.page.width
    // Match the original (pre-v36) left/right margins — 50pt
    // on each side. The top margin is also 50pt, the bottom
    // is 10pt (see the PDFKit options above).
    const leftMargin = 50
    const rightMargin = pageWidth - 50

    // Calculate layout based on template
    // Tier 7.5: density now comes from the
    // resolved renderConfig (read from the
    // InvoiceTemplate row or a built-in
    // preset). Falls back to the
    // templateType for backward compat —
    // existing callers that pass only the
    // string still get the same layout
    // (standard → comfortable, compact →
    // compact, simplified → comfortable).
    const isCompact = renderConfig?.layoutDensity === 'compact' || (template === "compact" && !renderConfig)
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
      doc.fontSize(20).font(fontFor('bold')).text(company.name, leftMargin, headerStartY, { width: rightBlockWidth, align: "right", lineBreak: false })
      doc.fontSize(9).font(fontFor('regular'))
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
      // Optional contact line under the address. We pack up to
      // Per user request: phone + fax share one line (joined
      // with " · "), email and website each get their own line.
      // Three single-line right-aligned blocks at 8pt. Skip
      // empty channels entirely — a company that hasn't filled
      // in website just gets the first two (or one) lines.
      // The HR / Geschäftsführer / Sonstige Angaben used to live
      // here too, but they got too long and crowded the right
      // side; they now live in the right footer instead.
      doc.fontSize(8).font(fontFor('regular'))
      let contactY = cy + 2
      // Row 1: phone · fax
      const phoneFax: string[] = []
      if (company.phone) phoneFax.push(company.phone)
      if ((company as any).fax) phoneFax.push(`Fax: ${(company as any).fax}`)
      if (phoneFax.length) {
        doc.text(phoneFax.join("  ·  "), leftMargin, contactY, { width: rightBlockWidth, align: "right", lineBreak: false })
        contactY += 10
      }
      // Row 2: email
      if (company.email) {
        doc.text(company.email, leftMargin, contactY, { width: rightBlockWidth, align: "right", lineBreak: false })
        contactY += 10
      }
      // Row 3: website
      if ((company as any).website) {
        doc.text((company as any).website, leftMargin, contactY, { width: rightBlockWidth, align: "right", lineBreak: false })
      }
    } else {
      // No logo path on this company. Fall back to a left-aligned
      // letterhead at the top of the page.
      doc.fontSize(18).font(fontFor('bold')).text(company.name, leftMargin, headerStartY, { lineBreak: false })
      doc.fontSize(9).font(fontFor('regular'))
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
    // Sender + customer block gets offset down 2 rows
    // (2 × 14pt = 28pt) so the address area sits clearly below
    // the logo/letterhead band and doesn't crowd the right-side
    // RECHNUNG block. Matches the title block's 3-row offset
    // visually (a touch less so the address tops just under
    // the invoice number on the right).
    const senderOffsetY = 28
    const senderStartY = middleRowY + senderOffsetY  // 160

    // Customer address — left side of the middle row. Sits at
    // the same Y as the RECHNUNG title to its right.
    const custAddr = invoice.customer.address || {}
    let custY = senderStartY
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
    doc.fontSize(5).font(fontFor('regular')).text(senderParts.join(" · "), leftMargin, custY, { lineBreak: false })
    custY += 10
    // Customer block — font 11pt (was 10pt; +10% per user request).
    // Note: the original "Rechnungsadresse:" label has been moved up
    // and replaced with the sender's own company name + address
    // (per the user's request). We don't repeat a "Rechnungsadresse:"
    // label down here — the sender block above acts as the
    // invoice-letterhead label.
    doc.fontSize(11).font(fontFor('regular'))
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
    //
    // Sizes: RECHNUNG title is 20pt (was 24pt — user asked for it
    // closer to the invoice number's size), invoice number is
    // 16pt (was 14pt — bumped up so the two lines form a balanced
    // header block). The whole block is offset down 3 rows
    // (3 × 14pt = 42pt) from middleRowY so the title sits clearly
    // below the customer name on the left.
    const invoiceTitle = (() => {
      switch ((invoice as any).type) {
        case "CN": return "GUTSCHRIFT"
        case "PI": return "PROFORMARECHNUNG"
        case "RCV": return "QUITTUNG"
        default: return "RECHNUNG"
      }
    })()
    const titleOffsetY = 42  // 3 rows down
    const titleY = middleRowY + titleOffsetY
    doc.fontSize(20).font(fontFor('bold')).text(invoiceTitle, leftMargin, titleY, { width: rightBlockWidth, align: "right", lineBreak: false })
    doc.fontSize(16).text(invoice.invoiceNumber, leftMargin, titleY + 24, { width: rightBlockWidth, align: "right", lineBreak: false })

    // Invoice details — right side, just below RECHNUNG title.
    // Anchored to right margin, two columns (label + value).
    //
    // §14 UStG requires the company USt-IDNr. and Steuernummer
    // to appear on every invoice. Per the user, they live
    // directly underneath Ausstellungsdatum on the right, in the
    // same column (same right-aligned value column as the date).
    //
    // Layout: label column on the left, value column on the
    // right. Both are right-aligned so the right edge of every
    // label lands at the same X as the right edge of every
    // value — that's what "对起" (line up) means here: the
    // user wants USt-IDNr and Steuernummer's right edge to
    // match Ausstellungsdatum's right edge exactly.
    //
    // detailsLabelX sits 80pt in from rightMargin, with a 100pt
    // label width → label text right edge lands at rightMargin -
    // 80. detailsValueX sits 100pt in from rightMargin, with a
    // 100pt value width → value text right edge lands exactly
    // at rightMargin. So every value's right edge is 80pt to
    // the right of every label's right edge — a clean 80pt gap
    // between the longest label and the longest value.
    const detailsY = titleY + 54
    const detailsLabelX = rightMargin - 180
    const detailsValueX = rightMargin - 100
    const detailsValueWidth = 100
    doc.fontSize(10).font(fontFor('regular'))
    let detailsRow = 0
    const customerNumber = (invoice as any).customer?.customerNumber
    if (customerNumber) {
      doc.text("Kundennummer:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    doc.text("Ausstellungsdatum:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
    detailsRow++
    // Liefertermin / delivery date — optional. Only shown on
    // the PDF (and on the invoice detail page) when set, so
    // invoices without a delivery date look identical to
    // before. §14 UStG doesn't mandate this; it's a
    // common B2B request so the customer knows when to
    // expect the goods/service.
    if ((invoice as any).deliveryDate) {
      doc.text("Liefertermin:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    if (company.vatId) {
      doc.text("USt-IDNr.:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    if (company.taxId) {
      doc.text("Steuernummer:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    if ((invoice as any).type === "CN" && (invoice as any).referenceInvoiceId) {
      const ref = (invoice as any).referenceInvoice
      doc.text("Bezug zu Rechnung:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }

    detailsRow = 0
    if (customerNumber) {
      doc.text(customerNumber, detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
      detailsRow++
    }
    doc.text(formatDate(invoice.issueDate), detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
    detailsRow++
    if ((invoice as any).deliveryDate) {
      doc.text(formatDate((invoice as any).deliveryDate), detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
      detailsRow++
    }
    if (company.vatId) {
      doc.text(company.vatId, detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
      detailsRow++
    }
    if (company.taxId) {
      doc.text(company.taxId, detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
      detailsRow++
    }
    if ((invoice as any).type === "CN" && (invoice as any).referenceInvoiceId) {
      const ref = (invoice as any).referenceInvoice
      const refNumber = ref?.invoiceNumber || "—"
      doc.text(refNumber, detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
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

      // Compact table header - no fill, just bottom border.
      // Tier 7.5: stroke uses primaryColor.
      doc.strokeColor(primaryColor)
        .moveTo(leftMargin, y + compactHeaderHeight).lineTo(rightMargin, y + compactHeaderHeight).lineWidth(0.8).stroke()
      doc.fillColor(textColor)
      doc.fillColor(textColor)
        .fontSize(9).font(fontFor('bold'))
        .text("Artikel Nr.", leftMargin + 5, y + 6, { width: compactColWidths.sku - 10, lineBreak: false })
        .text("Beschreibung", leftMargin + compactColWidths.sku, y + 6, { width: compactColWidths.desc - 10, lineBreak: false })
        .text("Menge", leftMargin + compactColWidths.sku + compactColWidths.desc, y + 6, { width: compactColWidths.qty, align: "center", lineBreak: false })
        .text("Einzelpreis", leftMargin + compactColWidths.sku + compactColWidths.desc + compactColWidths.qty, y + 6, { width: compactColWidths.price, align: "center", lineBreak: false })

      y += compactHeaderHeight
      doc.fillColor(textColor).font(fontFor('regular')).fontSize(9).lineWidth(0.3)
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
        doc.font(fontFor('bold')).fontSize(9)
          .text(sku, leftMargin, y + 5, { width: compactColWidths.sku, align: "center", lineBreak: false })
        doc.font(fontFor('regular')).fontSize(9)
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

      // Table header - no fill, just bottom border.
      // Tier 7.5: stroke uses primaryColor.
      doc.strokeColor(primaryColor)
        .moveTo(leftMargin, y + headerHeight).lineTo(rightMargin, y + headerHeight).lineWidth(0.8).stroke()
      doc.fillColor(textColor)
        .fontSize(10).font(fontFor('bold'))
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
      doc.font(fontFor('regular')).fontSize(10).lineWidth(0.3)
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
        // SKU in its own column (centered); priority:
        //   1. item.productNumber (snapshot at issue time — survives
        //      later product edits, which is the whole point of the
        //      field, see commit f708fa2)
        //   2. (item as any).product?.sku (live link fallback for
        //      older invoices that predate productNumber)
        //   3. em-dash placeholder for blank
        const sku = (item as any).productNumber || (item as any).product?.sku || "—"
        doc.fillColor(textColor)
        doc.font(fontFor('bold')).fontSize(10)
          .text(sku, leftMargin, y + 7, { width: colWidths.sku, align: "center", lineBreak: false })
        doc.font(fontFor('regular')).fontSize(10)
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
    // Tier 7.5: total divider in primaryColor
    doc.strokeColor(primaryColor)
      .moveTo(totalsAmountX, totalsLineY).lineTo(rightMargin, totalsLineY).lineWidth(0.8).stroke()

    const totalsFontSize = isCompact ? 10 : 11
    const totalsLineHeight = isCompact ? 20 : 22

    doc.fillColor(textColor).font(fontFor('regular')).fontSize(totalsFontSize).lineWidth(0.3)
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
    doc.fillColor(textColor).font(fontFor('bold')).fontSize(totalsFontSize + 2)
    doc.text("Gesamtbetrag:", gesamtBoxX + 5, gesamtY + 6, { lineBreak: false })
    doc.text(formatCurrency(toFloat(invoice.total)), totalsAmountX, gesamtY + 6, { width: totalsAmountWidth, align: "right", lineBreak: false })

    // Notes
    if (invoice.notes) {
      const notesY = totalsY + (isCompact ? 60 : 80)
      doc.fontSize(9).font(fontFor('bold')).text("Bemerkungen:", leftMargin, notesY, { lineBreak: false })
      doc.font(fontFor('regular')).text(invoice.notes, leftMargin, notesY + 15, { width: isCompact ? 300 : 400, lineBreak: true })
    }

    // Footer — left side keeps the bank info (Zahlungsinformationen).
    // The old USt-IDNr. line that used to live here has moved up
    // into the right-side details block (under Ausstellungsdatum)
    // per the user's request. The right side of the footer now
    // carries the Impressum (§5 TMG) and other misc. info that
    // used to clutter the right corner of the letterhead.
    //
    // Bank info is rendered in 4 separate lines (Zahlungsinfo /
    // Bank / IBAN / BIC), each on its own row — per the user's
    // explicit request to NOT merge them onto a single line.
    // Combined with the smaller page margin (10pt instead of
    // 50pt) and the 1-row-up footerY, all 4 lines plus the
    // right Impressum block fit on page 1.
    //
    // Both blocks use Helvetica (non-bold) — the user explicitly
    // asked for them not to be bold. Previously this block
    // inherited Helvetica-Bold from the totals block above,
    // which made the bank info look heavier than the rest of
    // the footer.
    // Footer Y is anchored 74pt above the page bottom (the
    // page bottom is pageHeight = 841.89pt, so footerY =
    // 767.89pt). This is 1 row (14pt) UP from the v38
    // position (footerY = 781.89 = pageHeight - 60), per
    // the user's request to pull the footer back up a row.
    // With the 4-row bank info (Zahlungsinfo + Bank + IBAN
    // + BIC) on the left and the right Impressum block
    // (reg + md + 2 otherInfo lines) on the right, the
    // last footer line lands around footerY + 50 = 817.89,
    // which fits inside the 10pt page margin (maxY =
    // 831.89pt). The page number is placed at the very
    // bottom of the page (pageHeight - 18 = 823.89) so it
    // sits just below the footer blocks.
    const footerY = doc.page.height - 74
    doc.fontSize(8).fillColor(textColor).font(fontFor('regular'))

    // Tier 7.5: render the template's
    // free-text fields above the bank
    // info. These come from the
    // InvoiceTemplate.configJson —
    //   - footerText: a custom thank-you
    //     line ("Vielen Dank...")
    //   - paymentTermsText: replaces the
    //     hard-coded "Zahlbar binnen 14
    //     Tagen..." default
    //   - reverseChargeNote: §13b UStG
    //     notice, only shown for RC
    //     invoices
    //   - kleineUnternehmerNote: §19 UStG
    //     notice, only shown for small
    //     businesses
    //
    // They're placed above the bank
    // info block (footerY - 28 to
    // footerY - 8) so the bank info
    // stays in its established spot at
    // the bottom. The reverseCharge note
    // is suppressed when the invoice
    // doesn't have reverseCharge=true
    // (and similarly for §19) — the
    // template just sets the text, the
    // invoice row decides whether it's
    // shown.
    if (renderConfig?.footerText) {
      doc.font(fontFor('regular')).fontSize(9).fillColor(textColor)
        .text(renderConfig.footerText, leftMargin, footerY - 56, { lineBreak: false })
    }
    if (renderConfig?.paymentTermsText) {
      doc.font(fontFor('regular')).fontSize(8).fillColor(textColor)
        .text(renderConfig.paymentTermsText, leftMargin, footerY - 42, { lineBreak: false })
    }

    // Tier 52/54: Skonto line — the standard German
    // "Zahlbar bis DD.MM. mit X% Skonto, bis DD.MM.
    // ohne Abzug" line, rendered just above the
    // payment-terms text (or above the bank-info
    // block when no paymentTermsText is set). Both
    // skontoPercent and skontoDays must be set; the
    // service enforces the atomic-pair rule.
    //
    // The Skonto-with window expires at
    // issueDate + skontoDays. We render the
    // formatted date in DE locale (dd.mm.yyyy) to
    // match the rest of the PDF.
    const skontoPercent = (invoice as any).skontoPercent
    const skontoDays = (invoice as any).skontoDays
    if (skontoPercent != null && skontoDays != null) {
      const issue = new Date((invoice as any).issueDate)
      const withDue = new Date(issue)
      withDue.setDate(withDue.getDate() + Number(skontoDays))
      const fmt = (d: Date) =>
        d.toLocaleDateString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        })
      const skontoText = `Zahlbar bis ${fmt(withDue)} mit ${Number(skontoPercent).toFixed(skontoPercent % 1 === 0 ? 0 : 2)}% Skonto, bis ${fmt((invoice as any).dueDate)} ohne Abzug.`
      doc
        .font(fontFor('bold'))
        .fontSize(8)
        .fillColor(primaryColor)
        .text(
          skontoText,
          leftMargin,
          renderConfig?.paymentTermsText ? footerY - 28 : footerY - 42,
          { lineBreak: false },
        )
    }
    if (renderConfig?.reverseChargeNote && (invoice as any).reverseCharge) {
      doc.font(fontFor('bold')).fontSize(8).fillColor(primaryColor)
        .text(renderConfig.reverseChargeNote, leftMargin, footerY - 28, { lineBreak: false })
    }
    // Tier 27: §1a UStG note for IgE invoices.
    // Same position as the §13b note — they're
    // mutually exclusive (the backend already
    // rejects both=true on create/update), so only
    // one of the two is ever rendered.
    if (renderConfig?.euTransactionNote && (invoice as any).euTransaction) {
      doc.font(fontFor('bold')).fontSize(8).fillColor(primaryColor)
        .text(renderConfig.euTransactionNote, leftMargin, footerY - 28, { lineBreak: false })
    }
    if (renderConfig?.kleineUnternehmerNote && (invoice as any).euTransaction === false && (invoice as any).totalVat === '0' || (invoice as any).totalVat === 0) {
      // Show §19 note when the invoice has
      // no VAT at all (gross = net). The
      // note tells the customer why
      // there's no USt line.
      doc.font(fontFor('bold')).fontSize(8).fillColor(primaryColor)
        .text(renderConfig!.kleineUnternehmerNote!, leftMargin, footerY - 14, { lineBreak: false })
    }

    if (company.bankInfo && typeof company.bankInfo === 'object') {
      doc.text("Zahlungsinformationen:", leftMargin, footerY, { lineBreak: false })
      if (company.bankInfo.bankName) doc.text(`Bank: ${company.bankInfo.bankName}`, leftMargin, footerY + 12, { lineBreak: false })
      if (company.bankInfo.iban) doc.text(`IBAN: ${company.bankInfo.iban}`, leftMargin, footerY + 24, { lineBreak: false })
      if (company.bankInfo.bic) doc.text(`BIC: ${company.bankInfo.bic}`, leftMargin, footerY + 36, { lineBreak: false })
    }

    // Right footer — Impressum / Rechtliches / Sonstige Angaben.
    // Anchored to rightMargin, right-aligned. We pack everything
    // the user asked for (Handelsregister, Geschäftsführer,
    // Sonstige Angaben) into a single right column. The
    // otherInfo block is multi-line free text and is rendered
    // verbatim with its own line breaks, so it doesn't have to
    // fit on a single line.
    const reg = (company as any).registerEntry
    const md = (company as any).managingDirector
    const other = (company as any).otherInfo
    const rightFooterWidth = rightMargin - leftMargin
    let rightFooterY = footerY
    if (reg) {
      doc.text(`Handelsregister: ${reg}`, leftMargin, rightFooterY, { width: rightFooterWidth, align: "right", lineBreak: false })
      rightFooterY += 12
    }
    if (md) {
      doc.text(`Geschäftsführer: ${md}`, leftMargin, rightFooterY, { width: rightFooterWidth, align: "right", lineBreak: false })
      rightFooterY += 12
    }
    if (other) {
      // Render the otherInfo block line-by-line. We split on
      // the user-typed newlines and write each line with
      // lineBreak:false + a fixed Y offset, instead of passing
      // the whole multi-line string to doc.text with
      // lineBreak:true.
      //
      // Why: PDFKit's `lineBreak: true` + `align: "right"` can
      // collapse user-typed \n separators when the text width
      // interacts with the right-alignment bounding box,
      // causing the second and following lines to draw on top
      // of the first line. Writing each line as a separate
      // fixed-Y doc.text call is more predictable — each line
      // has its own Y, right-edge, and no wrap logic to fight
      // with the user's \n.
      //
      // 9pt per line keeps the right block at the same visual
      // density as the left bank-info block (both 4 lines
      // tall with 12pt reg/md + 9pt otherInfo).
      const otherLines = other.split(/\r?\n/).filter((l: string) => l.length > 0)
      for (const line of otherLines) {
        doc.text(line, leftMargin, rightFooterY, { width: rightFooterWidth, align: "right", lineBreak: false })
        rightFooterY += 9
      }
    }

    // Tier 224: GiroCode (EPC QR code, EPC069-12 v2)
    // for SEPA Überweisung. When the company has an
    // IBAN in bankInfo, render a scannable QR code
    // in the page-bottom strip between the left
    // bank-info block and the right Impressum block.
    // German bank apps (Sparkasse, Volksbank, DKB,
    // ING, N26, etc.) read this and prefill the
    // transfer form.
    //
    // The available vertical strip between footerY
    // (pageHeight-74) and the page number band
    // (pageHeight-22) is 52pt. With EC level M the
    // QR code needs ≥2cm (56.7pt) to scan reliably
    // per the EPC069-12 v2 spec, so we use 56pt =
    // exactly 2cm square. The QR sits between the
    // bank info text (ends ~X=180pt) and the right
    // Impressum block (starts ~X=415pt). At X=240
    // the 56pt QR is centered in the ~235pt gap.
    //
    // The QR ends at qrY+qrSize = pageHeight-18,
    // leaving a 4pt gap to the page number band
    // (pageHeight-22). No label is rendered — the
    // QR's distinctive square finder pattern
    // signals "scan me" to every German banking
    // app without a textual hint. The left-side
    // IBAN/BIC text block is the fallback for
    // humans who don't scan.
    //
    // Skipped silently when no IBAN — the rest of
    // the footer still renders, the customer just
    // doesn't get a scannable code. No error
    // shown so older invoices / IBAN-less companies
    // still print cleanly.
    if (qrBuffer) {
      const qrSize = 56
      const qrX = 240
      const qrY = footerY
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize })
    }

    // Page number — bottom-CENTER of the page, the very last
    // line of the page (per the user's latest request).
    // Y is set to pageHeight - 22 (= 819.89pt on A4), which
    // is 22pt above the page bottom edge. With the smaller
    // 10pt page margin, maxY = 831.89pt, so the page number
    // text (8pt, ~9.6pt lineHeight) fits on page 1 with
    // 12pt of headroom (819.89 + 9.6 = 829.49 < 831.89).
    // Earlier attempts at pageHeight - 18 put the text
    // right at the page-break boundary, triggering an
    // unwanted addPage.
    //
    // The page number is centered horizontally using
    // align:center and a width that spans the full page
    // minus margins (so it always lands at the page
    // horizontal midpoint regardless of leftMargin).
    //
    // `doc.page.number` can be undefined in some PDFKit builds
    // (notably when the doc is being torn down asynchronously
    // after `doc.end()`), which previously caused the literal
    // string "undefined" to appear at the right margin. Fall
    // back to the buffered page count from PDFKit's own helper,
    // which is always populated while writing.
    const pageCount = doc.bufferedPageRange
      ? doc.bufferedPageRange().count
      : doc.page?.number ?? 1
    const pageNumberY = doc.page.height - 22
    doc.text(
      `Seite ${pageCount}`,
      leftMargin,
      pageNumberY,
      { width: pageWidth - leftMargin * 2, align: "center", lineBreak: false }
    )

    // Page number — bottom-right corner, on the LAST line of the
    // left-side Zahlungsinformationen block. We previously tried
    // to place it directly under the right-side Impressum block
    // by reading doc.y after the right-block writes, but that
    // caused a 2nd page whenever otherInfo wrapped to 2+ lines
    // (the page number text was written at y ≈ 790, lineHeight
    // pushed doc.y to ≈ 802, which exceeded maxY 792 and forced
    // an addPage). Pinning the page number to a fixed Y
    // (footerY + 60 — same row as the old USt-IDNr. line that
    // used to live there) is robust to any otherInfo length.
    //
    // `doc.page.number` can be undefined in some PDFKit builds
    // (notably when the doc is being torn down asynchronously
    // after `doc.end()`), which previously caused the literal
    // string "undefined" to appear at the right margin. Fall
    // back to the buffered page count from PDFKit's own helper,
    // which is always populated while writing.
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

// Tier 224: GiroCode (EPC QR code) generator.
// Spec: EPC069-12 v2 (European Payments Council).
// https://www.europeanpaymentscouncil.eu/document-library/guidance-documents/quick-response-code-guidelines-epc-qrcs
//
// The payload is a fixed 5-line header + 5-line data block
// (10 lines, 3 empty) used by European bank apps to prefill
// a SEPA Überweisung (credit transfer). Customer scans the
// QR code on the printed invoice and the bank app jumps
// straight to the "Verify transfer" screen with amount,
// IBAN, BIC, and reference prefilled — saves the customer
// 30s of typing and eliminates the typo class of late
// payments.
//
// Returns null when the company doesn't have an IBAN
// (mandatory per spec) so the renderer can skip the QR
// code entirely. BIC is OPTIONAL in v2 (the bank can
// resolve it from IBAN+name), so we pass it through
// if present and leave it empty otherwise.
//
// Amount: per spec the line is "EUR<amount>" with NO
// thousands separator and always 2 decimal places. We
// drop the trailing 0s only for amounts that are exact
// whole euros (the spec is lenient here in practice).
//
// RefType: "RF" + ISO 11649 creditor reference OR empty.
// We don't use ISO 11649 RF refs (the invoice number
// isn't one), so the line is left empty per spec.
export function buildEpcQrPayload(
  company: CompanyInfo,
  invoice: Invoice,
): string | null {
  const bankInfo = company.bankInfo
  if (!bankInfo || typeof bankInfo !== 'object') return null
  const iban = (bankInfo.iban || '').replace(/\s/g, '').toUpperCase()
  if (!iban || !/^[A-Z]{2}\d{2}[A-Z0-9]{12,30}$/.test(iban)) return null

  // Format amount per spec: 2 decimals, dot decimal
  // separator, NO thousands separator. Total may be a
  // string (Decimal from Prisma) or number.
  const totalNum = toFloat(invoice.total as any)
  const amountStr = totalNum.toFixed(2)

  // Use the invoice number as the Verwendungszweck
  // (unstructured remittance info). The spec says this
  // line can be up to ~70 chars — invoice numbers in
  // this app fit comfortably.
  const unstructured = (invoice.invoiceNumber || '').slice(0, 70)

  // 5 fixed header lines + 5 data lines + 3 empty lines
  // (the spec calls for an empty reference + 2 empty
  // trailing lines, all separated by newlines).
  const bic = (bankInfo.bic || '').replace(/\s/g, '').toUpperCase()
  const name = (company.name || '').slice(0, 70)

  return [
    'BCD',           // Service Tag (fixed)
    '002',           // Version (EPC069-12 v2)
    '1',             // Character set (1 = UTF-8)
    'SCT',           // Identification (SEPA Credit Transfer)
    bic,             // BIC (optional in v2)
    name,            // Beneficiary name
    iban,            // Beneficiary IBAN (mandatory)
    `EUR${amountStr}`, // Amount in EUR
    '',              // Reference type (empty = unstructured)
    unstructured,    // Unstructured remittance info
    '',              // Trailing empty line
  ].join('\n')
}