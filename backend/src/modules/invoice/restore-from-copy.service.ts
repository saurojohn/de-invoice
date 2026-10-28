/**
 * Tier 733b — an invoice a restore lost, entered again from its kept copy.
 *
 * Tier 733 retires the number of an issued invoice whose kept copy came back
 * with the files but whose row the restored database dump does not have
 * (RetiredInvoiceNumber, reason `restore`). The customer holds that invoice;
 * the books must too, under its number. The copy carries everything: the
 * XRechnung kept next to the PDF (Tier 686), or the CII inside the ZUGFeRD
 * PDF. From it: the customer (found by VAT id, e-mail or name — or created
 * from the copy), the lines, dates, references, discount, Skonto, payment
 * method, § 13b / igL; the amounts are computed as for any invoice and must
 * equal the copy's to the cent, or nothing is stored. The invoice is created
 * with its number, issued (bookings as for any issued invoice) and keeps the
 * copy as its kept copy — the document the customer received. A credit note
 * goes the way of every credit note, against its invoice (BT-25), which has
 * to be in the books first.
 */
import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { CustomerService } from '../customer/customer.service'
import { StorageService } from '../storage/storage.service'
import { parseEInvoiceXml, type ParsedEInvoice } from '../expense/e-invoice/e-invoice-parser'
import { embeddedXmlFiles } from '../expense/e-invoice/pdf-embedded-xml'
import { computeInvoiceAmounts, toCents } from './invoice-amounts'
import { xrechnungPathOf } from './invoice-document'
import { InvoiceService } from './invoice.service'

/** UN/ECE Rec. 20 → the unit as the app writes it (the import dialog's list) */
const UNIT_OF: Record<string, string> = {
  C62: 'Stk', H87: 'Stk', XPP: 'Stk', HUR: 'Std', DAY: 'Tag', WEE: 'Woche', MON: 'Monat', ANN: 'Jahr', KGM: 'kg', GRM: 'g', TNE: 't',
  MTR: 'm', KMT: 'km', MTK: 'm²', MTQ: 'm³', LTR: 'l', KWH: 'kWh', MIN: 'Min', LS: 'pauschal', SET: 'Set', XBX: 'Karton',
}

export interface RetiredForCompany {
  invoiceNumber: string
  pdfPath: string | null
  foundAt: string
}

