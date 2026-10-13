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
import { generateInvoicePDF, InvoiceRenderConfig } from '../../invoices/invoice-pdf.service'
import { generateZUGFeRD } from '../../invoices/zugferd.service'
import { InvoiceTemplateService } from '../invoice-template/invoice-template.service'
import { advanceDeductionFor } from './advance'
import { isNonFiscal, NON_FISCAL_TYPES } from './document-scope'
import { StorageService } from '../storage/storage.service'

const logger = new Logger('InvoiceDocument')

/** The company as the renderer reads it: letterhead, Impressum, bank. */
export function issuerContext(company: any, templateConfig?: InvoiceRenderConfig) {
  return {
    name: company?.name || '',
    defaultVatMode: company?.defaultVatMode ?? null, // Tier 482
    legalName: company?.legalName || undefined,
    address: company?.address || {},
    vatId: company?.vatId || undefined,
    taxId: company?.taxId || undefined,
    email: company?.email || undefined,
    phone: company?.phone || undefined,
    fax: company?.fax || undefined,
    website: company?.website || undefined,
    registerEntry: company?.registerEntry || undefined,
    managingDirector: company?.managingDirector || undefined,
    otherInfo: company?.otherInfo || undefined,
    bankInfo: company?.bankInfo || undefined,
    logoPath: company?.logoPath || undefined,
    templateConfig,
  } as any
}

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
    return { buffer: await generateZUGFeRD(invoice, issuer, { templateConfig }), eInvoice: true, canonical: true }
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
    if (count) invoice.pdfPath = saved.path
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
