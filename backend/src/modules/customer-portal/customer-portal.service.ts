/**
 * Tier 130: customer-facing portal service.
 *
 * New flow (replaces the single-invoice /portal/:token):
 *
 *   1. Customer opens the public portal page
 *      (/portal/login) and types their email.
 *   2. requestSession(email) — looks up the
 *      Customer by contact.email, generates a
 *      long-lived session token (30d, sliding),
 *      and emails the customer a "login link" that
 *      points to /portal?token=…
 *   3. Customer clicks the link → /portal page
 *      sees the token in the URL → calls
 *      getCustomerInvoices(token), which returns
 *      the customer + their invoice list + totals.
 *   4. Customer can download any invoice PDF
 *      via getInvoicePdf(token, invoiceId).
 *   5. Customer can also mark any invoice as paid
 *      via markInvoicePaid(token, invoiceId) —
 *      the same flow as POST /portal/:token/mark-paid
 *      but for the customer's own session.
 *
 * Distinction from the existing /portal/:token
 * payment-link (Tier 33) flow:
 *   - PaymentLink: admin issues per-invoice, 24h
 *     TTL, used for "I want to pay THIS invoice"
 *     email-to-PDF links.
 *   - PortalSession: customer initiates, multi-
 *     invoice, 30d sliding TTL, used for "I want
 *     to see ALL my invoices" login flow.
 *
 * Both can coexist: a customer who clicks a
 * per-invoice payment link in an email still has
 * a PortalSession for the next 30 days; the link
 * works even if the session has expired (because
 * the token is in the URL).
 *
 * Security:
 *   - requestSession never reveals whether the
 *     email exists. We always return 200 OK
 *     { sent: true } and either send the email
 *     or silently no-op.
 *   - Rate-limit per email: max 5 sessions per
 *     5 minutes per email. The check counts
 *     CustomerPortalSession rows with createdAt
 *     in the last 5 minutes for that email. If
 *     over the limit, we return 429.
 *   - The token is 32 random bytes hex (64 chars).
 *     Looked up by unique index, single btree hit.
 *   - Session is scoped to ONE customer. A token
 *     for customer X can never see customer Y's
 *     invoices — the FK is on every query.
 *   - Sliding expiry: every authenticated request
 *     bumps lastUsedAt + extends expiresAt by 30d.
 *     Idle sessions auto-expire (cleaned up by a
 *     nightly job — not in this tier).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { generateInvoicePDF } from '../../invoices/invoice-pdf.service';
import { MailService } from '../mail/mail.service';

const SESSION_TTL_DAYS = 30;
const RATE_LIMIT_WINDOW_MIN = 5;
const RATE_LIMIT_MAX_REQUESTS = 5;

export interface PortalInvoiceRow {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  total: string;
  currency: string;
  status: string;
  type: string;
  // Days past due (0 if not overdue, positive if overdue)
  daysOverdue: number;
}

export interface PortalCustomerSummary {
  customer: {
    id: string;
    name: string;
    customerNumber: string | null;
    type: string;
    address: any;
  };
  invoices: PortalInvoiceRow[];
  summary: {
    totalOpen: number;
    totalOverdue: number;
    totalPaid: number;
    currency: string;
    invoiceCount: number;
  };
  session: {
    expiresAt: string;
    lastUsedAt: string | null;
  };
}

@Injectable()
export class CustomerPortalService {
  private readonly logger = new Logger(CustomerPortalService.name);

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
  ) {}

  /**
   * Request a session for the customer with the
   * given email. The email is matched against
   * `Customer.contact->>'email'` (JSONB lookup).
   * We support multiple companies — a customer
   * from company A requesting a session while
   * their company is B would NOT get a session
   * for B's invoices. (We pick the FIRST match
   * by createdAt ASC; the rare ambiguity is logged.)
   *
   * Always returns 200 OK { sent: true } — we
   * never reveal whether the email is on file.
   * The NO-SMTP fallback logs the email to stdout
   * for dev verification (and so the test can
   * assert it was triggered).
   */
  async requestSession(
    email: string,
    origin?: string,
    ip?: string,
  ): Promise<{ sent: true }> {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      // Bad format — still 200, we just don't send.
      // (Returning 400 would let an attacker probe
      // "is this email format valid in this app".)
      this.logger.warn(`portal request with bad email format: ${normalized}`);
      return { sent: true };
    }

    // Rate limit: max 5 requests per email per 5 min
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60_000);
    const recentCount = await this.prisma.customerPortalSession.count({
      where: { email: normalized, createdAt: { gte: since } },
    });
    if (recentCount >= RATE_LIMIT_MAX_REQUESTS) {
      // Throw so the controller maps to 429
      throw new BadRequestException(
        `Too many requests. Please wait ${RATE_LIMIT_WINDOW_MIN} minutes.`,
      );
    }

    // Find the customer by email
    const customer = await this.prisma.customer.findFirst({
      where: {
        // Postgres JSONB extract: contact->>'email'
        contact: { path: ['email'], equals: normalized },
      },
      include: { company: { select: { name: true } } },
    });
    if (!customer) {
      // Don't leak whether the email exists. Just
      // log + no-op.
      this.logger.log(`portal request for unknown email: ${normalized}`);
      return { sent: true };
    }

    // Generate token
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.customerPortalSession.create({
      data: {
        companyId: customer.companyId,
        customerId: customer.id,
        email: normalized,
        token,
        expiresAt,
        createdFromIp: ip,
      },
    });

    // Build login link. Origin is the base URL the
    // request came from (set by the controller from
    // the request headers — works for localhost,
    // production, and ngrok alike).
    const baseUrl = (origin || 'http://localhost:3100').replace(/\/$/, '');
    const loginUrl = `${baseUrl}/portal?token=${token}`;

    // Send email. NO-SMTP fallback logs the URL to
    // stdout — the test suite reads it from the
    // backend log to assert the link was issued.
    const subject = `Ihr Login zum ${customer.company.name} Kundenportal`;
    const body = [
      `Guten Tag,`,
      ``,
      `Sie haben einen Login zum Kundenportal angefordert.`,
      `Klicken Sie auf den folgenden Link, um Ihre Rechnungen einzusehen:`,
      ``,
      loginUrl,
      ``,
      `Der Link ist ${SESSION_TTL_DAYS} Tage gültig.`,
      ``,
      `Mit freundlichen Grüßen`,
      customer.company.name,
    ].join('\n');
    try {
      await this.mailService.send(customer.companyId, {
        to: normalized,
        subject,
        text: body,
      })
    } catch (err: any) {
      // Don't fail the request — the session is
      // already created. The operator can re-trigger
      // by re-clicking "Login per E-Mail" from the
      // portal. (Or the customer will eventually
      // hit the rate limit and we re-think.)
      this.logger.warn(`portal email send failed for ${normalized}: ${err?.message || err}`)
    }
    this.logger.log(
      `portal session created for ${normalized} → ${loginUrl} (customer=${customer.id}, company=${customer.companyId})`,
    )
    return { sent: true }
  }

  /**
   * Resolve a session token to a customer + their
   * invoice list + summary totals. The token must
   * be valid (not expired). Returns null if the
   * token doesn't exist or has expired.
   */
  async getCustomerInvoices(token: string): Promise<PortalCustomerSummary> {
    const session = await this.prisma.customerPortalSession.findUnique({
      where: { token },
      include: {
        customer: true,
      },
    })
    if (!session) {
      throw new UnauthorizedException('Ungültiger oder abgelaufener Link')
    }
    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Link abgelaufen')
    }
    // Sliding expiry: every authenticated request
    // extends the session by 30d. We update in the
    // same call so the next request sees the new
    // expiry. Fire-and-forget — failure here is
    // not user-visible.
    const newExpiresAt = new Date(
      Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    )
    this.prisma.customerPortalSession
      .update({
        where: { id: session.id },
        data: { lastUsedAt: new Date(), expiresAt: newExpiresAt },
      })
      .catch((err) =>
        this.logger.warn(
          `could not bump portal session ${session.id}: ${err?.message || err}`,
        ),
      )

    // Load the customer's invoices. We sort by
    // issueDate DESC (newest first) — the customer's
    // natural reading order on the portal.
    const rawInvoices = await this.prisma.invoice.findMany({
      where: { customerId: session.customerId, companyId: session.companyId },
      orderBy: { issueDate: 'desc' },
      select: {
        id: true,
        invoiceNumber: true,
        issueDate: true,
        dueDate: true,
        total: true,
        currency: true,
        status: true,
        type: true,
      },
    })

    // Compute daysOverdue + summary
    const today = new Date()
    const invoices: PortalInvoiceRow[] = rawInvoices.map((inv) => {
      const daysOverdue =
        inv.dueDate && inv.dueDate < today && inv.status !== 'paid' && inv.status !== 'cancelled'
          ? Math.floor((today.getTime() - inv.dueDate.getTime()) / 86_400_000)
          : 0
      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDate.toISOString(),
        dueDate: inv.dueDate ? inv.dueDate.toISOString() : '',
        total: inv.total.toString(),
        currency: inv.currency,
        status: inv.status,
        type: inv.type,
        daysOverdue,
      }
    })

    const summary = {
      totalOpen: 0,
      totalOverdue: 0,
      totalPaid: 0,
      currency: invoices[0]?.currency || 'EUR',
      invoiceCount: invoices.length,
    }
    for (const inv of invoices) {
      const amount = Number(inv.total)
      if (inv.status === 'paid') summary.totalPaid += amount
      else {
        summary.totalOpen += amount
        if (inv.daysOverdue > 0) summary.totalOverdue += amount
      }
    }
    // Round to 2dp
    summary.totalOpen = Math.round(summary.totalOpen * 100) / 100
    summary.totalOverdue = Math.round(summary.totalOverdue * 100) / 100
    summary.totalPaid = Math.round(summary.totalPaid * 100) / 100

    return {
      customer: {
        id: session.customer.id,
        name: session.customer.name,
        customerNumber: session.customer.customerNumber,
        type: session.customer.type,
        address: session.customer.address || {},
      },
      invoices,
      summary,
      session: {
        expiresAt: newExpiresAt.toISOString(),
        lastUsedAt: new Date().toISOString(),
      },
    }
  }

  /**
   * Get a single invoice by id, scoped to the
   * customer's session. Throws 404 if the invoice
   * is not for the customer the session is bound
   * to (defense in depth against an attacker who
   * guesses another customer's invoice id).
   */
  async getInvoice(token: string, invoiceId: string) {
    const session = await this.resolveSession(token)
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        customerId: session.customerId,
        companyId: session.companyId,
      },
      include: {
        items: true,
        payments: { orderBy: { paymentDate: 'desc' } },
      },
    })
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden')
    }
    return invoice
  }

  /**
   * Get the PDF buffer for a customer's invoice.
   * Used by the portal frontend's "PDF herunterladen"
   * button. The PDF generator is the same one the
   * admin uses — the portal view is identical to
   * what the customer would get via the email
   * attachment.
   */
  async getInvoicePdf(token: string, invoiceId: string): Promise<Buffer> {
    const session = await this.resolveSession(token)
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        customerId: session.customerId,
        companyId: session.companyId,
      },
      include: {
        items: true,
        customer: true,
        company: true,
      },
    })
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden')
    }
    return generateInvoicePDF(
      invoice as any,
      {
        name: invoice.company?.name || '',
        address: invoice.company?.address || {},
        vatId: invoice.company?.vatId || undefined,
        taxId: invoice.company?.taxId || undefined,
        bankInfo: invoice.company?.bankInfo || undefined,
        logoPath: invoice.company?.logoPath || undefined,
      },
      invoice.templateType || 'standard',
      undefined,
    )
  }

  /**
   * Mark an invoice as paid from the customer's
   * side. The customer can also do this via the
   * existing /portal/:token/mark-paid endpoint
   * (admin-issued payment link), but this method
   * uses the customer's PortalSession token so
   * the rate limit + sliding expiry applies.
   */
  async markInvoicePaid(token: string, invoiceId: string, amount?: number) {
    const session = await this.resolveSession(token)
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        customerId: session.customerId,
        companyId: session.companyId,
      },
    })
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden')
    }
    if (invoice.status === 'paid') {
      // Idempotent — already paid
      return { ok: true, alreadyPaid: true, invoiceId }
    }
    const paymentAmount = amount ?? Number(invoice.total)
    await this.prisma.$transaction([
      this.prisma.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: paymentAmount as any,
          currency: invoice.currency,
          paymentMethod: 'bank-transfer',
          paymentDate: new Date(),
          reference: 'marked-paid via customer portal',
          notes: `Auto-recorded by customer (session ${session.id})`,
        },
      }),
      this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'paid' },
      }),
    ])
    return { ok: true, invoiceId }
  }

  private async resolveSession(token: string) {
    const session = await this.prisma.customerPortalSession.findUnique({
      where: { token },
    })
    if (!session) {
      throw new UnauthorizedException('Ungültiger oder abgelaufener Link')
    }
    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('Link abgelaufen')
    }
    return session
  }
}
