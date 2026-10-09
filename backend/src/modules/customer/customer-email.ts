import { Prisma } from '@prisma/client'

/**
 * Tier 631 — a customer's e-mail address is its login to the customer
 * portal (a session link is sent to it). Creating a customer has always
 * refused an address another customer of the company has; changing one did
 * not — neither in the company's own form nor, measured, in the portal,
 * where a customer could take another customer's address. Compared without
 * regard to case: the portal stores an address as typed.
 */
export async function emailOfAnotherCustomer(
  prisma: { $queryRaw: (query: Prisma.Sql) => Promise<unknown> },
  companyId: string,
  email: string | null | undefined,
  exceptCustomerId: string,
): Promise<boolean> {
  const wanted = (email ?? '').trim().toLowerCase()
  if (!wanted) return false
  const rows = (await prisma.$queryRaw(Prisma.sql`
    SELECT 1 FROM "Customer"
    WHERE "companyId" = ${companyId} AND id <> ${exceptCustomerId}
      AND lower(trim(contact->>'email')) = ${wanted}
    LIMIT 1`)) as unknown[]
  return rows.length > 0
}

/** true when `next` is another address than `current` (case and blanks aside) */
export const emailChanges = (current: unknown, next: unknown): boolean =>
  String(next ?? '').trim().toLowerCase() !== String(current ?? '').trim().toLowerCase()
