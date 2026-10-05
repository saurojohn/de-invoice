/**
 * Tier 520 — the stock an invoice has taken.
 *
 * Measured before: stock was reduced when a *draft* was created and never
 * again — editing the draft's quantity, deleting it, cancelling the issued
 * invoice all left the stock where it was (10 → 7 → 7 → 7); selling more than
 * there was set the stock to 0 while the history said "sale 50", so nothing
 * could be put back; and the product was looked up by id alone — another
 * company's invoice reduced this company's stock and its stock warning showed
 * the product's name and quantity.
 *
 * Now the stock follows the issued invoice: goods leave when the invoice is
 * issued, come back when it is cancelled or deleted, and follow an edit of
 * its lines. `syncInvoiceStock` compares what the invoice should hold
 * (quantity per tracked product of this company, for an issued INV) with what
 * the history says it holds, and books the difference — so it is safe to call
 * after any change, and a draft from before this tier gives its stock back
 * the next time it is touched. Stock may go below 0: that is an oversold
 * product, and the number says by how much.
 *
 * A credit note does not move stock — it may correct a price; goods that came
 * back are entered as a return on the inventory page.
 */
type Db = any

const round4 = (n: number) => Math.round(n * 10000) / 10000

/** Types whose lines are goods leaving the warehouse. */
const moves = (type: string) => type !== 'CN' && type !== 'PI'

export async function syncInvoiceStock(
  db: Db,
  companyId: string,
  invoiceId: string,
  opts: { gone?: boolean; label?: string } = {},
): Promise<void> {
  const invoice = opts.gone
    ? null
    : await db.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { type: true, status: true, invoiceNumber: true, items: { select: { productId: true, quantity: true } } },
    })
  const label = opts.label ?? invoice?.invoiceNumber ?? invoiceId

  const wanted = new Map<string, number>()
  if (invoice && moves(invoice.type) && invoice.status !== 'draft' && invoice.status !== 'cancelled') {
    for (const it of invoice.items) {
      if (!it.productId) continue
      wanted.set(it.productId, round4((wanted.get(it.productId) ?? 0) + Number(it.quantity)))
    }
  }

  // What the history says this invoice holds: the effect of each row
  // (previousQty − newQty), which is also right for a clamped row of before.
  const rows: Array<{ productId: string; previousQty: unknown; newQty: unknown }> = await db.productStockHistory.findMany({
    where: { reference: invoiceId, referenceType: 'invoice', product: { companyId } },
    select: { productId: true, previousQty: true, newQty: true },
  })
  const held = new Map<string, number>()
  for (const r of rows) {
    held.set(r.productId, round4((held.get(r.productId) ?? 0) + Number(r.previousQty) - Number(r.newQty)))
  }

  for (const productId of new Set([...wanted.keys(), ...held.keys()])) {
    const product = await db.product.findFirst({
      where: { id: productId, companyId },
      select: { trackInventory: true, stockQuantity: true },
    })
    if (!product) continue
    // A product no longer tracked takes nothing more, but gives back what it holds.
    const target = product.trackInventory ? wanted.get(productId) ?? 0 : 0
    const delta = round4(target - (held.get(productId) ?? 0))
    if (delta === 0) continue
    const previousQty = Number(product.stockQuantity)
    const newQty = round4(previousQty - delta)
    await db.product.update({ where: { id: productId }, data: { stockQuantity: newQty } })
    await db.productStockHistory.create({
      data: {
        productId,
        changeType: delta > 0 ? 'sale' : 'return',
        quantity: Math.abs(delta),
        previousQty,
        newQty,
        reference: invoiceId,
        referenceType: 'invoice',
        notes: delta > 0
          ? `Bestandsreduzierung durch Rechnung ${label}`
          : `Bestand zurück aus Rechnung ${label}`,
      },
    })
  }
}
