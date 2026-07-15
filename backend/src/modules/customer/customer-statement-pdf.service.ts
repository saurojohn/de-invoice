/**
 * customer-statement-pdf.service.ts — Tier 20
 *
 * Kontoauszug (customer statement) PDF generator.
 *
 * Layout: A4, monochrome, ink-saving (matches the rest of
 * the de-invoice PDF family — see invoice-pdf, voucher-pdf,
 * mahnung-pdf).
 *
 * Structure:
 *   ┌─────────────────────────────────────────┐
 *   │ SH Leder GmbH · Otto-Hahn-Str. 24 · ... │  ← letterhead (5pt)
 *   │                                         │
 *   │ Kontoauszug / Customer Statement        │  ← title 16pt
 *   │                                         │
 *   │ Kunde:    Müller GmbH                   │
 *   │ Kundennr: K-00023                       │
 *   │ Zeitraum: 01.01.2026 – 30.06.2026       │
 *   │ Saldostichtag: 30.06.2026               │
 *   │                                         │
 *   │ Anfangsbestand:           € 1.234,56    │  ← box
 *   │                                         │
 *   │ Datum  Buchungstext  Beleg  Soll/Haben  │
 *   │ ...    Rechnung      RG-1  € 119,00     │  ← table rows
 *   │ ...    Zahlung       BEL-1 €-119,00     │
 *   │ ...                                   │
 *   │                                         │
 *   │ Endsaldo:                € 1.234,56     │  ← bold
 *   │                                         │
 *   │ Fuβtext / small print                   │  ← 7pt
 *   └─────────────────────────────────────────┘
 *
 * Why separate from customer-statement.service.ts:
 *   - Keeps the data computation pure (no I/O)
 *   - Lazy-imported by the controller so PDF deps
 *     (pdfkit ~600KB) only load on demand.
 */
import PDFDocument from 'pdfkit'
import type { CustomerStatement } from './customer-statement.service'

const PAGE_MARGIN = 50
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2

// Standard German formatting: 1.234,56
function fmtEur(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const fixed = abs.toFixed(2)
  const [intPart, fracPart] = fixed.split('.')
  // Insert thousands separator dots
  const intWithDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sign}€ ${intWithDots},${fracPart}`
}

function fmtDateDE(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${day}.${month}.${date.getUTCFullYear()}`
}

