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
  return `${kind}; filename="${encodeURIComponent(filename)}"`
}
