import type { InvoiceRenderConfig } from '../../invoices/invoice-pdf.service'

/** The company as the renderer reads it: letterhead, Impressum, bank. */
export function issuerContext(company: any, templateConfig?: InvoiceRenderConfig) {
  return {
    name: company?.name || '',
    defaultVatMode: company?.defaultVatMode ?? null, // Tier 482
    legalName: company?.legalName || undefined,
    rechtsform: company?.rechtsform ?? (company?.settings as any)?.rechtsform ?? null, // Tier 728i
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
