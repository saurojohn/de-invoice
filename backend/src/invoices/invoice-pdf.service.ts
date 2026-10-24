import { defaultFontFile, registerEmbeddedFonts } from './pdf-fonts'
import { EXPORT_NOTE, IGL_NOTE, NOT_TAXABLE_ABROAD_NOTE, zeroRatedGround } from '../modules/invoice/zero-rated'
import { findLogo } from '../modules/company/logo-store'
import PDFKit from "pdfkit"
import * as fs from "fs"
import QRCode from "qrcode"
import { invoiceTaxBreakdown } from "../modules/invoice/tax-breakdown"
import { countryCode, countryLine, directorsLabel } from '../common/business-letter'
import { paymentMethodLabel } from '../modules/invoice/payment-method'

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
  /** Tier 413: invoice-level discount (§ 14 Abs. 4 Nr. 7 UStG) */
  discountPercent?: any
  discountAmount?: any
  notes?: string | null
  currency: string
  // Tier 653: what a foreign-currency invoice is in euros, and at which rate
  // (1 EUR = exchangeRate of the currency; 'ecb:YYYY-MM-DD' or 'manual')
  exchangeRate?: any
  exchangeRateSource?: string | null
  eurTotalVat?: any
  eurTotal?: any
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
  referenceInvoice?: { invoiceNumber: string; issueDate?: Date | string | null } | null
  // Tier 472: a final invoice deducts the advance paid on its Proforma
  // (advanceDeductionFor in modules/invoice/advance.ts).
  advanceDeduction?: {
    proformaNumber: string
    receivedOn: any
    gross: number
    byRate: Array<{ rate: number; net: number; vat: number }>
  } | null
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
  // Tier 653: every amount in the invoice's own currency. The function was one
  // for the whole file and wrote "€" — an invoice over 11 900 USD went out as
  // "Gesamtbetrag: € 11.900,00" (it is 10 619,31 €).
  const formatCurrency = (val: number) => formatMoney(val, invoice.currency)
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
    // Tier 418: bufferPages so every page can get its "Seite i von n" at the end.
    // Tier 693: the fonts are embedded (PDF/A) — the start font too, or
    // PDFKit puts its own Helvetica into the file before the first text
    const startFont = defaultFontFile()
    const doc = new PDFKit({ margins: { top: 50, left: 50, right: 50, bottom: 10 }, size: "A4", bufferPages: true, ...(startFont ? { font: startFont } : {}) }) as any
    registerEmbeddedFonts(doc)
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
    // Tier 728d: the template's „Logo anzeigen“ counts too (it was read
    // nowhere — the checkbox changed nothing); „Vereinfacht“ stays without
    const showLogo = template !== "simplified" && renderConfig?.showLogo !== false && company.logoPath

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
          // Tier 728b: the logo fits the room left of the company block on
          // the right (name 20 pt, address 9 pt, contacts 8 pt). It was
          // centred and drawn by its height alone — a wide logo (a word
          // mark, 400 × 120 px) ran 227 pt wide, over the company's name and
          // phone line; the 220 pt cap only entered the centring.
          const img = doc.openImage(logoPath)
          const a = (company.address || {}) as any
          const widest = (size: number, bold: boolean, lines: string[]) => {
            doc.font(fontFor(bold ? 'bold' : 'regular')).fontSize(size)
            return Math.max(0, ...lines.filter(Boolean).map((l) => doc.widthOfString(l)))
          }
          const phoneFaxLine = [company.phone ? `Tel.: ${company.phone}` : "", (company as any).fax ? `Fax: ${(company as any).fax}` : ""].filter(Boolean).join("  ·  ")
          const textW = Math.max(
            widest(20, true, [String(company.name || "")]),
            widest(9, false, [a.street, `${a.postalCode || ""} ${a.city || ""}`.trim()]),
            widest(8, false, [phoneFaxLine, company.email || "", (company as any).website || ""]),
          )
          const textLeft = rightMargin - textW - 16
          const room = Math.max(40, textLeft - leftMargin)
          const scale = Math.min(68 / img.height, 220 / img.width, room / img.width)
          const imgWidth = img.width * scale
          const imgHeight = img.height * scale
          const centred = (pageWidth - imgWidth) / 2
          const imgX = centred + imgWidth <= textLeft ? centred : leftMargin
          doc.image(logoPath, imgX, headerStartY, { width: imgWidth, height: imgHeight })
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
    // Tier 728: a country only where sender and recipient are in different
    // countries — in full and in capitals, as DIN 5008 writes it („ÖSTERREICH“).
    // A German letter to a German customer said „DE“ under both addresses.
    const custCountry = countryCode((invoice.customer?.address || {}).country)
    const ownCountry = countryCode(compAddr.country)
    const showCountries = !!custCountry && !!ownCountry && custCountry !== ownCountry
    const ownCountryLine = showCountries ? countryLine(compAddr.country) : ""

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
      if (ownCountryLine) {
        doc.text(ownCountryLine, leftMargin, cy, { width: rightBlockWidth, align: "right", lineBreak: false })
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
      if (company.phone) phoneFax.push(`Tel.: ${company.phone}`) // Tier 728: as „Fax:“ beside it
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
      if (ownCountryLine) {
        doc.text(ownCountryLine, leftMargin, cy, { lineBreak: false })
      }
      // Tier 728: the contact details — phone, fax, e-mail, website — stood
      // only in the letterhead WITH a logo; without one (every company until
      // it uploads one) they were nowhere. Top right, as in that layout.
      doc.fontSize(8).font(fontFor('regular'))
      let contactY = headerStartY + 4
      const phoneFax: string[] = []
      if (company.phone) phoneFax.push(`Tel.: ${company.phone}`)
      if ((company as any).fax) phoneFax.push(`Fax: ${(company as any).fax}`)
      for (const line of [phoneFax.join("  ·  "), company.email || "", (company as any).website || ""]) {
        if (!line) continue
        doc.text(line, leftMargin, contactY, { width: rightBlockWidth, align: "right", lineBreak: false })
        contactY += 10
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
    // Tier 731: the address field of DIN 5008 (Form B) — in the window of a
    // DL envelope (20 mm from the left, 45–90 mm from the top). The block
    // stood at the page margin, 17.6 mm from the left: with the letter at the
    // envelope's left edge the first characters of each line were behind the
    // window's edge. Writing starts 25 mm from the left; the return address
    // closes the Vermerkzone, the recipient starts in the Anschriftzone
    // (62.7 mm).
    const addrX = (25 / 25.4) * 72
    let custY = senderStartY + 8
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
    if (ownCountryLine) senderParts.push(ownCountryLine)
    doc.fontSize(5).font(fontFor('regular')).text(senderParts.join(" · "), addrX, custY, { lineBreak: false })
    custY += 10
    // Customer block — font 11pt (was 10pt; +10% per user request).
    // Note: the original "Rechnungsadresse:" label has been moved up
    // and replaced with the sender's own company name + address
    // (per the user's request). We don't repeat a "Rechnungsadresse:"
    // label down here — the sender block above acts as the
    // invoice-letterhead label.
    doc.fontSize(11).font(fontFor('regular'))
    doc.text(invoice.customer.name, addrX, custY, { lineBreak: false })
    custY += 14
    // Tier 731: the contact person below a business's name (DIN 5008) — it
    // was stored, and the reminder used it, but the invoice left it out
    const attention = String((invoice.customer as any).contact?.name || "").trim()
    if (attention && attention !== String(invoice.customer.name || "").trim() && (invoice.customer as any).type !== "individual") {
      doc.text(attention, addrX, custY, { lineBreak: false })
      custY += 14
    }
    if (custAddr.street) {
      doc.text(custAddr.street, addrX, custY, { lineBreak: false })
      custY += 14
    }
    if (custAddr.postalCode || custAddr.city) {
      doc.text(`${custAddr.postalCode || ""} ${custAddr.city || ""}`.trim(), addrX, custY, { lineBreak: false })
      custY += 14
    }
    if (showCountries) {
      doc.text(countryLine(custAddr.country), addrX, custY, { lineBreak: false })
      custY += 14
    }
    if (invoice.customer.vatId) {
      // Tier 691: "USt-IdNr." as the BZSt writes it (was "UST-IDNr." here, "USt-IDNr." in the header)
      doc.text(`USt-IdNr.: ${invoice.customer.vatId}`, addrX, custY, { lineBreak: false })
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
        case "QU": return "ANGEBOT" // Tier 610
        case "DN": return "LIEFERSCHEIN"
        case "OC": return "AUFTRAGSBESTÄTIGUNG" // Tier 614
        case "RCV": return "QUITTUNG"
        default: return "RECHNUNG"
      }
    })()
    // Tier 610: a delivery note shows what was delivered, not what it costs;
    // neither it nor a quote asks for payment.
    const docType = String((invoice as any).type || "INV")
    const hidePrices = docType === "DN"
    const noPayment = docType === "QU" || docType === "DN"
    // Tier 614: an order confirmation states the agreed terms (payment terms,
    // Skonto) but asks for no money yet — no GiroCode
    // Tier 729: paid in cash, by card or PayPal — no transfer code to scan
    const paidOtherwise = paymentMethodLabel((invoice as any).paymentMethod)
    const noGiroCode = noPayment || docType === "OC" || paidOtherwise != null
    const money = (n: number) => (hidePrices ? "" : formatCurrency(n))
    const titleOffsetY = 42  // 3 rows down
    const titleY = middleRowY + titleOffsetY
    doc.fontSize(20).font(fontFor('bold')).text(invoiceTitle, leftMargin, titleY, { width: rightBlockWidth, align: "right", lineBreak: false })
    // Tier 496: a draft is no invoice yet (not counted, still changeable) —
    // its PDF says so above the title, and as a watermark on every page below.
    const isDraft = (invoice as any).status === "draft"
    if (isDraft) {
      doc.fontSize(9).font(fontFor('bold')).fillColor("#b91c1c")
        .text(docType === "QU" ? "ENTWURF – kein gültiges Angebot" : docType === "DN" || docType === "OC" ? "ENTWURF" : "ENTWURF – keine gültige Rechnung", leftMargin, titleY - 12, { width: rightBlockWidth, align: "right", lineBreak: false })
      doc.fillColor(textColor).fontSize(20).font(fontFor('bold'))
    }
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
    // Tier 729b: the customer's references — many pay only an invoice that
    // names their order
    // A value wider than the room right of the labels (≈ 76 pt) gets a row of
    // its own below its label, across the whole block.
    const references = [
      { label: "Ihre Bestellnr.:", value: String((invoice as any).orderReference || "").trim() },
      { label: "Ihre Referenz:", value: String((invoice as any).buyerReference || "").trim() },
    ]
      .filter((r) => r.value)
      .map((r) => ({ ...r, ownRow: doc.fontSize(10).widthOfString(r.value) > 76 }))
    for (const r of references) {
      doc.text(r.label, detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow += r.ownRow ? 2 : 1
    }
    doc.text("Ausstellungsdatum:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
    detailsRow++
    // Tier 492 — the Leistungsdatum is a mandatory invoice field (§ 14 Abs. 4
    // Nr. 6 UStG), also when it equals the issue date. An invoice without a
    // recorded one (API, recurring) showed none; it now states the issue date,
    // as BT-72 in XRechnung / ZUGFeRD does. A Proforma (no supply yet) and a
    // credit note (its invoice's date applies) show a set date only.
    // Tier 493: a recorded Leistungszeitraum is stated instead, over two
    // rows ("von –" / "bis") — one row would run into the label column.
    const periodStart = (invoice as any).servicePeriodStart
    const periodEnd = (invoice as any).servicePeriodEnd
    const hasPeriod = !!(periodStart && periodEnd)
    const leistungsdatum = hasPeriod ? null : (invoice as any).deliveryDate
      ?? (["PI", "CN", "QU", "OC"].includes((invoice as any).type) ? null : invoice.issueDate)
    if (hasPeriod) {
      doc.text("Leistungszeitraum:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow += 2
    } else if (leistungsdatum) {
      doc.text(docType === "DN" ? "Lieferdatum:" : docType === "OC" ? "Liefertermin:" : "Leistungsdatum:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    if (company.vatId) {
      doc.text("USt-IdNr.:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    if (company.taxId) {
      doc.text("Steuernummer:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
    }
    // Tier 695: the invoice corrected is named by its number and its date
    // (§ 31 Abs. 5 UStDV: a specific and unambiguous reference)
    const corrected = (invoice as any).type === "CN" && (invoice as any).referenceInvoiceId ? (invoice as any).referenceInvoice : null
    if ((invoice as any).type === "CN" && (invoice as any).referenceInvoiceId) {
      doc.text("Bezug zu Rechnung:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
      detailsRow++
      if (corrected?.issueDate) {
        doc.text("Rechnung vom:", detailsLabelX, detailsY + detailsRow * 15, { width: 100, align: "right", lineBreak: false })
        detailsRow++
      }
    }

    detailsRow = 0
    if (customerNumber) {
      doc.text(customerNumber, detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
      detailsRow++
    }
    for (const r of references) {
      if (!r.ownRow) {
        doc.text(r.value, detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
        detailsRow++
        continue
      }
      // its own row: up to 230 pt wide, smaller where that is not enough
      detailsRow++
      const room = 230
      let size = 10
      while (size > 7 && doc.fontSize(size).widthOfString(r.value) > room) size -= 0.5
      doc.text(r.value, rightMargin - room, detailsY + detailsRow * 15 + (10 - size) / 2, { width: room, align: "right", lineBreak: false, ellipsis: true })
      doc.fontSize(10)
      detailsRow++
    }
    doc.text(formatDate(invoice.issueDate), detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
    detailsRow++
    if (hasPeriod) {
      doc.text(`${formatDate(periodStart)} –`, detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
      detailsRow++
      doc.text(formatDate(periodEnd), detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
      detailsRow++
    } else if (leistungsdatum) {
      doc.text(formatDate(leistungsdatum), detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
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
      if (corrected?.issueDate) {
        doc.text(formatDate(corrected.issueDate), detailsValueX, detailsY + detailsRow * 15, { width: detailsValueWidth, align: "right", lineBreak: false })
        detailsRow++
      }
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
    // Tier 418: the item table breaks across pages. It had no page break at
    // all: a row below the page's bottom margin made PDFKit start a new page
    // for each of its cells, so 25 items became a 26-page PDF and 40 items
    // 116 pages, mostly blank, with the totals on the last one. A row that
    // does not fit now starts a page with the column headers repeated, and
    // leaves room for the page number.
    const rowFits = (height: number) => y + height <= doc.page.height - 40
    const newTablePage = () => {
      doc.addPage()
      y = 50
    }

    if (isCompact) {
      // Compact table with fewer columns (Brutto column removed)
      // sku + desc are two independent columns so the SKU gets its own
      // header. SKU width 80 holds typical "ART-001" / "SMK-001"; remaining
      // 240px goes to the description.
      const compactColWidths = { sku: 80, desc: 240, qty: 80, price: 130 }
      const compactHeaderHeight = 20

      // Compact table header - no fill, just bottom border.
      // Tier 7.5: stroke uses primaryColor.
      const drawCompactHeader = () => {
        doc.strokeColor(primaryColor)
          .moveTo(leftMargin, y + compactHeaderHeight).lineTo(rightMargin, y + compactHeaderHeight).lineWidth(0.8).stroke()
        doc.fillColor(textColor)
          .fontSize(9).font(fontFor('bold'))
          .text("Artikel Nr.", leftMargin + 5, y + 6, { width: compactColWidths.sku - 10, lineBreak: false })
          .text("Beschreibung", leftMargin + compactColWidths.sku, y + 6, { width: compactColWidths.desc - 10, lineBreak: false })
          .text("Menge", leftMargin + compactColWidths.sku + compactColWidths.desc, y + 6, { width: compactColWidths.qty, align: "center", lineBreak: false })
          .text(hidePrices ? "" : "Einzelpreis", leftMargin + compactColWidths.sku + compactColWidths.desc + compactColWidths.qty, y + 6, { width: compactColWidths.price, align: "center", lineBreak: false })
        y += compactHeaderHeight
        doc.fillColor(textColor).font(fontFor('regular')).fontSize(9).lineWidth(0.3)
      }
      drawCompactHeader()
      // Center amounts in their columns
      const cQtyX = leftMargin + compactColWidths.sku + compactColWidths.desc
      const cQtyW = compactColWidths.qty
      const cPriceX = leftMargin + compactColWidths.sku + compactColWidths.desc + compactColWidths.qty
      const cPriceW = compactColWidths.price
      invoice.items.forEach((item, i) => {
        // Tier 731: as high as its description — a wrapped one ran over the
        // line below it and into the next row
        doc.font(fontFor('regular')).fontSize(9)
        const extra = doc.heightOfString(String(item.description ?? ""), { width: compactColWidths.desc - 10 }) - doc.heightOfString("X", { width: compactColWidths.desc - 10 })
        const rowHeight = 20 + Math.max(0, Math.ceil(extra))
        let firstOnPage = i === 0
        if (!rowFits(rowHeight)) {
          newTablePage()
          drawCompactHeader()
          firstOnPage = true
        }
        // Light dotted line between rows instead of fill
        if (!firstOnPage) {
          doc.moveTo(leftMargin, y).lineTo(rightMargin, y).stroke()
        }
        // SKU in its own column (centered); if no linked product, show "—"
        const sku = (item as any).product?.sku || "—"
        doc.font(fontFor('bold')).fontSize(9)
          .text(sku, leftMargin, y + 5, { width: compactColWidths.sku, align: "center", lineBreak: false })
        doc.font(fontFor('regular')).fontSize(9)
          .text(item.description, leftMargin + compactColWidths.sku, y + 5, { width: compactColWidths.desc - 10, lineBreak: false })
        doc.text(`${formatNumber(toFloat(item.quantity))} ${item.unit || ''}`, cQtyX, y + 5, { width: cQtyW, align: "center", lineBreak: false })
        doc.text(money(toFloat(item.unitPrice)), cPriceX, y + 5, { width: cPriceW, align: "center", lineBreak: false })
        y += rowHeight
      })
    } else {
      // Standard table (Brutto column removed; Netto kept as the per-line total)
      // Column widths: sku + desc + qty + price + vat + net must end at rightMargin
      // so the right edge of "Gesamt" column aligns with the totals area on the right.
      const colWidths = { sku: 70, desc: 150, qty: 55, price: 75, vat: 55, net: 90 }
      // (sum: 495; rightMargin - leftMargin = 495 → last column ends exactly at rightMargin)
      const headerHeight = 25
      const minRowHeight = 24

      // Gesamt header: right-aligned within net column → right edge = rightMargin
      const sNetX = leftMargin + colWidths.sku + colWidths.desc + colWidths.qty + colWidths.price + colWidths.vat
      const sNetW = colWidths.net
      // Table header - no fill, just bottom border.
      // Tier 7.5: stroke uses primaryColor.
      const drawHeader = () => {
        doc.strokeColor(primaryColor)
          .moveTo(leftMargin, y + headerHeight).lineTo(rightMargin, y + headerHeight).lineWidth(0.8).stroke()
        doc.fillColor(textColor)
          .fontSize(10).font(fontFor('bold'))
          .text("Artikel Nr.", leftMargin + 5, y + 8, { width: colWidths.sku - 10, lineBreak: false })
          .text("Beschreibung", leftMargin + colWidths.sku, y + 8, { width: colWidths.desc - 10, lineBreak: false })
          .text("Menge", leftMargin + colWidths.sku + colWidths.desc, y + 8, { width: colWidths.qty, align: "center", lineBreak: false })
          .text(hidePrices ? "" : "Einzelpreis", leftMargin + colWidths.sku + colWidths.desc + colWidths.qty, y + 8, { width: colWidths.price, align: "center", lineBreak: false })
          .text(hidePrices ? "" : "MwSt", leftMargin + colWidths.sku + colWidths.desc + colWidths.qty + colWidths.price, y + 8, { width: colWidths.vat, align: "center", lineBreak: false })
        doc.text(hidePrices ? "" : "Gesamt", sNetX, y + 8, { width: sNetW, align: "right", lineBreak: false })
        y += headerHeight
        doc.font(fontFor('regular')).fontSize(10).lineWidth(0.3)
      }
      drawHeader()
      // Pre-compute column positions
      const sQtyX = leftMargin + colWidths.sku + colWidths.desc
      const sQtyW = colWidths.qty
      const sPriceX = leftMargin + colWidths.sku + colWidths.desc + colWidths.qty
      const sPriceW = colWidths.price
      const sVatX = leftMargin + colWidths.sku + colWidths.desc + colWidths.qty + colWidths.price
      const sVatW = colWidths.vat
      invoice.items.forEach((item, i) => {
        // Tier 731: as high as its description — a wrapped one ran over the
        // line below it and into the next row
        doc.font(fontFor('regular')).fontSize(10)
        const extra = doc.heightOfString(String(item.description ?? ""), { width: colWidths.desc - 10 }) - doc.heightOfString("X", { width: colWidths.desc - 10 })
        const rowHeight = minRowHeight + Math.max(0, Math.ceil(extra))
        let firstOnPage = i === 0
        if (!rowFits(rowHeight)) {
          newTablePage()
          drawHeader()
          firstOnPage = true
        }
        // Light dotted line between rows
        if (!firstOnPage) {
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
        doc.text(money(toFloat(item.unitPrice)), sPriceX, y + 7, { width: sPriceW, align: "center", lineBreak: false })
        doc.text(hidePrices ? "" : formatVatRate(toFloat(item.vatRate)), sVatX, y + 7, { width: sVatW, align: "center", lineBreak: false })
        // Per-line total right edge = rightMargin, so it aligns vertically with totals below
        doc.text(money(toFloat(item.netAmount)), sNetX, y + 7, { width: sNetW, align: "right", lineBreak: false })
        y += rowHeight
      })
    }

    // Tier 413: the totals block states the discount and the VAT per rate.
    // It used to print the *undiscounted* line sum, one blended VAT figure and
    // the discounted total — 1 000,00 + 171,00 = 1 071,00 on the page — and a
    // 19 % + 7 % invoice showed neither rate's tax. § 14 Abs. 4 Nr. 7 UStG
    // wants the agreed reduction stated and the Entgelt broken down by rate,
    // Nr. 8 the rate and its tax amount.
    const breakdown = invoiceTaxBreakdown({
      total: invoice.total,
      totalVat: invoice.totalVat,
      items: invoice.items,
    })
    const lineNetSum = round2(invoice.items.reduce((sum, i) => sum + toFloat(i.netAmount), 0))
    const discount = round2(lineNetSum - breakdown.net)
    const rows: Array<{ label: string; amount: number }> = [
      { label: "Zwischensumme (Netto):", amount: lineNetSum },
    ]
    if (Math.abs(discount) >= 0.005) {
      const pct = toFloat(invoice.discountPercent)
      rows.push({
        label: pct > 0 ? `Rabatt ${pct.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %:` : "Rabatt:",
        amount: -discount,
      })
      rows.push({ label: "Nettobetrag:", amount: breakdown.net })
    }
    // Tier 480: a Kleinunternehmer's invoice lists no VAT (the § 19 note
    // below says why) — not even "USt 0 %: 0,00".
    const noVatLines = !!renderConfig?.kleineUnternehmerNote && Math.abs(toFloat(invoice.totalVat)) < 0.005
    for (const bucket of noVatLines ? [] : breakdown.byRate) {
      rows.push({
        label:
          breakdown.byRate.length > 1
            ? `USt ${formatVatRate(bucket.rate)} auf ${formatCurrency(bucket.net)}:`
            : `USt ${formatVatRate(bucket.rate)}:`,
        amount: bucket.vat,
      })
    }
    if (breakdown.byRate.length > 1) {
      rows.push({ label: "Gesamtbetrag USt:", amount: toFloat(invoice.totalVat) })
    }

    // Totals - ink-saving design: just borders and bold text, no fills
    const totalsLineHeightPre = isCompact ? 20 : 22
    const gesamtHeightPre = totalsLineHeightPre + 4
    // Tier 413: the block is 2 to 6 rows now, so it can reach the footer on a
    // long invoice. When it does not fit above the footer, it starts a page of
    // its own — the footer is drawn on the page the writing ends on, and an
    // overflowing block used to push it onto a second page by itself.
    const notesHeightPre = invoice.notes ? (isCompact ? 12 : 20) + 40 : 0
    // Tier 472: a final invoice states the advance it deducts, with its net
    // and tax per rate (§ 14 Abs. 5 Satz 2 UStG), and what is left to pay.
    const advance = invoice.advanceDeduction && invoice.advanceDeduction.gross > 0 ? invoice.advanceDeduction : null
    const advanceRows: Array<{ label: string; amount: number }> = []
    if (advance) {
      const on = advance.receivedOn ? ` vom ${formatDate(advance.receivedOn)}` : ""
      advanceRows.push({ label: `abzgl. Anzahlung ${advance.proformaNumber}${on}:`, amount: -advance.gross })
      for (const b of advance.byRate) {
        advanceRows.push({
          label: `darin netto ${formatCurrency(b.net)}, USt ${formatVatRate(b.rate)}:`,
          amount: -b.vat,
        })
      }
    }
    const advanceHeightPre = advance ? advanceRows.length * totalsLineHeightPre + 5 + gesamtHeightPre : 0
    const blockHeight = 5 + rows.length * totalsLineHeightPre + gesamtHeightPre + advanceHeightPre + notesHeightPre
    if (y + (isCompact ? 15 : 20) + blockHeight > doc.page.height - 74 - 10) {
      doc.addPage()
      y = 50
    }
    const totalsY = y + (isCompact ? 15 : 20)
    const totalsLineY = totalsY
    // Anchor amounts to the SAME right edge as the table's Gesamt column
    const totalsLabelX = leftMargin + (isCompact ? 180 : 220)
    const totalsAmountX = rightMargin - 100  // right-aligned width = 100, ends at rightMargin
    const totalsAmountWidth = 100
    // Tier 7.5: total divider in primaryColor
    if (!hidePrices) doc.strokeColor(primaryColor)
      .moveTo(totalsAmountX, totalsLineY).lineTo(rightMargin, totalsLineY).lineWidth(0.8).stroke()

    const totalsFontSize = isCompact ? 10 : 11
    const totalsLineHeight = totalsLineHeightPre

    doc.fillColor(textColor).font(fontFor('regular')).fontSize(totalsFontSize).lineWidth(0.3)
    if (!hidePrices) rows.forEach((row, i) => {
      const rowY = totalsY + 5 + i * totalsLineHeight
      doc.text(row.label, totalsLabelX, rowY, { lineBreak: false })
      doc.text(formatCurrency(row.amount), totalsAmountX, rowY, { width: totalsAmountWidth, align: "right", lineBreak: false })
    })

    // Gesamtbetrag with bold border box (no fill, just outline)
    const gesamtY = totalsY + 5 + rows.length * totalsLineHeight
    const gesamtHeight = gesamtHeightPre
    const gesamtBoxX = totalsLabelX - 5
    // Tier 645: 5 pt of room on the right as on the left — the box ended where
    // the amount ends, and the last digit stood on its border.
    const gesamtBoxWidth = rightMargin - gesamtBoxX + 5
    doc.lineWidth(1.0)
    if (!hidePrices) doc.rect(gesamtBoxX, gesamtY, gesamtBoxWidth, gesamtHeight).stroke()
    doc.fillColor(textColor).font(fontFor('bold')).fontSize(totalsFontSize + 2)
    if (!hidePrices) doc.text("Gesamtbetrag:", gesamtBoxX + 5, gesamtY + 6, { lineBreak: false })
    if (!hidePrices) doc.text(formatCurrency(toFloat(invoice.total)), totalsAmountX, gesamtY + 6, { width: totalsAmountWidth, align: "right", lineBreak: false })

    let blockEndY = hidePrices ? y : gesamtY + gesamtHeight
    if (advance) {
      doc.font(fontFor('regular')).fontSize(totalsFontSize - 1).lineWidth(0.3)
      advanceRows.forEach((row, i) => {
        const rowY = blockEndY + 5 + i * totalsLineHeight
        doc.text(row.label, totalsLabelX - 60, rowY, { lineBreak: false })
        doc.text(formatCurrency(row.amount), totalsAmountX, rowY, { width: totalsAmountWidth, align: "right", lineBreak: false })
      })
      const zahlY = blockEndY + 5 + advanceRows.length * totalsLineHeight
      doc.lineWidth(1.0)
      doc.rect(gesamtBoxX, zahlY, gesamtBoxWidth, gesamtHeight).stroke()
      doc.font(fontFor('bold')).fontSize(totalsFontSize + 2)
      doc.text("Zahlbetrag:", gesamtBoxX + 5, zahlY + 6, { lineBreak: false })
      doc.text(formatCurrency(round2(toFloat(invoice.total) - advance.gross)), totalsAmountX, zahlY + 6, { width: totalsAmountWidth, align: "right", lineBreak: false })
      blockEndY = zahlY + gesamtHeight
    }

    // Tier 653: an invoice in a foreign currency states its VAT in euros
    // (Art. 230 MwStSystRL) and the rate it was converted at.
    const euroNote = hidePrices || noPayment || docType === "OC" ? null : euroNoteOf(invoice)
    if (euroNote) {
      const noteWidth = rightMargin - leftMargin
      doc.font(fontFor('regular')).fontSize(8).fillColor(textColor)
      doc.text(euroNote, leftMargin, blockEndY + 6, { width: noteWidth, align: "right" })
      blockEndY += 6 + doc.heightOfString(euroNote, { width: noteWidth, align: "right" })
    }

    // Notes
    if (invoice.notes) {
      const notesY = blockEndY + (isCompact ? 12 : 20)
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
    if (docType === "QU" && (invoice as any).dueDate) {
      // Tier 610: a quote says how long it holds
      doc.font(fontFor('regular')).fontSize(8).fillColor(textColor)
        .text(`Dieses Angebot ist gültig bis ${formatDate((invoice as any).dueDate)}.`, leftMargin, footerY - 42, { lineBreak: false })
    }
    // Tier 660: the payment line says when THIS invoice is due. It was the
    // template's sentence — "Zahlbar binnen 14 Tagen ohne Abzug." — on every
    // invoice: a customer with 30 days' terms got an invoice due on 11.11.
    // that said 14 days, the due date itself stood nowhere on the page, and
    // with Skonto a second line named another date. A credit note asked to
    // be paid.
    const hasSkonto = (invoice as any).skontoPercent != null && (invoice as any).skontoDays != null
    const termsLine = noPayment ? null : paymentTermsLine(invoice, renderConfig?.paymentTermsText, docType, hasSkonto)
    // Tier 729: how the customer pays, when not by transfer
    const paymentLine = noPayment || !paidOtherwise ? termsLine : [termsLine, `Zahlungsart: ${paidOtherwise}.`].filter(Boolean).join(" ")
    if (paymentLine) {
      doc.font(fontFor('regular')).fontSize(8).fillColor(textColor)
        .text(paymentLine, leftMargin, footerY - 42, { lineBreak: false })
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
    if (skontoPercent != null && skontoDays != null && !noPayment) {
      const issue = new Date((invoice as any).issueDate)
      const withDue = new Date(issue)
      withDue.setDate(withDue.getDate() + Number(skontoDays))
      const fmt = (d: Date) =>
        d.toLocaleDateString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        })
      const pct = Number(skontoPercent).toFixed(skontoPercent % 1 === 0 ? 0 : 2)
      // Tier 614: an order confirmation states the term, not dates — the
      // period starts with the invoice
      const skontoText = docType === "OC"
        ? `${pct}% Skonto bei Zahlung binnen ${Number(skontoDays)} Tagen nach Rechnungsdatum.`
        : `Zahlbar bis ${fmt(withDue)} mit ${pct}% Skonto, bis ${fmt((invoice as any).dueDate)} ohne Abzug.`
      doc
        .font(fontFor('bold'))
        .fontSize(8)
        .fillColor(primaryColor)
        .text(
          skontoText,
          leftMargin,
          paymentLine ? footerY - 28 : footerY - 42,
          { lineBreak: false },
        )
    }
    // Tier 688: the ground of a zero-rated sale (invoice/zero-rated.ts, the
    // UStVA's rule) decides the note. igL and § 13b keep their template texts;
    // an export and a service abroad got none / the § 13b one before. A
    // Kleinunternehmer's invoice has the § 19 note below instead.
    const zeroRatedLine = (invoice.items || []).some((it: any) => Math.abs(toFloat(it.vatRate)) < 0.00005)
    const groundNote = (() => {
      if (renderConfig?.kleineUnternehmerNote) return null
      const flagged = (invoice as any).reverseCharge || (invoice as any).euTransaction
      if (!zeroRatedLine && !flagged) return null
      const customer = (invoice as any).customer
      switch (zeroRatedGround(invoice as any, customer?.address?.country, customer?.vatId)) {
        case 'igl': return renderConfig?.euTransactionNote || IGL_NOTE
        case 'reverseChargeEu':
        case 'reverseChargeDomestic': return renderConfig?.reverseChargeNote || null
        case 'notTaxableAbroad': return NOT_TAXABLE_ABROAD_NOTE
        case 'export': return EXPORT_NOTE
        default: return null
      }
    })()
    if (groundNote) {
      doc.font(fontFor('bold')).fontSize(8).fillColor(primaryColor)
        .text(groundNote, leftMargin, footerY - 28, { lineBreak: false })
    }
    // Tier 480: the note is resolved per company (resolveConfig leaves it
    // only for a Kleinunternehmer) and shown on a document without VAT. The
    // test compared a Prisma Decimal with '0' / 0 (never equal) and, by
    // operator precedence, would have put "§ 19" on any 0 % invoice.
    if (renderConfig?.kleineUnternehmerNote && Math.abs(toFloat(invoice.totalVat)) < 0.005) {
      doc.font(fontFor('bold')).fontSize(8).fillColor(primaryColor)
        .text(renderConfig!.kleineUnternehmerNote!, leftMargin, footerY - 14, { lineBreak: false })
    }

    if (company.bankInfo && typeof company.bankInfo === 'object') {
      // Tier 695: a credit note asks for no payment — the account is the
      // company's, not an instruction to pay
      doc.text(docType === "CN" ? "Bankverbindung:" : "Zahlungsinformationen:", leftMargin, footerY, { lineBreak: false })
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
    // Tier 728: the lines of the block, then where it starts — with the full
    // name and the seat it can be taller than the four lines it was laid out
    // for; it moves up rather than past the page's foot (which would start a
    // page of its own).
    const impressum: Array<{ text: string; step: number }> = []
    // the full name as registered („… Lederwaren GmbH“) when the letterhead
    // carries a shorter one — § 14 Abs. 4 Nr. 1 UStG asks for the full name,
    // § 35a GmbHG / § 37a HGB for the legal form. It was entered in the
    // settings and printed nowhere (only the e-invoices had it).
    const legal = String((company as any).legalName || "").trim()
    if (legal && legal !== String(company.name || "").trim()) impressum.push({ text: legal, step: 10 })
    // …a registered company's seat (§ 35a GmbHG, § 125a / § 177a HGB, § 80
    // AktG) — the city of its address unless „Sonstige Angaben“ say it
    if (reg && compAddr.city && !/\bsitz\b/i.test(String(other || ""))) {
      impressum.push({ text: `Sitz der Gesellschaft: ${compAddr.city}`, step: 10 })
    }
    if (reg) impressum.push({ text: `Handelsregister: ${reg}`, step: 10 })
    if (md) impressum.push({ text: `${directorsLabel(company as any)} ${md}`, step: 10 })
    // „Sonstige Angaben“ line by line, each at its own fixed Y: PDFKit's
    // `lineBreak: true` with `align: "right"` drew the user's lines on top
    // of each other.
    if (other) {
      for (const line of String(other).split(/\r?\n/).filter((l: string) => l.length > 0)) impressum.push({ text: line, step: 9 })
    }
    const impressumHeight = impressum.reduce((h, l) => h + l.step, 0)
    // the last line has to end above the page number band (page height − 22)
    let rightFooterY = Math.min(footerY, doc.page.height - 24 - impressumHeight)
    for (const line of impressum) {
      doc.text(line.text, leftMargin, rightFooterY, { width: rightFooterWidth, align: "right", lineBreak: false })
      rightFooterY += line.step
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
    if (qrBuffer && !noGiroCode) {
      const qrSize = 56
      // Tier 728: left of the page number („Seite 1 von 1“, centred), which
      // it overlapped at x = 240 — the bank lines end at about 175 pt
      const qrX = 196
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
    // Tier 418: "Seite i von n" on every page — the one label written here
    // used to be "Seite 1" whatever page it landed on.
    const range = doc.bufferedPageRange()
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i)
      // Tier 731: fold marks (105 / 210 mm, DIN 5008 Form B) and the hole
      // mark (148.5 mm) on the first sheet, at the left edge — for folding
      // into a DL window envelope and for the punch
      if (i === range.start) {
        const mmPt = (v: number) => (v / 25.4) * 72
        doc.save().lineWidth(0.4).strokeColor("#9ca3af")
        for (const [atMm, lenMm] of [[105, 5], [148.5, 8], [210, 5]] as const) {
          doc.moveTo(mmPt(4), mmPt(atMm)).lineTo(mmPt(4 + lenMm), mmPt(atMm)).stroke()
        }
        doc.restore()
      }
      if (isDraft) {
        const cx = doc.page.width / 2
        const cy = doc.page.height / 2
        doc.save()
        doc.rotate(-35, { origin: [cx, cy] })
        doc.font(fontFor('bold')).fontSize(110).fillColor("#b91c1c").opacity(0.12)
        doc.text("ENTWURF", 0, cy - 55, { width: doc.page.width, align: "center", lineBreak: false })
        doc.restore()
        doc.opacity(1)
      }
      doc.font(fontFor('regular')).fontSize(8).fillColor(textColor)
      // Tier 731: a following sheet names its document and customer above
      // the table — page 2 said only „Seite 2 von 2“, a loose sheet belonged
      // to no invoice
      if (i > range.start) {
        const docName = invoiceTitle.charAt(0) + invoiceTitle.slice(1).toLowerCase()
        doc.text(
          `${docName} ${invoice.invoiceNumber} · ${invoice.customer?.name ?? ""} · ${formatDate(invoice.issueDate)}`,
          leftMargin,
          30,
          { width: pageWidth - leftMargin * 2, lineBreak: false, ellipsis: true },
        )
      }
      doc.text(
        `Seite ${i - range.start + 1} von ${range.count}`,
        leftMargin,
        doc.page.height - 22,
        { width: pageWidth - leftMargin * 2, align: "center", lineBreak: false }
      )
    }

    doc.end()
  })
}

function resolveLogoPath(logoPath: string): string | null {
  // Tier 544: a logo is a file in frontend/public/images/ — nothing else.
  // `Company.logoPath` can be set through PUT /companies/:id, and this used
  // an absolute path as it came (and tried the value relative to the working
  // directory): measured, logoPath "/tmp/x.png" put that file into the
  // company's invoice PDFs — any image the server can read, e.g. another
  // tenant's uploaded receipt scan. Only the base name is used now; the older
  // 'images/<name>' form resolves to the same file.
  //
  // Anchored to the project root via __dirname (this file lives at
  // backend/src/invoices/), not process.cwd().
  // Tier 560: in the storage volume, or (older uploads) in the old directory.
  return findLogo(logoPath)
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

// German currency format: € 1.234,56 (with space after € sign); another
// currency by its code, after the amount: 1.234,56 USD (Tier 653).
export function formatMoney(val: number, currency?: string | null): string {
  const amount = val.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const code = String(currency || "EUR").toUpperCase()
  // Tier 726: the amount first, as a German invoice writes it — „1.071,00 €“
  // (it was „€ 1.071,00“; the pages write it so since Tier 704)
  return amount + "\u00A0" + (code === "EUR" ? "€" : code)
}

/**
 * Tier 660 — the sentence that says when an invoice is to be paid.
 *
 *   an invoice            "Zahlbar bis zum 11.11.2026 ohne Abzug."  (its own due date)
 *   due on its own date   "Zahlbar sofort ohne Abzug."
 *   with Skonto           nothing — the Skonto line names both dates
 *   order confirmation    "Zahlbar binnen 30 Tagen nach Rechnungsdatum ohne Abzug."
 *   credit note           nothing
 *
 * A text of the company's own (the template's "Zahlungsbedingungen") is kept:
 * {dueDate} and {days} in it are filled in, and where it names no due date,
 * "Fällig am …" follows it. The stock sentence every template was created
 * with ("Zahlbar binnen 14 Tagen ohne Abzug.") counts as none.
 */
export function paymentTermsLine(
  invoice: { type?: string | null; issueDate?: any; dueDate?: any },
  templateText: string | null | undefined,
  docType: string,
  hasSkonto: boolean,
): string | null {
  if (docType === "CN" || invoice.type === "CN") return null
  const custom = (templateText || "").trim()
  // (the presets' sentence — the old one with its 14 days, the new one with
  // its {dueDate} — is the program's, not the company's)
  const preset = /^Zahlbar (?:(?:binnen|innerhalb von) \d+ Tagen|bis zum \{dueDate\}) ohne Abzug\.?$/
  const own = custom && !preset.test(custom) ? custom : ""
  const due = invoice.dueDate ? new Date(invoice.dueDate) : null
  const issue = invoice.issueDate ? new Date(invoice.issueDate) : null
  const days = due && issue ? Math.round((due.getTime() - issue.getTime()) / 86_400_000) : null
  const fill = (t: string) => t.replace(/\{dueDate\}/g, due ? formatDate(due) : "").replace(/\{days\}/g, days != null ? String(Math.max(days, 0)) : "")
  if (docType === "OC") {
    // the period starts with the invoice — a term, not a date
    if (own) return fill(own)
    if (days == null) return null
    return days > 0 ? `Zahlbar binnen ${days} Tagen nach Rechnungsdatum ohne Abzug.` : "Zahlbar sofort nach Rechnungserhalt ohne Abzug."
  }
  if (!due) return own ? fill(own) : null
  if (own) return /\{dueDate\}/.test(own) || hasSkonto ? fill(own) : `${fill(own)} Fällig am ${formatDate(due)}.`
  if (hasSkonto) return null
  return days != null && days <= 0 ? "Zahlbar sofort ohne Abzug." : `Zahlbar bis zum ${formatDate(due)} ohne Abzug.`
}

// Tier 653: "Umsatzsteuer in Euro: 1.695,52 € · Gesamtbetrag in Euro:
// 10.619,31 €" and, on a second line, "Umrechnungskurs: 1 EUR = 1,1206 USD
// (EZB-Referenzkurs vom 09.10.2026)" — null
// for an EUR invoice and for one without a rate.
export function euroNoteOf(invoice: {
  currency?: string | null
  exchangeRate?: any
  exchangeRateSource?: string | null
  eurTotalVat?: any
  eurTotal?: any
}): string | null {
  const code = String(invoice.currency || "EUR").toUpperCase()
  const rate = Number(invoice.exchangeRate)
  if (code === "EUR" || !(rate > 0) || invoice.eurTotal == null) return null
  const source = String(invoice.exchangeRateSource || "")
  const origin = source.startsWith("ecb:")
    ? ` (EZB-Referenzkurs vom ${formatDate(source.slice(4))})`
    : ""
  const rateText = rate.toLocaleString("de-DE", { minimumFractionDigits: 4, maximumFractionDigits: 6 })
  return (
    `Umsatzsteuer in Euro: ${formatMoney(toFloat(invoice.eurTotalVat ?? 0), "EUR")} · ` +
    `Gesamtbetrag in Euro: ${formatMoney(toFloat(invoice.eurTotal), "EUR")}\n` +
    `Umrechnungskurs: 1 EUR = ${rateText}\u00A0${code}${origin}`
  )
}

function formatVatRate(rate: number): string {
  // Tier 413: any rate, not just today's two. A 16 % or 5 % line (2020) or a
  // 10,7 % flat rate printed "0%" — the rate a § 14 Abs. 4 Nr. 8 invoice must
  // state, stated wrongly.
  const pct = rate * 100
  return `${pct.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} %`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
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
  // Tier 653: a GiroCode is a SEPA credit transfer and knows euros only — an
  // invoice over 11 900 USD carried a code that paid 11 900 EUR.
  if (String(invoice.currency || 'EUR').toUpperCase() !== 'EUR') return null
  const iban = (bankInfo.iban || '').replace(/\s/g, '').toUpperCase()
  if (!iban || !/^[A-Z]{2}\d{2}[A-Z0-9]{12,30}$/.test(iban)) return null

  // Format amount per spec: 2 decimals, dot decimal
  // separator, NO thousands separator. Total may be a
  // string (Decimal from Prisma) or number.
  // Tier 472: a final invoice asks only for what the advance left open —
  // nothing at all when the advance covered it.
  const totalNum = round2(toFloat(invoice.total as any) - (invoice.advanceDeduction?.gross ?? 0))
  if (invoice.advanceDeduction && totalNum <= 0) return null
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

// Tier 728b: shared with the reminder and the statement
export { countryCode, countryLine } from '../common/business-letter'
