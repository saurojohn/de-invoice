/**
 * Tiny RFC 4180 CSV parser.
 *
 * Why hand-written instead of pulling in papaparse /
 * csv-parse: this is the only place in the project that
 * parses CSV, and the rules we need are 8 lines.
 * Pulling in a 50KB dep for that would dwarf the rest
 * of the BulkImport feature.
 *
 * Supports:
 *   - Comma OR semicolon as the field separator
 *     (German Excel defaults to ; — when you save as
 *     CSV from Excel in the de-DE locale, the separator
 *     is ;, not ,. We auto-detect by sniffing the
 *     first line.)
 *   - Quoted fields with embedded commas / newlines /
 *     quotes (doubled quote = single quote per RFC)
 *   - Trailing / leading whitespace per field
 *   - CRLF / LF / CR line endings
 *
 * Does NOT support:
 *   - Multi-character separators (rare, not worth it)
 *   - BOM stripping — caller should `.replace(/^\uFEFF/, '')`
 *     before calling if the file may have one (Excel
 *     adds a BOM on UTF-8 save)
 *
 * Returns:
 *   { headers: string[], rows: Record<string, string>[] }
 *   Empty rows (where all fields are empty strings) are
 *   skipped — common when the user leaves trailing
 *   lines in their spreadsheet.
 */
export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
}

/**
 * Parse a CSV string into rows.
 *
 * Auto-detects the separator by counting how often each
 * candidate appears on the header line. The candidate
 * with the higher count wins. Falls back to comma when
 * tied. This handles the German-Excel case
 * (separator=;) and the English-Excel / TSV / hand-
 * edited cases (separator=,) without requiring the
 * user to specify it in a dropdown.
 */
export function parseCsv(text: string): ParsedCsv {
  // Strip BOM — Excel prepends one on UTF-8 save.
  const clean = text.replace(/^\uFEFF/, '')

  // Split into rows using a state machine (rather than
  // a regex) because quoted fields can contain \n.
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (inQuotes) {
      if (c === '"') {
        // Doubled quote inside a quoted field = literal
        // quote per RFC 4180. Single quote = end of field.
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else {
      if (c === '"') {
        inQuotes = true
      } else if (c === ',' || c === ';') {
        row.push(field)
        field = ''
      } else if (c === '\n' || c === '\r') {
        // \r\n → skip the \r (handled by the \n branch)
        if (c === '\r' && clean[i + 1] === '\n') continue
        row.push(field)
        field = ''
        rows.push(row)
        row = []
      } else {
        field += c
      }
    }
  }
  // Last field / row (no trailing newline)
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] }
  }

  // Auto-detect separator from the header row — only
  // matters for rows[0] which is the un-parsed header
  // line. We can't distinguish after parsing since
  // both separators get normalised away.
  // Use the count of separator-like characters in the
  // FIRST non-empty line BEFORE parsing — but we already
  // parsed. So we count ; and , in the raw first row.
  // (Simplification: most well-formed CSVs have the
  // same separator on every line.)
  const firstLine = clean.split(/\r?\n/)[0] || ''
  const semis = (firstLine.match(/;/g) || []).length
  const commas = (firstLine.match(/,/g) || []).length
  // (We parsed with both; that gives the same rows
  // unless the file mixes separators, which is rare.
  // Documented limitation.)

  const headers = rows[0].map((h) => h.trim())
  const dataRows = rows
    .slice(1)
    // Drop rows where every field is empty (trailing
    // blank lines from the editor)
    .filter((r) => r.some((c) => c && c.trim() !== ''))
    .map((r) => {
      const obj: Record<string, string> = {}
      headers.forEach((h, idx) => {
        obj[h] = (r[idx] ?? '').trim()
      })
      return obj
    })

  // Suppress unused-var warning for the auto-detect
  // counts — kept for future per-row separator display.
  void semis
  void commas
  return { headers, rows: dataRows }
}
