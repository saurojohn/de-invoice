/**
 * Tier 573 — the XML inside a ZUGFeRD / Factur-X PDF.
 *
 * A hybrid invoice is a PDF/A-3 with the invoice once more as an embedded
 * XML file (`factur-x.xml`; `zugferd-invoice.xml` in ZUGFeRD 2.0,
 * `xrechnung.xml` for the XRechnung profile). The XML is the invoice; the
 * page is a rendering of it (BMF 15.10.2024 Rz. 29).
 *
 * The file comes from outside: the embedded stream is inflated with a hard
 * ceiling (a few kilobytes of Flate can expand to gigabytes), and a PDF
 * pdf-lib cannot read — damaged, encrypted — simply has no XML for us.
 */
import { inflateSync } from 'zlib'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from 'pdf-lib'

export interface EmbeddedXml {
  filename: string
  content: Buffer
}

const MAX_XML_BYTES = 10 * 1024 * 1024
const KNOWN_NAMES = ['factur-x.xml', 'xrechnung.xml', 'zugferd-invoice.xml']

function nameOf(spec: PDFDict): string {
  for (const key of ['UF', 'F']) {
    const v = spec.lookup(PDFName.of(key))
    if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText()
  }
  return ''
}

function contentOf(spec: PDFDict): Buffer | null {
  const ef = spec.lookup(PDFName.of('EF'))
  if (!(ef instanceof PDFDict)) return null
  const stream = ef.lookup(PDFName.of('F')) ?? ef.lookup(PDFName.of('UF'))
  if (!(stream instanceof PDFRawStream)) return null
  const raw = Buffer.from(stream.contents)
  let filter = stream.dict.lookup(PDFName.of('Filter'))
  if (filter instanceof PDFArray) {
    if (filter.size() > 1) return null
    filter = filter.size() === 1 ? filter.lookup(0) : undefined
  }
  if (!filter) return raw.length <= MAX_XML_BYTES ? raw : null
  if (filter instanceof PDFName && filter === PDFName.of('FlateDecode')) {
    try {
      return inflateSync(raw, { maxOutputLength: MAX_XML_BYTES })
    } catch {
      return null // damaged, or larger than an invoice may be
    }
  }
  return null
}

/** every file specification reachable from a name tree node */
function collect(node: unknown, out: PDFDict[], depth: number): void {
  if (!(node instanceof PDFDict) || depth > 8 || out.length > 50) return
  const names = node.lookup(PDFName.of('Names'))
  if (names instanceof PDFArray) {
    for (let i = 1; i < names.size(); i += 2) {
      const spec = names.lookup(i)
      if (spec instanceof PDFDict) out.push(spec)
    }
  }
  const kids = node.lookup(PDFName.of('Kids'))
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size() && i < 200; i++) collect(kids.lookup(i), out, depth + 1)
  }
}

/**
 * The XML files embedded in the PDF, the ones named like an invoice first.
 * An empty list when there are none or the PDF cannot be read.
 */
export async function embeddedXmlFiles(pdf: Buffer): Promise<EmbeddedXml[]> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: false })
  } catch {
    return []
  }
  const specs: PDFDict[] = []
  try {
    const catalog = doc.catalog
    const names = catalog.lookup(PDFName.of('Names'))
    if (names instanceof PDFDict) collect(names.lookup(PDFName.of('EmbeddedFiles')), specs, 0)
    const af = catalog.lookup(PDFName.of('AF'))
    if (af instanceof PDFArray) {
      for (let i = 0; i < af.size() && i < 50; i++) {
        const spec = af.lookup(i)
        if (spec instanceof PDFDict && !specs.includes(spec)) specs.push(spec)
      }
    }
  } catch {
    return []
  }
  const found: EmbeddedXml[] = []
  for (const spec of specs) {
    try {
      const filename = nameOf(spec)
      if (!/\.xml$/i.test(filename)) continue
      const content = contentOf(spec)
      if (content && content.length) found.push({ filename: filename.slice(0, 200), content })
    } catch {
      // one unreadable entry does not hide the others
    }
  }
  const rank = (f: EmbeddedXml) => {
    const i = KNOWN_NAMES.indexOf(f.filename.toLowerCase())
    return i === -1 ? KNOWN_NAMES.length : i
  }
  return found.sort((a, b) => rank(a) - rank(b))
}
