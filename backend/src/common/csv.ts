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

/** A cell between semicolons: quoted when it holds a quote, a semicolon or a line break. */
export const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