function fmtDateShort(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${day}.${month}.` // dd.mm. — year only on first row
}

/**
 * Build the address block from the JSON address object.
 * Handles German-style multi-line address (street, postalCode, city).
 */
function renderAddress(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  address: Record<string, any>,
  name: string,
) {
  doc.font('Helvetica').fontSize(10).fillColor('black')
  doc.text(name, x, y)
  let cursorY = doc.y + 2

  doc.font('Helvetica').fontSize(9)
  if (address?.street) {
    doc.text(address.street, x, cursorY)
    cursorY = doc.y + 1
  }
  const plz = address?.postalCode || ''
  const city = address?.city || ''
  if (plz || city) {
    doc.text(`${plz} ${city}`.trim(), x, cursorY)
    cursorY = doc.y + 1
  }
  if (address?.country && address.country !== 'DE') {
    doc.text(address.country, x, cursorY)
    cursorY = doc.y + 1
  }
  return cursorY
}

/**
 * Generate the PDF bytes (Buffer).
 *
 * Single-page when the customer has few lines (<= 35),
 * multi-page with page-break-aware header repeat otherwise.
 */
export async function generateStatementPdf(
  data: CustomerStatement,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: PAGE_MARGIN,
        bottom: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      info: {
        Title: `Kontoauszug ${data.customer.customerNumber || data.customer.name}`,
        Author: 'SH Leder GmbH',
        Subject: 'Kontoauszug',
        CreationDate: new Date(data.generatedAt),
      },
    })

    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // ── Letterhead (5pt, single line, ink-saving) ─────
    doc.font('Helvetica').fontSize(5).fillColor('black')
    doc.text(
      'SH Leder GmbH · Otto-Hahn-Str. 24 · 63303 Dreieich · Deutschland',
      PAGE_MARGIN,
      PAGE_MARGIN - 12,
      { width: CONTENT_WIDTH, align: 'left' },
    )

    // ── Title ────────────────────────────────────────
    let y = PAGE_MARGIN + 8
    doc.font('Helvetica-Bold').fontSize(16)
    doc.text('Kontoauszug', PAGE_MARGIN, y)
    y = doc.y + 4

    doc.font('Helvetica').fontSize(8).fillColor('#444444')
    doc.text(
      'Customer Statement — ' +
        `Zeitraum ${fmtDateDE(data.period.from)} – ${fmtDateDE(data.period.to)}`,
      PAGE_MARGIN,
      y,
    )
    y = doc.y + 12

    // ── Customer block ───────────────────────────────
    doc.fillColor('black')
    doc.font('Helvetica-Bold').fontSize(9)
    doc.text('Kunde', PAGE_MARGIN, y)
    doc.font('Helvetica').fontSize(10)
    doc.text(
      data.customer.name + (data.customer.vatId ? `  ·  USt-ID ${data.customer.vatId}` : ''),
      PAGE_MARGIN + 50,
      y,
    )
    y = doc.y + 2

    if (data.customer.customerNumber) {
      doc.font('Helvetica-Bold').fontSize(9)
      doc.text('Kundennr.', PAGE_MARGIN, y)
      doc.font('Helvetica').fontSize(10)
      doc.text(data.customer.customerNumber, PAGE_MARGIN + 50, y)
      y = doc.y + 2
    }

    doc.font('Helvetica-Bold').fontSize(9)
    doc.text('Saldostichtag', PAGE_MARGIN, y)
    doc.font('Helvetica').fontSize(10)
    doc.text(fmtDateDE(data.period.to), PAGE_MARGIN + 50, y)
    y = doc.y + 14

    // ── Address block (right column) ────────────────
    // Render customer address in the top-right corner.
    renderAddress(
      doc,
      PAGE_MARGIN + CONTENT_WIDTH - 200,
      PAGE_MARGIN + 8,
      data.customer.address,
      data.customer.name,
    )

    // ── Opening balance box ──────────────────────────
    doc.font('Helvetica').fontSize(10)
    doc.text('Anfangsbestand zum ' + fmtDateDE(data.period.from),
      PAGE_MARGIN, y)
    doc.font('Helvetica-Bold')
    const openingText = fmtEur(data.openingBalance)
    doc.text(openingText, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH,
      align: 'right',
    })
    y = doc.y + 4

    // Horizontal rule
    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).stroke()
    y = doc.y + 6

    // ── Line items table ─────────────────────────────
    const COL_DATE_X = PAGE_MARGIN
    const COL_DESC_X = PAGE_MARGIN + 60
    const COL_REF_X = PAGE_MARGIN + 240
    const COL_AMOUNT_X = PAGE_MARGIN + 340
    const COL_BAL_X = PAGE_MARGIN + CONTENT_WIDTH - 80

    // Header row
    doc.font('Helvetica-Bold').fontSize(8)
    doc.text('Datum', COL_DATE_X, y)
    doc.text('Buchungstext', COL_DESC_X, y)
    doc.text('Beleg', COL_REF_X, y)
    doc.text('Betrag', COL_AMOUNT_X, y, { width: 80, align: 'right' })
    doc.text('Saldo', COL_BAL_X, y, { width: 80, align: 'right' })
    y = doc.y + 2
    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).stroke()
    y = doc.y + 4

    doc.font('Helvetica').fontSize(9)

    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i]
      const rowHeight = 14

      // Page break check: leave 80pt footer space.
      if (y + rowHeight > PAGE_HEIGHT - PAGE_MARGIN - 80) {
        doc.addPage()
        y = PAGE_MARGIN
        // Repeat table header
        doc.font('Helvetica-Bold').fontSize(8)
        doc.text('Datum', COL_DATE_X, y)
        doc.text('Buchungstext', COL_DESC_X, y)
        doc.text('Beleg', COL_REF_X, y)
        doc.text('Betrag', COL_AMOUNT_X, y, { width: 80, align: 'right' })
        doc.text('Saldo', COL_BAL_X, y, { width: 80, align: 'right' })
        y = doc.y + 2
        doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).stroke()
        y = doc.y + 4
        doc.font('Helvetica').fontSize(9)
      }

      // Date
      doc.text(fmtDateShort(line.date), COL_DATE_X, y)

      // Description (type icon + German label)
      const icon =
        line.type === 'invoice' ? 'R ' :
        line.type === 'credit' ? 'G ' : 'Z '
      doc.text(icon + line.description, COL_DESC_X, y, { width: 175 })

      // Reference
      doc.text(line.reference, COL_REF_X, y, { width: 95 })

      // Amount (right-aligned)
      doc.text(fmtEur(line.amount), COL_AMOUNT_X, y, {
        width: 80,
        align: 'right',
      })

      // Running balance
      doc.text(fmtEur(line.balance), COL_BAL_X, y, {
        width: 80,
        align: 'right',
      })

      y = doc.y + 4
    }

    // Empty state — no lines in this period
    if (data.lines.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(9)
      doc.text(
        'Keine Bewegungen im gewählten Zeitraum.',
        PAGE_MARGIN,
        y + 10,
      )
      y = doc.y + 20
    }

    // ── Totals + closing balance ─────────────────────
    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).stroke()
    y = doc.y + 4

    doc.font('Helvetica').fontSize(9)
    doc.text(`Summe Rechnungen: ${data.totals.invoicesCount}`,
      COL_DESC_X, y)
    doc.text(fmtEur(data.totals.invoicesAmount), COL_AMOUNT_X, y, {
      width: 80, align: 'right',
    })
    y = doc.y + 4

    doc.text(`Summe Gutschriften: ${data.totals.creditsCount}`,
      COL_DESC_X, y)
    doc.text(fmtEur(data.totals.creditsAmount), COL_AMOUNT_X, y, {
      width: 80, align: 'right',
    })
    y = doc.y + 4

    doc.text(`Summe Zahlungen: ${data.totals.paymentsCount}`,
      COL_DESC_X, y)
    doc.text(fmtEur(data.totals.paymentsAmount), COL_AMOUNT_X, y, {
      width: 80, align: 'right',
    })
    y = doc.y + 4

    // Tier 56: Skonto taken in the period. Only
    // render when > 0 (a customer with no Skonto
    // shouldn't see a zero line on the statement).
    // Single line, same visual weight as the
    // count + sum rows above.
    const skontoTaken = Number(data.totals.skontoTakenAmount ?? 0)
    if (skontoTaken > 0.005) {
      doc.text(
        `Summe Skonto (in Anspruch genommen): 1`,
        COL_DESC_X, y,
      )
      doc.text(fmtEur(skontoTaken), COL_AMOUNT_X, y, {
        width: 80, align: 'right',
      })
      y = doc.y + 4
    }
    y = doc.y + 4

    doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).stroke()
    y = doc.y + 4

    doc.font('Helvetica-Bold').fontSize(11)
    doc.text('Endsaldo zum ' + fmtDateDE(data.period.to), COL_DATE_X, y)
    doc.text(fmtEur(data.closingBalance), COL_BAL_X, y, {
      width: 80, align: 'right',
    })
    y = doc.y + 16

    // Negative balance (customer overpaid) — show as credit
    if (data.closingBalance < 0) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#444444')
      doc.text(
        'Hinweis: Der Saldo ist negativ — Sie haben mehr gezahlt als die offenen Rechnungen ausmachen. ' +
        'Wir erstatten den Betrag oder verrechnen ihn mit der nächsten Rechnung.',
        PAGE_MARGIN, y, { width: CONTENT_WIDTH },
      )
      y = doc.y + 8
    }

    // Tier 56: Ratenplan schedule section. Only
    // render when the customer has at least one
    // active Ratenplan. Each plan shows the next
    // 3 Raten (or fewer if <3 left). Sorted by
    // openAmount desc — biggest Ratenplan first.
    const rps = data.ratenplanSchedule ?? []
    if (rps.length > 0) {
      // Check page break — the Ratenplan section
      // can be tall (up to 4 lines per plan). If
      // we're within 80pt of the bottom margin, page
      // break.
      if (y + 80 > PAGE_HEIGHT - PAGE_MARGIN) {
        doc.addPage()
        y = PAGE_MARGIN
      }
      y += 4
      doc.font('Helvetica-Bold').fontSize(10)
      doc.text('Offene Ratenpläne (nächste Fälligkeiten)', PAGE_MARGIN, y)
      y = doc.y + 6
      for (const plan of rps) {
        // Plan header
        if (y + 30 > PAGE_HEIGHT - PAGE_MARGIN) {
          doc.addPage()
          y = PAGE_MARGIN
        }
        doc.font('Helvetica-Bold').fontSize(9)
        doc.text(
          `Rechnung ${plan.invoiceNumber} — offen: ${fmtEur(plan.openAmount)}`,
          PAGE_MARGIN, y,
        )
        y = doc.y + 4
        // Upcoming Raten
        doc.font('Helvetica').fontSize(8)
        for (const r of plan.upcoming) {
          if (y + 12 > PAGE_HEIGHT - PAGE_MARGIN) {
            doc.addPage()
            y = PAGE_MARGIN
          }
          // Status badge in light text
          const statusLabel =
            r.status === 'overdue'
              ? 'ÜBERFÄLLIG'
              : r.status === 'partial'
              ? 'TEIL'
              : r.status === 'paid'
              ? 'BEZAHLT'
              : r.status === 'cancelled'
              ? 'STORNIERT'
              : 'OFFEN'
          doc.text(
            `  · Rate ${r.sequenceNumber} fällig ${fmtDateDE(r.dueDate)} — ${fmtEur(r.amount)} [${statusLabel}]`,
            PAGE_MARGIN, y,
            { width: CONTENT_WIDTH },
          )
          y = doc.y + 4
        }
        y += 4
      }
    }

    // ── Footer ───────────────────────────────────────
    doc.fillColor('black')
    doc.font('Helvetica').fontSize(7)
    const footerY = PAGE_HEIGHT - PAGE_MARGIN + 8
    doc.text(
      `Erstellt am ${fmtDateDE(data.generatedAt)} · ` +
      `SH Leder GmbH · Steuer-Nr. 044 243 16529 · USt-ID DE308630106 · ` +
      `Bank Sparkasse Dreieich · IBAN DE32 4455 6667 88 543 3 3`,
      PAGE_MARGIN,
      footerY,
      { width: CONTENT_WIDTH, align: 'left' },
    )

    doc.end()
  })
}