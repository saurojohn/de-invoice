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
import { isNonFiscal } from './document-scope'

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
}

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
  if (opts.plain || isNonFiscal(invoice.type)) return { buffer: await plain(), eInvoice: false }
  try {
    return { buffer: await generateZUGFeRD(invoice, issuer, { templateConfig }), eInvoice: true }
  } catch (err) {
    if (!opts.lenient) throw err
    logger.warn(`Rechnung ${invoice.invoiceNumber}: die E-Rechnung ließ sich nicht erzeugen (${(err as Error)?.message}) — es geht das PDF ohne XML hinaus`)
    return { buffer: await plain(), eInvoice: false }
  }
}
