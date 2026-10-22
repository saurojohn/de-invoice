// Tier 683 — the invoice as a document, built one way for every outlet.
//
// The same invoice left the program in six ways, and each had put its own
// call to the renderer together:
//
//   download (GET /invoices/:id/pdf)   e-invoice, full letterhead, template
//   GET /invoices/:id/zugferd          e-invoice, full letterhead, NO template
//   bulk download (ZIP)                e-invoice, six company fields, NO template
//   e-mail to the customer             plain PDF, six company fields
//   e-mail, sent again                 plain PDF, six company fields, NO template
//   customer portal                    plain PDF, six company fields, NO template
//
// "Six company fields" is name, address, USt-IdNr., Steuernummer, bank and
// logo: the register entry and the managing director (§ 35a GmbHG) were not on
// the page. "No template" loses more than a colour — the § 19 UStG note of a
// Kleinunternehmer is a text of the template. And the customer, who is the one
// the e-invoice is for, got the one copy without the XML.
//
// Every outlet calls renderInvoiceDocument now.
import { Logger } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { issuerContext } from './issuer-context'
import { generateInvoicePDF, InvoiceRenderConfig } from '../../invoices/invoice-pdf.service'
import { generateZUGFeRD } from '../../invoices/zugferd.service'
import { generateXRechnung, transformToXRechnungData } from '../../invoices/xrechnung.service'
import { InvoiceTemplateService } from '../invoice-template/invoice-template.service'
import { advanceDeductionFor } from './advance'
import { isNonFiscal, NON_FISCAL_TYPES } from './document-scope'
import { StorageService } from '../storage/storage.service'
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib'

const logger = new Logger('InvoiceDocument')

// Tier 728d: in issuer-context.ts (the template preview uses it too)
export { issuerContext } from './issuer-context'

/** The texts, colour and density of the invoice's template (Tier 7.5), or the company's default. */
export async function templateConfigFor(
  prisma: PrismaService,
  invoice: { companyId: string; templateType?: string | null; templateId?: string | null },
): Promise<InvoiceRenderConfig | undefined> {
  try {
    const r = await new InvoiceTemplateService(prisma).resolveConfig(
      invoice.companyId,
      invoice.templateType || 'standard',
      invoice.templateId,
    )
    return r.config as InvoiceRenderConfig
  } catch {
    return undefined
  }
}

export interface InvoiceDocument {
  buffer: Buffer
  /** true: the PDF carries the invoice as XML (ZUGFeRD / Factur-X, EN 16931) */
  eInvoice: boolean
  /** false: the plain variant of an invoice was asked for — not the copy to keep */
  canonical: boolean
  /** Tier 686: the XRechnung (UBL) of the same rendering, kept next to the PDF */
  xrechnung?: Buffer
}

/** The XRechnung (UBL) of an invoice — with the company's Leitweg-ID (Tier 115). */
export function xrechnungFor(invoice: any, company: any): Buffer {
  const withLeitweg = { ...company, leitwegId: (company?.settings as any)?.leitwegId || null }
  return Buffer.from(generateXRechnung(transformToXRechnungData(invoice, withLeitweg)), 'utf-8')
}

/** What the renderer reads of an invoice (a credit note names the invoice it corrects). */
export const INVOICE_DOCUMENT_INCLUDE = {
  customer: true,
  items: { include: { product: { select: { sku: true, name: true } } } },
  payments: true,
  referenceInvoice: true,
} as const

/**
 * The PDF of an invoice. An invoice is an e-invoice (the readable PDF with the
 * XML inside) unless `plain` is asked for; a quote, an order confirmation or a
 * delivery note is no invoice and always a plain PDF (Tier 610).
 *
 * `lenient`: when the XML cannot be built, give the plain PDF instead of
 * failing — for a document that is on its way to the customer.
 */
export async function renderInvoiceDocument(
  prisma: PrismaService,
  invoice: any,
  company: any,
  opts: { plain?: boolean; lenient?: boolean; templateConfig?: InvoiceRenderConfig } = {},
): Promise<InvoiceDocument> {
  const templateConfig = opts.templateConfig ?? (await templateConfigFor(prisma, invoice))
  // Tier 472: a final invoice states the advance it deducts.
  invoice.advanceDeduction = await advanceDeductionFor(prisma, invoice)
  const issuer = issuerContext(company, templateConfig)
  const plain = () => generateInvoicePDF(invoice, issuer, invoice.templateType || 'standard', templateConfig)
  if (isNonFiscal(invoice.type)) return { buffer: await plain(), eInvoice: false, canonical: true }
  if (opts.plain) return { buffer: await plain(), eInvoice: false, canonical: false }
  try {
    const buffer = await generateZUGFeRD(invoice, issuer, { templateConfig })
    let xrechnung: Buffer | undefined
    try {
      xrechnung = xrechnungFor(invoice, company)
    } catch (err) {
      logger.warn(`Rechnung ${invoice.invoiceNumber}: keine XRechnung (${(err as Error)?.message})`)
    }
    return { buffer, eInvoice: true, canonical: true, xrechnung }
  } catch (err) {
    if (!opts.lenient) throw err
    logger.warn(`Rechnung ${invoice.invoiceNumber}: die E-Rechnung ließ sich nicht erzeugen (${(err as Error)?.message}) — es geht das PDF ohne XML hinaus`)
    return { buffer: await plain(), eInvoice: false, canonical: true }
  }
}

