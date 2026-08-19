// Tier 33: Customer self-service portal (Kundenportal).
//
// Flow:
//   1. Admin POST /api/v1/invoices/:id/generate-payment-link
//      → mints a PaymentLink row with a 32-byte hex token
//      and a +30d expiry. Returns {token, url, expiresAt}.
//   2. Admin pastes the URL into the email body or sends
//      it as a separate link.
//   3. Customer opens /portal/:token (no auth).
//      → GET /api/v1/portal/:token returns the invoice +
//        company summary (no other PII).
//   4. Customer clicks "Mark as paid" → POST /api/v1/portal/:token/mark-paid
//      → creates a Payment row (method='portal-mock'),
//        auto-bumps invoice to 'paid' if applicable,
//        sets usedAt on the link.
//
// What the portal endpoint MUST NOT leak:
//   - Internal notes (admin-only comments)
//   - Customer customerNumber / vatId / taxId
//   - Other invoices for the same customer
//   - The company's bank balance or any other data
//
// What it MAY show (the customer is paying this invoice,
// they need to see who they're paying):
//   - Company name + address (printed on the invoice anyway)
//   - Bank info (IBAN/BIC) — already on the PDF
//   - The invoice header + totals + line items

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { randomBytes } from 'crypto'
import { PrismaService } from '../../prisma/prisma.service'

