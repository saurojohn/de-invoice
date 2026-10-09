import PDFDocument from 'pdfkit'

/**
 * Tier 618 — the time sheet (Stundennachweis / Tätigkeitsnachweis).
 *
 * What a customer gets with an invoice over hours: every entry with its
 * day, project, activity and duration, the hours per project and in total.
 * No prices — those are on the invoice. A4, black on white, thin lines
 * (the rules of the invoice PDF: German number and date formats, every
 * single-line text with `lineBreak: false`).
 */
export type TimesheetEntry = {
  date: Date
  minutes: number
  description: string
  project?: { name: string } | null
  customer?: { name: string } | null
}

export type TimesheetInput = {
  companyName: string
  companyAddress?: { street?: string; postalCode?: string; city?: string } | null
  customerName?: string | null
  customerNumber?: string | null
  projectName?: string | null
  invoiceNumber?: string | null
  from?: string | null
  to?: string | null
  entries: TimesheetEntry[]
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10).split('-').reverse().join('.')
const hhmm = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
/** hours with two decimals, as on the invoice line: 50 min → 0,83 */
const hours = (minutes: number) => (Math.round((minutes / 60) * 100) / 100).toFixed(2).replace('.', ',')

export function generateTimesheetPdf(input: TimesheetInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // the bottom margin is small on purpose: the page number sits 36 pt above
    // the edge, and a text below the margin makes pdfkit add a page (the
    // first version put "Seite 1 von 1" alone on a second one). The rows
    // stop at `bottom`, well above it.
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, left: 50, right: 50, bottom: 10 }, bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const left = 50
    const right = doc.page.width - 50
    const bottom = doc.page.height - 60
    // Datum | Projekt | Tätigkeit | Dauer | Stunden
    const withProject = input.entries.some((e) => e.project) && !input.projectName
    const withCustomer = !input.customerName && input.entries.some((e) => e.customer)
    const col = {
      date: left,
      second: left + 62,
      text: left + 62 + (withProject || withCustomer ? 110 : 0),
      hhmm: right - 110,
      hours: right - 55,
    }
    const textWidth = col.hhmm - col.text - 8

    // ── head ──
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#000000').text(input.companyName, left, 50, { lineBreak: false })
    const a = input.companyAddress
    const addressLine = a ? [a.street, [a.postalCode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ') : ''
    if (addressLine) doc.font('Helvetica').fontSize(8).text(addressLine, left, 68, { lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(18).text('STUNDENNACHWEIS', left, 100, { lineBreak: false })
    let y = 128
    const meta: [string, string][] = []
    if (input.invoiceNumber) meta.push(['Zur Rechnung:', input.invoiceNumber])
    if (input.customerName) meta.push(['Kunde:', input.customerNumber ? `${input.customerName} (${input.customerNumber})` : input.customerName])
    if (input.projectName) meta.push(['Projekt:', input.projectName])
    const dates = input.entries.map((e) => new Date(e.date).getTime())
    const first = input.from ?? (dates.length ? new Date(Math.min(...dates)).toISOString().slice(0, 10) : null)
    const last = input.to ?? (dates.length ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : null)
    if (first && last) meta.push(['Zeitraum:', first === last ? day(first) : `${day(first)} – ${day(last)}`])
    for (const [label, value] of meta) {
      doc.font('Helvetica').fontSize(9).text(label, left, y, { lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(9).text(value, left + 80, y, { width: right - left - 80, lineBreak: false, ellipsis: true })
      y += 14
    }
    y += 10

    const header = () => {
      doc.font('Helvetica-Bold').fontSize(9)
      doc.text('Datum', col.date, y, { lineBreak: false })
      if (withProject) doc.text('Projekt', col.second, y, { lineBreak: false })
      else if (withCustomer) doc.text('Kunde', col.second, y, { lineBreak: false })
      doc.text('Tätigkeit', col.text, y, { lineBreak: false })
      doc.text('Dauer', col.hhmm, y, { width: 45, align: 'right', lineBreak: false })
      doc.text('Stunden', col.hours, y, { width: 55, align: 'right', lineBreak: false })
      y += 14
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor('#000000').stroke()
      y += 5
    }
    header()

    let total = 0
    const perProject = new Map<string, number>()
    for (const e of input.entries) {
      doc.font('Helvetica').fontSize(9)
      const height = Math.max(12, doc.heightOfString(e.description, { width: textWidth }))
      if (y + height > bottom) {
        doc.addPage()
        y = 50
        header()
        doc.font('Helvetica').fontSize(9)
      }
      doc.text(day(e.date), col.date, y, { lineBreak: false })
      const second = withProject ? e.project?.name ?? '—' : withCustomer ? e.customer?.name ?? '—' : ''
      if (second) doc.text(second, col.second, y, { width: 104, lineBreak: false, ellipsis: true })
      doc.text(e.description, col.text, y, { width: textWidth })
      doc.text(hhmm(e.minutes), col.hhmm, y, { width: 45, align: 'right', lineBreak: false })
      doc.text(hours(e.minutes), col.hours, y, { width: 55, align: 'right', lineBreak: false })
      y += height + 4
      doc.moveTo(left, y - 2).lineTo(right, y - 2).lineWidth(0.3).stroke()
      total += e.minutes
      const key = e.project?.name ?? ''
      perProject.set(key, (perProject.get(key) ?? 0) + e.minutes)
    }
    if (input.entries.length === 0) {
      doc.font('Helvetica').fontSize(9).text('Keine Zeiteinträge im gewählten Zeitraum.', left, y, { lineBreak: false })
      y += 16
    }

    // ── sums ──
    const sums: [string, number][] = []
    if (withProject && perProject.size > 1) {
      for (const [name, minutes] of [...perProject.entries()].sort((x, z) => x[0].localeCompare(z[0], 'de'))) {
        sums.push([name ? `Projekt ${name}` : 'Ohne Projekt', minutes])
      }
    }
    if (y + 20 + sums.length * 14 + 24 > bottom) {
      doc.addPage()
      y = 50
    }
    y += 6
    doc.font('Helvetica').fontSize(9)
    for (const [label, minutes] of sums) {
      doc.text(label, col.text, y, { width: textWidth, lineBreak: false, ellipsis: true })
      doc.text(hhmm(minutes), col.hhmm, y, { width: 45, align: 'right', lineBreak: false })
      doc.text(hours(minutes), col.hours, y, { width: 55, align: 'right', lineBreak: false })
      y += 14
    }
    doc.moveTo(col.text, y).lineTo(right, y).lineWidth(0.8).stroke()
    y += 5
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text('Summe', col.text, y, { lineBreak: false })
    doc.text(hhmm(total), col.hhmm, y, { width: 45, align: 'right', lineBreak: false })
    // the sum of the lines as the invoice shows them (each rounded to two decimals)
    const totalHours = input.entries.reduce((s, e) => s + Math.round((e.minutes / 60) * 100), 0) / 100
    doc.text(totalHours.toFixed(2).replace('.', ','), col.hours, y, { width: 55, align: 'right', lineBreak: false })

    // ── page numbers ──
    const range = doc.bufferedPageRange()
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i)
      doc.font('Helvetica').fontSize(8).fillColor('#000000')
        .text(`Seite ${i + 1} von ${range.count}`, left, doc.page.height - 36, { width: right - left, align: 'center', lineBreak: false })
    }
    doc.end()
  })
}
