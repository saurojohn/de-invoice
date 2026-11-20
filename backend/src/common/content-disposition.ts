/**
 * Tier 573 — which stored files a browser may show in place.
 *
 * A PDF or a picture is shown; everything else is a download. An XML file
 * (accepted since e-invoices are) displayed on the API's own origin can carry
 * a stylesheet or XHTML with script, and that script would run with the
 * session of whoever opened it.
 */
const INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp|tiff))$/

export function contentDisposition(mimeType: string, filename: string, download = false): string {
  const kind = !download && INLINE.test(mimeType) ? 'inline' : 'attachment'
  return `${kind}; ${dispositionFilename(filename)}`
}

/**
 * Tier 890 — a file name in a header, as RFC 6266 writes it: an ASCII
 * `filename="…"` for every browser and `filename*=UTF-8''…` with the name as
 * it is.
 *
 * The names were put into the header as they were. Measured with a customer
 * number „K–1“: the statement download answered 500 (Node refuses a
 * character above U+00FF in a header). „K"2“ ended the quoted name, so the
 * file was saved as „Kontoauszug_K“. „Müller“ arrived as „M�ller“. The
 * percent-encoded `filename="…"` this helper wrote was saved as
 * „M%C3%BCller.pdf“ by the application's own download code.
 */
export function dispositionFilename(filename: string): string {
  const name = String(filename || 'download').replace(/[\r\n]/g, ' ')
  const ascii = name
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return ascii === name ? `filename="${ascii}"` : `filename="${ascii}"; filename*=UTF-8''${star}`
}