const DEFAULT_EXPIRY_DAYS = 30
const PAYMENT_METHOD = 'portal-mock'

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name)

  constructor(private prisma: PrismaService) {}

  /**
   * Mint a new PaymentLink for the invoice. If the
   * invoice already has an active (non-expired,
   * non-revoked, non-used) link, return THAT one
   * instead of minting a duplicate — same URL,
   * same token. This is the "resend the link"
   * behaviour: idempotent.
   *
   * Token entropy: 16 random bytes = 128 bits. PG
   * btree token index makes lookup O(1); brute-forcing
   * 128-bit tokens is computationally out of reach.
   */
  async generateLink(invoiceId: string, companyId: string, origin?: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
    })
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden')
    }
    // Idempotency: if an existing link is still
    // active, reuse it. The admin click was
    // probably "I lost the URL, send again".
    const existing = await this.prisma.paymentLink.findFirst({
      where: {
        invoiceId,
        revokedAt: null,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      return {
        token: existing.token,
        url: this.tokenUrl(existing.token, origin),
        expiresAt: existing.expiresAt,
        reused: true,
      }
    }
    const token = randomBytes(16).toString('hex')
    const expiresAt = new Date(
      Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    )
    const link = await this.prisma.paymentLink.create({
      data: {
        invoiceId,
        token,
        expiresAt,
      },
    })
    this.logger.log(`PaymentLink minted: invoice=${invoiceId} expires=${expiresAt.toISOString()}`)
    return {
      token: link.token,
      url: this.tokenUrl(link.token, origin),
      expiresAt: link.expiresAt,
      reused: false,
    }
  }

  /**
   * Admin endpoint to invalidate the existing links
   * for an invoice. Used when the invoice was paid
   * outside the portal flow (e.g. bank transfer that
   * the customer phoned in), or when the link was
   * leaked publicly. We don't return the new token —
   * the admin can generate a fresh one.
   */
  async revokeLinks(invoiceId: string, companyId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
    })
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden')
    }
    const r = await this.prisma.paymentLink.updateMany({
      where: { invoiceId, revokedAt: null, usedAt: null },
      data: { revokedAt: new Date() },
    })
    return { revoked: r.count }
  }

  /**
   * Public portal route — no auth. Returns a curated
   * view of the invoice + company. Throws NotFound
   * if the token is unknown / expired / revoked /
   * used.
   *
   * `ip` is optional — when the controller forwards
   * req.ip, we log the access (cumulative on the row,
   * not overwriting previous hits). Helps the admin
   * spot link leaks later.
   */
  async getInvoiceByToken(token: string, ip?: string) {
    const link = await this.prisma.paymentLink.findUnique({
      where: { token },
      include: {
        invoice: {
          include: {
            items: { orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    })
    if (!link) {
      throw new NotFoundException('Link nicht gefunden')
    }
    if (link.usedAt) {
      throw new NotFoundException('Link wurde bereits verwendet')
    }
    if (link.revokedAt) {
      throw new NotFoundException('Link wurde widerrufen')
    }
    if (link.expiresAt <= new Date()) {
      throw new NotFoundException('Link ist abgelaufen')
    }
    const company = await this.prisma.company.findUnique({
      where: { id: link.invoice.companyId },
    })
    // IP log — append-only. PG text[] column.
    if (ip) {
      try {
        await this.prisma.$executeRaw`
          UPDATE "PaymentLink"
          SET "ipList" = array_append(COALESCE("ipList", ARRAY[]::text[]), ${ip})
          WHERE id = ${link.id}
        `
      } catch {
        // Column may not exist in old DB rows — ignore.
      }
    }
    return {
      invoice: {
        invoiceNumber: link.invoice.invoiceNumber,
        issueDate: link.invoice.issueDate,
        dueDate: link.invoice.dueDate,
        currency: link.invoice.currency,
        subtotal: link.invoice.subtotal.toString(),
        totalVat: link.invoice.totalVat.toString(),
        total: link.invoice.total.toString(),
        status: link.invoice.status,
        customerName: link.invoice.customerName,
        language: link.invoice.language,
        items: link.invoice.items.map((it: any) => ({
          description: it.description,
          quantity: it.quantity.toString(),
          unit: it.unit,
          unitPrice: it.unitPrice.toString(),
          vatRate: it.vatRate.toString(),
        })),
      },
      company: company
        ? {
            name: company.name,
            address: company.address ?? {},
            bankInfo: company.bankInfo ?? null,
            vatId: company.vatId ?? null,
            taxId: company.taxId ?? null,
            // Contact email for invoice questions (not
            // a separate "reply to" — just a human
            // contact).
            email: (company as any).email ?? null,
          }
        : null,
      link: {
        createdAt: link.createdAt,
        expiresAt: link.expiresAt,
      },
    }
  }

  /**
   * Mark the invoice as paid via the portal link.
   * Mints a Payment row with method='portal-mock'
   * and amount=invoice.total. The PaymentService
   * auto-bumps the invoice to 'paid' if the total
   * covers the invoice. The link gets usedAt set so
   * subsequent hits see "link consumed".
   *
   * Idempotency: if usedAt is already set, we treat
   * it as success — same response shape, but the
   * existing Payment record stays untouched. The
   * second customer click on the disabled page
   * should NOT mint a duplicate Payment.
   */
  async markPaid(token: string) {
    const link = await this.prisma.paymentLink.findUnique({
      where: { token },
      include: { invoice: true },
    })
    if (!link) {
      throw new NotFoundException('Link nicht gefunden')
    }
    if (link.revokedAt) {
      throw new BadRequestException('Link wurde widerrufen')
    }
    if (link.expiresAt <= new Date()) {
      throw new BadRequestException('Link ist abgelaufen')
    }
    if (link.usedAt) {
      // Idempotent success — already paid.
      const existingPayment = await this.prisma.payment.findFirst({
        where: { invoiceId: link.invoiceId, paymentMethod: PAYMENT_METHOD },
      })
      return {
        alreadyPaid: true,
        paidAt: link.usedAt,
        paymentId: existingPayment?.id ?? null,
        invoiceId: link.invoiceId,
        invoiceNumber: link.invoice.invoiceNumber,
        amount: existingPayment?.amount?.toString() ?? link.invoice.total.toString(),
      }
    }
    // Use a transaction so we don't mint a Payment
    // row without flipping the link to used.
    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          invoiceId: link.invoiceId,
          amount: link.invoice.total,
          currency: link.invoice.currency,
          paymentDate: new Date(),
          paymentMethod: PAYMENT_METHOD,
          reference: 'portal-mock-self-service',
          notes: 'Marked as paid by the customer via the Kundenportal link.',
        },
      })
      await tx.paymentLink.update({
        where: { id: link.id },
        data: { usedAt: new Date() },
      })
      return payment
    })
    // Auto-bump invoice to 'paid' when fully covered.
    // Mirror the PaymentService logic — the invoice
    // controller's POST /payments does this, so we
    // do it here too. CN excluded (same rule).
    const payments = await this.prisma.payment.findMany({
      where: { invoiceId: link.invoiceId },
      select: { amount: true },
    })
    const totalPaid = payments.reduce(
      (s, p) => s.plus(p.amount ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    ).toNumber()
    const invoiceTotal = Number(link.invoice.total)
    if (link.invoice.type === 'INV' && totalPaid >= invoiceTotal - 0.01) {
      await this.prisma.invoice.update({
        where: { id: link.invoiceId },
        data: { status: 'paid' },
      })
    }
    this.logger.log(
      `PaymentLink used: token=${token.slice(0, 8)}… invoice=${link.invoice.invoiceNumber}`,
    )
    return {
      alreadyPaid: false,
      paidAt: result.paymentDate ?? new Date(),
      paymentId: result.id,
      invoiceId: link.invoiceId,
      invoiceNumber: link.invoice.invoiceNumber,
      amount: result.amount.toString(),
    }
  }

  private tokenUrl(token: string, origin?: string): string {
    const base = (origin ?? '').replace(/\/$/, '')
    return `${base}/pay/${token}`
  }
}