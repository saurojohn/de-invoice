/**
 * Tier 648 — the CSV files a person opens are German CSV: semicolons between
 * the cells and a comma in the numbers (decided by the owner on 10.10.2026).
 *
 * Until then it depended on the export: the cash book, the OSS report and
 * everything for DATEV wrote "1234,56"; the invoice list and the hours report
 * wrote "1234.56", which a German Excel reads as text — or as the 1st of
 * December. No thousands separator: a file is for adding up, and "1.234,56"
 * is a different text in every program that reads it back.
 *
 * Files with a format of their own are not touched: DATEV (EXTF), the GoBD
 * archive, the audit log's raw values.
 */
export const csvNumber = (n: number, digits = 2): string => n.toFixed(digits).replace('.', ',')

/**
 * Tier 857 — text that begins like a formula gets a leading apostrophe.
 *
 * A spreadsheet runs a cell that begins with = + - @ (or a tab / line break
 * before one) as a formula: a customer called „=HYPERLINK("https://…";"…")“,
 * a cash book entry, an asset's name — typed by anyone with write access, or
 * taken over from an import — became a link or a calculation in the file the
 * owner or the Steuerberater opens (CSV / formula injection, OWASP). The
 * apostrophe makes it text; the time report has done so since Tier 628.
 *
 * A number stays a number: „-12,50“ and „+3“ are not changed — the exports
 * write negative amounts. Not for the files with a format of their own
 * (DATEV EXTF, the GoBD data sets and archive): a program reads those, and
 * the value must be exactly what is booked.
 */
export const csvText = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d.,]*$/.test(s) ? `'${s}` : s
}

/** A cell between semicolons: quoted when it holds a quote, a semicolon or a line break; never a formula (csvText). */
export const csvCell = (v: unknown): string => {
  const s = csvText(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
