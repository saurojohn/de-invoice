import { BadRequestException } from '@nestjs/common'

/**
 * Tier 531 — the rows of a bulk import are records of plain values.
 *
 * The import routes take `{ rows: [...] }` typed by an interface, which the
 * validation pipe does not check. Measured: a row that is `null`, a number
 * or a string, or a field holding an object / array (`"description": {…}`)
 * reached `.trim()` in the service — 500 for the whole import. Now a 400 that
 * names the row.
 */
export function assertImportRows(rows: unknown): asserts rows is Record<string, unknown>[] {
  if (!Array.isArray(rows)) throw new BadRequestException('rows array is required')
  rows.forEach((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new BadRequestException(`Zeile ${i + 1} ist kein Datensatz.`)
    }
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      // A list of plain values is a value too (a customer's `tags`).
      const plainList = Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')
      if (value !== null && typeof value === 'object' && !plainList) {
        throw new BadRequestException(`Zeile ${i + 1}: Feld "${key.slice(0, 40)}" muss ein einfacher Wert sein.`)
      }
    }
  })
}
