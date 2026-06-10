/**
 * Buchungsbeleg (Voucher) PDF generator.
 *
 * A Voucher in this app is a GoBD-compliant double-entry
 * posting — the Beleg a Berater hands the tax auditor.
 * The PDF is what they actually file: a single page with
 * the Belegnummer, the posting lines (Konto / Soll /
 * Haben), and the audit-trail references (recon id,
 * invoice number, source statement).
 *
 * PDFKit layout (A4, no logo by default — Belegs are
 * textual, not branded):
 *   ┌────────────────────────────────────────┐
 *   │  BUCHUNGSBELEG                         │
 *   │  Belegnummer: BK-2026-0001             │
 *   │  Belegdatum:  02.06.2026               │
 *   │  Status:      Gebucht                  │
 *   │  Buchungsart: Bankabgleich             │
 *   │  Beschreibung: Zahlungseingang Kunde    │
 *   │                                        │
 *   │  ┌──┬──────────┬────────┬────────┐     │
 *   │  │Ko│Name      │Soll    │Haben   │     │
 *   │  ├──┼──────────┼────────┼────────┤     │
 *   │  │… │…         │200,00  │        │     │
 *   │  │… │…         │        │200,00  │     │
 *   │  └──┴──────────┴────────┴────────┘     │
 *   │  Summe: 200,00 200,00  ✓ balanced    │
 *   │                                        │
 *   │  Audit-Trail:                          │
 *   │   • Rechnung: INV-2026-0001            │
 *   │   • Bank-Transaktion: 02.06.2026 +200  │
 *   │   • Quelldatei: sample.mt940 (MT940)  │
 *   │                                        │
 *   │   Seite 1          Unveränderlich     │
 *   │                    (§146 AO)           │
 *   └────────────────────────────────────────┘
 */

import PDFDocument from "pdfkit"

interface VoucherLineForPdf {
  accountNumber: string
  accountName: string
  description: string | null
  debit: string | number
  credit: string | number
}

interface VoucherPdfInput {
  voucherNumber: string
  date: string | Date
  description: string | null
  referenceType: string | null
  status: string
  lines: VoucherLineForPdf[]
  auditTrail: {
    invoiceNumber?: string | null
    bankTxnValueDate?: string | null
    bankTxnAmount?: string | number | null
    bankTxnCounterparty?: string | null
    sourceFileName?: string | null
    sourceFileFormat?: string | null
  }
  company: {
    name: string
    legalName?: string | null
  }
}

const fmtMoneyDE = (n: number) =>
  n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDateDE = (d: string | Date) => {
  const dt = typeof d === "string" ? new Date(d) : d
  return dt.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })
}

const REF_LABEL_DE: Record<string, string> = {
  BankReconciliation: "Bankabgleich (Kundenzahlung)",
  BankReconciliationReversal: "Storno-Buchung",
  BankTransaction: "Bankbuchung (Aufwand)",
  Invoice: "Rechnung (Erlöse)",
}

const STATUS_LABEL_DE: Record<string, string> = {
  posted: "Gebucht",
  draft: "Entwurf",
  voided: "Storniert",
}