// Tier 684 — the copy of an issued invoice that is kept.
//
// The stored PDF (`pdfPath`) is what the GoBD export and the DATEV bundle hand
// over as the invoice "as issued" (Tier 420, 497). It was written in one place
// only: the first download. Measured on three issued invoices — one sent to
// the customer by e-mail, one downloaded, one only issued: the DATEV bundle
// held one Beleg, the GoBD export one PDF and two bare meta.json. The invoice
// the customer actually has was not kept (§ 14b UStG: a copy of every invoice
// issued).
//
// Now the copy is written the first time the document goes out by any way
// (keepIssuedCopy), and the exports make it for an issued invoice that has
// none before they collect (ensureIssuedCopies).
let storage: StorageService | undefined

/** Keeps `doc` as the invoice's stored copy if it has none. Never a draft's (Tier 497). */
export async function keepIssuedCopy(
  prisma: PrismaService,
  invoice: { id: string; companyId: string; invoiceNumber: string; status: string; pdfPath?: string | null },
  doc: InvoiceDocument,
): Promise<void> {
  if (invoice.pdfPath || invoice.status === 'draft' || !doc.canonical) return
  try {
    storage ??= new StorageService()
    const saved = await storage.saveInvoicePdf(doc.buffer, invoice.invoiceNumber, invoice.companyId)
    // Only where there is still none: two requests at once keep one copy.
    // Written past the audit extension: where the copy lies is no change of
    // the invoice — through the client, every issued invoice got a second
    // „invoice.updated“ row in the audit log (and `updatedAt` moved).
    const count = await prisma.$executeRaw`UPDATE "Invoice" SET "pdfPath" = ${saved.path} WHERE id = ${invoice.id} AND "pdfPath" IS NULL`
    if (count) {
      invoice.pdfPath = saved.path
      // Tier 686: the XRechnung of the same moment, next to it
      if (doc.xrechnung) await storage.saveAt(xrechnungPathOf(saved.path), doc.xrechnung)
    }
  } catch (err) {
    // the document is on its way either way
    logger.error(`Rechnung ${invoice.invoiceNumber}: die Kopie ließ sich nicht ablegen (${(err as Error)?.message})`)
  }
}

/**
 * Makes the stored copy of every issued invoice of the period that has none
 * yet. Returns how many were made.
 */
export async function ensureIssuedCopies(
  prisma: PrismaService,
  companyId: string,
  issueDate: { gte?: Date; lte?: Date; lt?: Date },
): Promise<number> {
  const missing = await prisma.invoice.findMany({
    where: { companyId, issueDate, pdfPath: null, status: { not: 'draft' }, type: { notIn: NON_FISCAL_TYPES } },
    include: INVOICE_DOCUMENT_INCLUDE,
    orderBy: { issueDate: 'asc' },
  })
  if (missing.length === 0) return 0
  const company = await prisma.company.findUnique({ where: { id: companyId } })
  let made = 0
  for (const invoice of missing) {
    try {
      await keepIssuedCopy(prisma, invoice, await renderInvoiceDocument(prisma, invoice, company, { lenient: true }))
      if (invoice.pdfPath) made++
    } catch (err) {
      logger.warn(`Rechnung ${invoice.invoiceNumber}: keine Kopie für den Export (${(err as Error)?.message})`)
    }
  }
  return made
}

// Tier 685 — an issued invoice is its kept copy.
//
// The owner, 14.10.2026, on Tier 684's open point: „要，已开具的发票一律提供存档原件“ —
// an issued invoice is always handed out as its archived original. Every way
// out rendered it again from today's master data: after the company moved or
// changed its bank account, an invoice of last year downloaded, e-mailed again
// or opened in the portal showed the new address and IBAN, while the archive
// held the original. Template or logo changes reached issued invoices the
// same way.
//
// Drafts are rendered as they are now, as are quotes, order confirmations and
// delivery notes (no invoices; their copies are not the subject here).

/**
 * The document of an invoice for any way out. An issued invoice: its kept copy
 * (made and kept now if it has none). `plain`: the same copy without the XML
 * inside — not a new rendering.
 */
