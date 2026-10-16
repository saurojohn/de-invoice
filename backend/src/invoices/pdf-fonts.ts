// Tier 693 — the invoice PDF embeds its fonts.
//
// PDFKit's Helvetica / Times / Courier are the PDF "standard 14" fonts: the
// file names them and the reader brings the font. PDF/A (ISO 19005-3 6.2.11.4)
// wants every font program in the file — measured with Mustang / veraPDF, the
// ZUGFeRD PDF failed on it (and claimed "PDF/A-3B" in its XMP all the same).
// Liberation Sans / Serif / Mono have the metrics of the three, so they take
// their names here and the layout stays where it was.
import * as fs from 'fs'
import * as path from 'path'
import { Logger } from '@nestjs/common'

const logger = new Logger('PdfFonts')

// backend/src/invoices → backend/assets, and the same from backend/dist/invoices
const FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts')

export const EMBEDDED_FONTS: Record<string, string> = {
  Helvetica: 'LiberationSans-Regular.ttf',
  'Helvetica-Bold': 'LiberationSans-Bold.ttf',
  'Times-Roman': 'LiberationSerif-Regular.ttf',
  'Times-Bold': 'LiberationSerif-Bold.ttf',
  Courier: 'LiberationMono-Regular.ttf',
  'Courier-Bold': 'LiberationMono-Bold.ttf',
}

let available: boolean | undefined

/** The file of the regular sans font, for PDFKit's `font` option (null: not bundled). */
export function defaultFontFile(): string | null {
  const file = path.join(FONT_DIR, EMBEDDED_FONTS.Helvetica)
  return fontsAvailable() ? file : null
}

export function fontsAvailable(): boolean {
  if (available === undefined) {
    available = Object.values(EMBEDDED_FONTS).every((f) => fs.existsSync(path.join(FONT_DIR, f)))
    if (!available) logger.error(`Schriften fehlen in ${FONT_DIR} — die Rechnung wird ohne eingebettete Schriften erzeugt (kein PDF/A)`)
  }
  return available
}

/** Registers the embedded fonts under the standard names the renderer uses. */
export function registerEmbeddedFonts(doc: { registerFont: (name: string, src: string) => unknown }): boolean {
  if (!fontsAvailable()) return false
  for (const [name, file] of Object.entries(EMBEDDED_FONTS)) doc.registerFont(name, path.join(FONT_DIR, file))
  return true
}
