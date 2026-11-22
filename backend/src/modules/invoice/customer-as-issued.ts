/**
 * Tier 928 — the customer as on the day of issue.
 *
 * The UStVA, the ZM, the OSS return and the DATEV export classify a sale by
 * the customer's country and VAT id (an igL, a § 13b supply, a sale to a
 * consumer abroad, an export). They read them from the customer — so a later
 * move or a VAT id added changed a return already submitted. Measured: a sale
 * to a consumer in Paris, its month submitted (Kz 45, OSS); the customer moved
 * to Köln — the month's return said Kz 35 / 36, domestic tax.
 *
 * An invoice keeps both from the day it is issued (`Invoice.customerCountry`,
 * `customerVatId`); `asIssued` lays them over the customer it was read with.
 * A draft (none kept yet) reads the customer as it is.
 */
type Db = { customer: { findUnique: (a: any) => Promise<{ address: unknown; vatId: string | null } | null> } }

export const AS_ISSUED_SELECT = { customerCountry: true, customerVatId: true } as const

/** the customer's country and VAT id now — to be kept on an invoice when it is issued */
export async function customerSnapshot(db: Db, customerId: string | null | undefined): Promise<{ customerCountry: string; customerVatId: string | null }> {
  const c = customerId ? await db.customer.findUnique({ where: { id: customerId }, select: { address: true, vatId: true } }) : null
  const address = c?.address && typeof c.address === 'object' && !Array.isArray(c.address) ? (c.address as Record<string, unknown>) : {}
  const country = typeof address.country === 'string' ? address.country : ''
  return { customerCountry: country, customerVatId: c?.vatId ?? null }
}

/** the document with its customer as on the day of issue (where kept) */
export function asIssued<T>(doc: T): T {
  const d = doc as unknown as { customer?: Record<string, unknown> | null; customerCountry?: string | null; customerVatId?: string | null }
  if (d.customerCountry == null || !d.customer) return doc
  const address = d.customer.address && typeof d.customer.address === 'object' && !Array.isArray(d.customer.address)
    ? (d.customer.address as Record<string, unknown>)
    : {}
  return { ...d, customer: { ...d.customer, address: { ...address, country: d.customerCountry }, vatId: d.customerVatId ?? null } } as unknown as T
}
