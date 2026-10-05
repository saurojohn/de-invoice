/**
 * Tier 510 — a Mahnungspause holds every reminder, not only the automatic
 * ones.
 *
 * A pause (Tier 64) is set when dunning must stop — a dispute, an agreed
 * delay. findOverdueInvoices (the list, the automatic run) respected it; the
 * send paths did not: "Mahnung senden" on the invoice page and the bulk run
 * dunned a paused invoice or a paused customer's invoice, with fees.
 *
 * The active pause on the invoice or on its customer, if any. A pause an
 * installment plan set is not one (the plan decides, Tier 500).
 */
export async function activePause(
  prisma: any,
  companyId: string,
  invoiceId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<{ reason: string; pausedUntil: Date | null; scope: 'invoice' | 'customer' } | null> {
  const row = await prisma.mahnungspause.findFirst({
    where: {
      companyId,
      cancelledAt: null,
      installmentPlanId: null,
      pausedFrom: { lte: now },
      AND: [
        { OR: [{ pausedUntil: null }, { pausedUntil: { gte: now } }] },
        { OR: [{ invoiceId }, { customerId }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { reason: true, pausedUntil: true, invoiceId: true },
  })
  return row ? { reason: row.reason, pausedUntil: row.pausedUntil, scope: row.invoiceId ? 'invoice' : 'customer' } : null
}

export function pauseHoldMessage(p: { reason: string; pausedUntil: Date | null; scope: 'invoice' | 'customer' }): string {
  const until = p.pausedUntil ? ` bis ${new Date(p.pausedUntil).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}` : ''
  const what = p.scope === 'invoice' ? 'diese Rechnung' : 'diesen Kunden'
  return `Für ${what} besteht eine Mahnungspause${until} (${p.reason}) — sie wird nicht gemahnt. Pause beenden, um zu mahnen.`
}
