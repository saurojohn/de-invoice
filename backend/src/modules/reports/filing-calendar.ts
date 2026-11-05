/**
 * Tier 805 — the tax deadlines as an iCalendar feed (RFC 5545), to subscribe
 * to in Google, Apple or Outlook calendar. Pure: the rows in, the text out.
 *
 * Every deadline is an all-day event on its due date (already moved to the
 * working day, § 108 Abs. 3 AO). Its UID is fixed by kind and period, so a
 * calendar updates the event instead of adding one when the status changes
 * (filed, paid). Open ones carry an alarm at 09:00 the day before — Apple
 * Calendar and Outlook honour it; Google ignores alarms of subscribed feeds.
 */

export interface CalendarRow {
  kind: string
  year: number
  month: number | null
  quarter: number | null
  dueDate: string
  status: string
  note: string | null
  amount?: number
}

const KIND: Record<string, string> = {
  ustva: 'UStVA', zm: 'ZM', oss: 'OSS', annual: 'Jahreserklärungen', svz: 'Sondervorauszahlung',
  dauerfrist: 'Dauerfristverlängerung', kst: 'Körperschaftsteuer-Vorauszahlung', gewst: 'Gewerbesteuer-Vorauszahlung',
}
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
const PAYMENTS = new Set(['svz', 'kst', 'gewst'])

export function rowLabel(r: CalendarRow): string {
  const period = r.month ? `${MONTHS[r.month - 1]} ${r.year}` : r.quarter ? `Q${r.quarter} ${r.year}` : String(r.year)
  return `${KIND[r.kind] ?? r.kind} ${period}`
}

export function rowUid(r: CalendarRow, companyId: string): string {
  return `${r.kind}-${r.year}-${r.month ?? (r.quarter ? `Q${r.quarter}` : 'Y')}-${companyId}@de-invoice`
}

/** RFC 5545 § 3.3.11: backslash, semicolon, comma and line breaks are escaped in TEXT. */
export function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** RFC 5545 § 3.1: lines longer than 75 octets are folded — CRLF and one space — between characters, not inside one. */
export function foldLine(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8')
    const limit = out.length === 0 ? 75 : 74 // a continuation line starts with the space
    if (bytes + n > limit) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

const compact = (iso: string) => iso.replace(/-/g, '')
const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export function buildIcs(
  rows: CalendarRow[],
  opts: { companyId: string; companyName: string; origin: string; now: Date },
): string {
  const eur = (n: number) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//de-invoice//Steuertermine//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`Steuertermine — ${opts.companyName}`)}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ]
  for (const r of rows) {
    const done = r.status === 'filed'
    const label = rowLabel(r)
    const summary = done
      ? `✓ ${label} (${PAYMENTS.has(r.kind) ? 'gezahlt' : 'abgegeben'})`
      : r.status === 'option'
        ? `${label} — letzter Tag für den Antrag`
        : `${label} fällig${r.amount ? ` — ${r.kind === 'svz' ? 'ca. ' : ''}${eur(r.amount)}` : ''}`
    const description = [r.note, `Übersicht: ${opts.origin}/dashboard`].filter(Boolean).join('\n\n')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${rowUid(r, opts.companyId)}`,
      `DTSTAMP:${stamp(opts.now)}`,
      `DTSTART;VALUE=DATE:${compact(r.dueDate)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(r.dueDate))}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(description)}`,
      'TRANSP:TRANSPARENT',
    )
    if (!done && r.status !== 'option') {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`${label} ist morgen fällig`)}`, 'TRIGGER:-PT15H', 'END:VALARM')
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