export async function issuedDocument(
  prisma: PrismaService,
  invoice: any,
  company: any,
  opts: { plain?: boolean; lenient?: boolean } = {},
): Promise<InvoiceDocument & { fromCopy: boolean }> {
  if (invoice.status === 'draft' || isNonFiscal(invoice.type)) {
    return { ...(await renderInvoiceDocument(prisma, invoice, company, opts)), fromCopy: false }
  }
  let copy = await readCopy(prisma, invoice)
  if (!copy) {
    const doc = await renderInvoiceDocument(prisma, invoice, company, { lenient: opts.lenient })
    await keepIssuedCopy(prisma, invoice, doc)
    if (!opts.plain) return { ...doc, fromCopy: false }
    copy = doc.buffer
  }
  if (opts.plain) return { buffer: await withoutEmbeddedFiles(copy), eInvoice: false, canonical: false, fromCopy: true }
  return { buffer: copy, eInvoice: copy.includes('factur-x.xml'), canonical: true, fromCopy: true }
}

/** The kept copy's bytes; a path whose file is gone is let go (and said so), so a new copy is made. */
async function readCopy(prisma: PrismaService, invoice: { id: string; invoiceNumber: string; pdfPath?: string | null }): Promise<Buffer | null> {
  if (!invoice.pdfPath) return null
  storage ??= new StorageService()
  const file = await storage.getFile(invoice.pdfPath).catch(() => null)
  if (file?.buffer?.length) return file.buffer
  logger.error(`Rechnung ${invoice.invoiceNumber}: die abgelegte Kopie ${invoice.pdfPath} fehlt — sie wird neu erzeugt`)
  await prisma.$executeRaw`UPDATE "Invoice" SET "pdfPath" = NULL WHERE id = ${invoice.id} AND "pdfPath" = ${invoice.pdfPath}`
  invoice.pdfPath = null
  return null
}

/**
 * The PDF without its embedded files and the XMP packet that announces them —
 * the page content and everything else untouched.
 */
export async function withoutEmbeddedFiles(buffer: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.load(buffer, { updateMetadata: false })
  const catalog = pdf.catalog
  catalog.delete(PDFName.of('AF'))
  catalog.delete(PDFName.of('Metadata'))
  const names = catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  const tree = names?.get(PDFName.of('EmbeddedFiles'))
  names?.delete(PDFName.of('EmbeddedFiles'))
  // The objects themselves: pdf-lib writes every object it holds, referenced or not.
  if (tree instanceof PDFRef) pdf.context.delete(tree)
  const type = (o: unknown) => (o instanceof PDFDict ? o : o instanceof PDFRawStream || o instanceof PDFStream ? o.dict : null)?.get(PDFName.of('Type'))
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    const t = type(obj)
    if (t === PDFName.of('EmbeddedFile') || t === PDFName.of('Filespec') || t === PDFName.of('Metadata')) pdf.context.delete(ref)
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}

// Tier 686 — the XRechnung of an issued invoice is kept too.
//
// After Tier 685 the PDF of an issued invoice was frozen, its XRechnung (UBL,
// GET /invoices/:id/xrechnung) was not: built again from today's master data,
// so after a move it named the new address — the e-invoice a public customer
// receives, and the format of a B2B e-invoice as much as ZUGFeRD. It is kept
// next to the PDF (same name, `.xrechnung.xml`), made in the same moment.

/** Where the XRechnung of a kept PDF lies. */
export function xrechnungPathOf(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, '') + '.xrechnung.xml'
}

/**
 * The XRechnung of an invoice: for an issued one the kept file (made now with
 * the kept PDF if it has none; for a copy kept before Tier 686, made now and
 * kept), for a draft a fresh one.
 */
export async function issuedXRechnung(prisma: PrismaService, invoice: any, company: any): Promise<{ xml: Buffer; fromCopy: boolean }> {
  if (invoice.status === 'draft' || isNonFiscal(invoice.type)) return { xml: xrechnungFor(invoice, company), fromCopy: false }
  if (!(await readCopy(prisma, invoice))) {
    const doc = await renderInvoiceDocument(prisma, invoice, company)
    await keepIssuedCopy(prisma, invoice, doc)
  }
  if (!invoice.pdfPath) return { xml: xrechnungFor(invoice, company), fromCopy: false }
  storage ??= new StorageService()
  const where = xrechnungPathOf(invoice.pdfPath)
  const kept = await storage.getFile(where).catch(() => null)
  if (kept?.buffer?.length) return { xml: kept.buffer, fromCopy: true }
  const xml = xrechnungFor(invoice, company)
  try {
    await storage.saveAt(where, xml)
  } catch (err) {
    // another request kept it a moment ago: hand out that one
    const again = await storage.getFile(where).catch(() => null)
    if (again?.buffer?.length) return { xml: again.buffer, fromCopy: true }
    logger.error(`Rechnung ${invoice.invoiceNumber}: die XRechnung ließ sich nicht ablegen (${(err as Error)?.message})`)
  }
  return { xml, fromCopy: false }
}