@Injectable()
export class RestoreFromCopyService {
  private readonly storage = new StorageService()

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoiceService,
    private readonly customers: CustomerService,
  ) {}

  /** the company's invoices a restore lost, not yet in the books again */
  async open(companyId: string): Promise<RetiredForCompany[]> {
    const rows = await this.prisma.retiredInvoiceNumber.findMany({
      where: { companyId, reason: 'restore', resolvedAt: null },
      orderBy: { invoiceNumber: 'asc' },
    })
    return rows.map((r) => ({ invoiceNumber: r.invoiceNumber, pdfPath: r.pdfPath, foundAt: r.createdAt.toISOString() }))
  }

  /** the kept copy itself (the PDF the customer received) */
  async copy(companyId: string, invoiceNumber: string): Promise<Buffer> {
    const row = await this.retired(companyId, invoiceNumber)
    const file = row.pdfPath ? await this.storage.getFile(row.pdfPath).catch(() => null) : null
    if (!file) throw new NotFoundException(`Die Kopie von ${invoiceNumber} ist nicht mehr im Speicher.`)
    return file.buffer
  }

  async restore(companyId: string, invoiceNumber: string): Promise<{ id: string; invoiceNumber: string; customerCreated: boolean }> {
    const row = await this.retired(companyId, invoiceNumber)
    const e = await this.readCopy(row.pdfPath, invoiceNumber)
    if (e.number !== invoiceNumber) {
      throw new UnprocessableEntityException(`Die Kopie trägt die Nummer ${e.number ?? '—'}, nicht ${invoiceNumber}.`)
    }
    const issueDate = e.issueDate
    if (!issueDate) throw new UnprocessableEntityException(`Die Kopie von ${invoiceNumber} nennt kein Rechnungsdatum.`)
    const discount = e.totals.allowances ?? 0
    const lines = e.lines.map((l) => ({
      description: (l.description || l.name || '').trim() || 'Position',
      quantity: l.quantity ?? 1,
      unit: (l.unit && UNIT_OF[l.unit]) || l.unit || undefined,
      unitPrice: l.unitPrice ?? (l.netAmount ?? 0),
      vatRate: (l.taxRate ?? 0) / 100,
    }))
    if (!lines.length) throw new UnprocessableEntityException(`Die Kopie von ${invoiceNumber} enthält keine Positionen.`)
    this.assertAmounts(invoiceNumber, e, lines, discount)

    if (e.creditNote || /^CN-/.test(invoiceNumber)) {
      const original = e.precedingInvoice
        ? await this.prisma.invoice.findFirst({ where: { companyId, invoiceNumber: e.precedingInvoice }, select: { id: true } })
        : null
      if (!original) {
        throw new UnprocessableEntityException(
          `${invoiceNumber} ist eine Gutschrift zu ${e.precedingInvoice ?? '—'}; diese Rechnung ist nicht in den Büchern — stellen Sie sie zuerst wieder her.`,
        )
      }
      // a credit note with a discount (a Storno of a discounted invoice) is
      // made as every credit note by amount is — the whole amount takes the
      // invoice's lines and discount over as they are
      const cn = await this.invoices.createCreditNote(original.id, companyId, {
        ...(discount > 0
          ? { amount: Math.abs(e.totals.gross ?? e.totals.payable ?? 0) }
          : { lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })) }),
        issueDate: new Date(`${issueDate}T00:00:00.000Z`),
        restoredNumber: invoiceNumber,
      })
      await this.keepTheCopy(cn.id, row.pdfPath)
      await this.resolve(companyId, invoiceNumber)
      return { id: cn.id, invoiceNumber, customerCreated: false }
    }
    if (!/^[A-Z]{1,10}-\d{4}-\d+$/.test(invoiceNumber) || /^(PI|RCV|AN|LS|AB)-/.test(invoiceNumber)) {
      throw new UnprocessableEntityException(`${invoiceNumber}: nur Rechnungen und Gutschriften lassen sich aus der Kopie wiederherstellen.`)
    }

    const { id: customerId, created } = await this.customerOf(companyId, e)
    const categories = new Set(e.taxGroups.map((g) => g.category))
    const invoice = await this.invoices.create(
      companyId,
      {
        customerId,
        issueDate,
        dueDate: e.dueDate ?? undefined,
        deliveryDate: e.deliveryDate ?? undefined,
        servicePeriodStart: e.periodStart ?? undefined,
        servicePeriodEnd: e.periodEnd ?? undefined,
        currency: e.currency ?? undefined,
        notes: e.notes[0] ?? undefined,
        discountAmount: discount > 0 ? discount : undefined,
        skontoPercent: e.skonto[0]?.percent,
        skontoDays: e.skonto[0]?.days,
        paymentMethod: paymentMethodOf(e.payment.meansCode, e.rawPaymentMeansName),
        orderReference: e.orderReference ?? undefined,
        buyerReference: e.buyerReference && e.buyerReference !== e.buyer.name && e.buyerReference !== 'N/A' ? e.buyerReference : undefined,
        reverseCharge: categories.has('AE') || undefined,
        euTransaction: categories.has('K') || undefined,
        items: lines,
      },
      undefined,
      { restoredNumber: invoiceNumber },
    )
    await this.invoices.updateStatus(invoice.id, companyId, 'sent')
    await this.keepTheCopy(invoice.id, row.pdfPath)
    await this.resolve(companyId, invoiceNumber)
    return { id: invoice.id, invoiceNumber, customerCreated: created }
  }

  private async retired(companyId: string, invoiceNumber: string) {
    const row = await this.prisma.retiredInvoiceNumber.findFirst({ where: { companyId, invoiceNumber, reason: 'restore', resolvedAt: null } })
    if (!row) throw new NotFoundException(`${invoiceNumber} ist keine verlorene Rechnung dieser Firma.`)
    return row
  }

  /** the copy's data: the kept XRechnung, else the XML inside the PDF */
  private async readCopy(pdfPath: string | null, invoiceNumber: string): Promise<ParsedEInvoice & { rawPaymentMeansName: string | null }> {
    const none = () => new UnprocessableEntityException(
      `Die Kopie von ${invoiceNumber} enthält keine Rechnungsdaten zum Einlesen — erfassen Sie die Rechnung anhand der PDF von Hand.`,
    )
    if (!pdfPath) throw none()
    let xml = (await this.storage.getFile(xrechnungPathOf(pdfPath)).catch(() => null))?.buffer.toString('utf8') ?? null
    if (!xml) {
      const pdf = await this.storage.getFile(pdfPath).catch(() => null)
      if (!pdf) throw new NotFoundException(`Die Kopie von ${invoiceNumber} ist nicht mehr im Speicher.`)
      xml = (await embeddedXmlFiles(pdf.buffer))[0]?.content.toString('utf8') ?? null
    }
    if (!xml) throw none()
    const parsed = parseEInvoiceXml(xml)
    if (parsed.errors.length) {
      throw new UnprocessableEntityException(`Die Kopie von ${invoiceNumber} lässt sich nicht lesen: ${parsed.errors.join('; ')}`)
    }
    // ec card and credit card share the code ZZZ; the name says which
    const name = /PaymentMeansCode[^>]*name="([^"]*)"/.exec(xml)?.[1] ?? null
    // the buyer's e-mail is its electronic address (BT-49, scheme EM) here
    const buyer = /<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>|<ram:BuyerTradeParty>[\s\S]*?<\/ram:BuyerTradeParty>/.exec(xml)?.[0] ?? ''
    const em = /(?:EndpointID|URIID) schemeID="EM">([^<]+)</.exec(buyer)?.[1]?.trim()
    if (!parsed.buyer.email && em) parsed.buyer.email = em
    return { ...parsed, rawPaymentMeansName: name }
  }

  /** computed as every invoice is, the amounts must be the copy's */
  private assertAmounts(invoiceNumber: string, e: ParsedEInvoice, lines: { quantity: number; unitPrice: number; vatRate: number }[], discount: number) {
    const a = computeInvoiceAmounts(lines, { discountAmount: discount > 0 ? discount : null })
    const gross = e.totals.gross ?? e.totals.payable
    const tax = e.totals.tax ?? 0
    if (gross == null || toCents(Math.abs(a.total)) !== toCents(Math.abs(gross)) || toCents(Math.abs(a.totalVat)) !== toCents(Math.abs(tax))) {
      throw new UnprocessableEntityException(
        `${invoiceNumber}: aus den Positionen der Kopie ergeben sich ${a.total.toFixed(2)} (USt ${a.totalVat.toFixed(2)}), ` +
          `die Kopie nennt ${gross?.toFixed(2) ?? '—'} (USt ${tax.toFixed(2)}) — nichts gespeichert; erfassen Sie die Rechnung von Hand.`,
      )
    }
  }

  private async customerOf(companyId: string, e: ParsedEInvoice): Promise<{ id: string; created: boolean }> {
    const b = e.buyer
    if (!b.name) throw new UnprocessableEntityException('Die Kopie nennt keinen Kunden.')
    const vat = b.vatId?.replace(/\s+/g, '').toUpperCase()
    const all = await this.prisma.customer.findMany({ where: { companyId }, select: { id: true, name: true, vatId: true, contact: true } })
    const byVat = vat ? all.filter((c) => c.vatId?.replace(/\s+/g, '').toUpperCase() === vat) : []
    if (byVat.length === 1) return { id: byVat[0].id, created: false }
    const email = b.email?.trim().toLowerCase()
    const byEmail = email ? all.filter((c) => String((c.contact as any)?.email ?? '').trim().toLowerCase() === email) : []
    if (byEmail.length === 1) return { id: byEmail[0].id, created: false }
    const byName = all.filter((c) => c.name.trim().toLowerCase() === b.name!.trim().toLowerCase())
    if (byName.length === 1) return { id: byName[0].id, created: false }
    if (byVat.length + byEmail.length + byName.length > 1) {
      throw new BadRequestException(`Mehrere Kunden passen zu „${b.name}“ — erfassen Sie die Rechnung von Hand.`)
    }
    const c = await this.customers.create(companyId, {
      name: b.name,
      type: 'business',
      ...(b.vatId ? { vatId: b.vatId } : {}),
      address: { street: b.street ?? '', postalCode: b.postalCode ?? '', city: b.city ?? '', country: b.country ?? 'DE' },
      contact: { ...(b.email ? { email: b.email } : {}), ...(b.contactName ? { name: b.contactName } : {}), ...(b.phone ? { phone: b.phone } : {}) },
    })
    return { id: c.id, created: true }
  }

  /** the copy is the document the customer received: it stays the kept copy */
  private async keepTheCopy(id: string, pdfPath: string | null) {
    if (pdfPath) await this.prisma.$executeRaw`UPDATE "Invoice" SET "pdfPath" = ${pdfPath} WHERE id = ${id}`
  }

  private async resolve(companyId: string, invoiceNumber: string) {
    await this.prisma.retiredInvoiceNumber.updateMany({ where: { companyId, invoiceNumber, reason: 'restore' }, data: { resolvedAt: new Date() } })
  }
}

/** UNTDID 4461 as written by paymentMeansOf (xrechnung.service.ts) */
function paymentMethodOf(code: string | null, name: string | null): string | undefined {
  if (code === '10') return 'cash'
  if (code === '68') return 'paypal'
  if (code === 'ZZZ') return /kredit/i.test(name ?? '') ? 'credit_card' : 'ec_card'
  return undefined
}