export function generateVoucherPDF(input: VoucherPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, left: 50, right: 50, bottom: 50 },
    })

    const chunks: Buffer[] = []
    doc.on("data", (c) => chunks.push(c))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    // === Header ===
    doc.font("Helvetica-Bold").fontSize(20).text("Buchungsbeleg", { align: "left" })
    doc.moveDown(0.3)

    // Company sender line (top-right)
    doc.font("Helvetica").fontSize(8).fillColor("#666")
      .text(input.company.legalName || input.company.name, { align: "left" })
    doc.fillColor("#000")
    doc.moveDown(0.6)

    // === Beleg metadata table ===
    const metaTop = doc.y
    const metaCol = 130
    const label = (s: string) => doc.font("Helvetica").fontSize(9).fillColor("#666").text(s)
    const value = (s: string) =>
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#000").text(s)
    const row = (l: string, v: string) => {
      doc.y = metaTop
      label(l)
      doc.x = metaCol
      value(v)
    }
    row("Belegnummer:", input.voucherNumber)
    doc.moveDown(0.2)
    row("Belegdatum:", fmtDateDE(input.date))
    doc.moveDown(0.2)
    row("Status:", STATUS_LABEL_DE[input.status] || input.status)
    doc.moveDown(0.2)
    row(
      "Buchungsart:",
      REF_LABEL_DE[input.referenceType || ""] || input.referenceType || "Manuell"
    )
    doc.moveDown(0.2)
    row("Beschreibung:", input.description || "—")
    doc.moveDown(1.2)

    // === Lines table ===
    // Simple 4-col table: Konto | Name | Soll | Haben
    const tableTop = doc.y
    const colKo = 50
    const colName = 110
    const colSoll = 360
    const colHaben = 460
    const rowH = 18

    // Header row
    doc.font("Helvetica-Bold").fontSize(9)
    doc.text("Konto", colKo, tableTop, { width: 50 })
    doc.text("Kontobezeichnung", colName, tableTop, { width: 240 })
    doc.text("Soll", colSoll, tableTop, { width: 90, align: "right" })
    doc.text("Haben", colHaben, tableTop, { width: 90, align: "right" })

    // Underline
    doc.moveTo(50, tableTop + rowH - 3)
      .lineTo(550, tableTop + rowH - 3)
      .strokeColor("#000").stroke()

    let y = tableTop + rowH
    let totalSoll = 0
    let totalHaben = 0
    for (const l of input.lines) {
      const debit = Number(l.debit)
      const credit = Number(l.credit)
      totalSoll += debit
      totalHaben += credit
      doc.font("Helvetica").fontSize(10)
      doc.text(l.accountNumber, colKo, y, { width: 50 })
      doc.text(l.accountName, colName, y, { width: 240 })
      doc.text(debit > 0 ? fmtMoneyDE(debit) : "", colSoll, y, { width: 90, align: "right" })
      doc.text(credit > 0 ? fmtMoneyDE(credit) : "", colHaben, y, { width: 90, align: "right" })
      if (l.description) {
        doc.font("Helvetica").fontSize(8).fillColor("#666")
          .text(l.description, colName, y + 10, { width: 240 })
        doc.fillColor("#000")
        y += 12
      }
      y += rowH - 2
    }

    // Total row
    doc.moveTo(50, y - 3).lineTo(550, y - 3).strokeColor("#000").stroke()
    doc.font("Helvetica-Bold").fontSize(10)
    doc.text("Summe", colName, y)
    doc.text(fmtMoneyDE(totalSoll), colSoll, y, { width: 90, align: "right" })
    doc.text(fmtMoneyDE(totalHaben), colHaben, y, { width: 90, align: "right" })
    y += rowH

    // Balance check
    const balanced = Math.abs(totalSoll - totalHaben) < 0.01
    doc.font("Helvetica").fontSize(8)
      .fillColor(balanced ? "#1a7f37" : "#b91c1c")
      .text(
        balanced
          ? "✓ Soll = Haben — Buchung ausgeglichen"
          : "✗ Soll ≠ Haben — Buchung UNAUSGEGLICHEN",
        50,
        y + 4
      )
    doc.fillColor("#000")
    y += 30

    // === Audit-Trail ===
    doc.font("Helvetica-Bold").fontSize(11).text("Audit-Trail", 50, y)
    y += 16
    doc.font("Helvetica").fontSize(9)

    const trail = input.auditTrail
    if (trail.invoiceNumber) {
      doc.text(`• Rechnung: ${trail.invoiceNumber}`, 50, y)
      y += 13
    }
    if (trail.bankTxnValueDate) {
      const amt = trail.bankTxnAmount != null ? Number(trail.bankTxnAmount) : 0
      const amtStr = amt >= 0 ? `+${fmtMoneyDE(amt)}` : fmtMoneyDE(amt)
      const cp = trail.bankTxnCounterparty ? ` · ${trail.bankTxnCounterparty}` : ""
      doc.text(
        `• Bank-Transaktion: ${fmtDateDE(trail.bankTxnValueDate)} ${amtStr} EUR${cp}`,
        50,
        y
      )
      y += 13
    }
    if (trail.sourceFileName) {
      const fmt = trail.sourceFileFormat ? ` (${trail.sourceFileFormat.toUpperCase()})` : ""
      doc.text(`• Quelldatei: ${trail.sourceFileName}${fmt}`, 50, y)
      y += 13
    }
    if (
      !trail.invoiceNumber &&
      !trail.bankTxnValueDate &&
      !trail.sourceFileName
    ) {
      doc.fillColor("#666").text(
        "Keine Verknüpfung — manuell erstellter Buchungsbeleg",
        50,
        y
      )
      doc.fillColor("#000")
      y += 13
    }
    y += 8

    // === Footer (GoBD immutability note) ===
    const footerY = doc.page.height - doc.page.margins.bottom - 20
    doc.font("Helvetica").fontSize(8).fillColor("#666")
    doc.text(
      `Seite 1 von 1    ·    ${input.voucherNumber}    ·    Unveränderlich aufbewahrungspflichtig (§146 AO / §257 HGB)`,
      50,
      footerY,
      { width: 495, align: "center" }
    )

    doc.end()
  })
}
