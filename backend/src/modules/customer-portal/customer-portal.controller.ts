/**
 * Tier 130: customer-facing portal controller.
 *
 * Routes:
 *   POST /api/v1/customer-portal/request-session
 *     body { email: string }
 *     → { sent: true }
 *     Public — no auth. Rate-limited per email
 *     (5 requests per 5 min). Always returns 200
 *     even if the email is not on file (to avoid
 *     leaking which addresses are customers).
 *
 *   GET /api/v1/customer-portal/invoices?token=…
 *     → PortalCustomerSummary
 *     Token-auth (the session token, NOT the
 *     user's auth header — this is the public
 *     portal). Returns 401 if the token is
 *     missing/expired.
 *
 *   GET /api/v1/customer-portal/invoice/:id?token=…
 *     → Invoice + items + payments
 *     Token-auth. 404 if the invoice isn't for
 *     the customer the session is bound to
 *     (defense in depth).
 *
 *   GET /api/v1/customer-portal/invoice/:id/pdf?token=…
 *     → application/pdf
 *     Token-auth. Same 404 rule.
 *
 *   POST /api/v1/customer-portal/invoice/:id/mark-paid?token=…
 *     body { amount?: number }
 *     → { ok: true }
 *     Token-auth. Records a Payment + flips the
 *     invoice to 'paid'. Idempotent.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CustomerPortalService } from './customer-portal.service';
// Tier 132: admin endpoints sit behind the auth
// guard (HeaderAuthGuard + @Require). They bypass
// the public rate-limit because the operator is
// the trust boundary, not a random visitor.
import { Auth, Require } from '../../auth/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('customer-portal')
export class CustomerPortalController {
  constructor(
    private readonly svc: CustomerPortalService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('request-session')
  async requestSession(
    @Req() req: Request,
    @Query('email') email?: string,
  ) {
    if (!email && req.body && typeof req.body === 'object' && (req.body as any).email) {
      email = (req.body as any).email
    }
    if (!email || typeof email !== 'string') {
      throw new BadRequestException('email is required')
    }
    const origin = this.originFromRequest(req)
    const ip = this.ipFromRequest(req)
    return this.svc.requestSession(email, origin, ip)
  }

  @Get('invoices')
  async getInvoices(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('token is required')
    }
    return this.svc.getCustomerInvoices(token)
  }

  @Get('invoice/:id')
  async getInvoice(
    @Param('id') id: string,
    @Query('token') token: string,
  ) {
    if (!token) {
      throw new BadRequestException('token is required')
    }
    return this.svc.getInvoice(token, id)
  }

  @Get('invoice/:id/pdf')
  @Header('Content-Type', 'application/pdf')
  async getInvoicePdf(
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    if (!token) {
      throw new BadRequestException('token is required')
    }
    const invoice = await this.svc.getInvoice(token, id)
    const pdf = await this.svc.getInvoicePdf(token, id)
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${invoice.invoiceNumber}.pdf"`,
    )
    res.send(pdf)
  }

  @Post('invoice/:id/mark-paid')
  async markPaid(
    @Param('id') id: string,
    @Query('token') token: string,
    @Req() req: Request,
  ) {
    if (!token) {
      throw new BadRequestException('token is required')
    }
    const amount =
      req.body && typeof req.body === 'object' && (req.body as any).amount
        ? Number((req.body as any).amount)
        : undefined
    return this.svc.markInvoicePaid(token, id, amount)
  }

  /**
   * Tier 155: profile editing. The customer can
   * update their own contact info (name, email,
   * phone) and billing address from the portal.
   * Token-auth (same as the rest of the
   * customer-portal routes). The customer is
   * bound to the session, so they can ONLY
   * update their own row — no way to specify
   * a different customerId.
   *
   * Declared BEFORE the `invoice/:id` route per
   * the NestJS first-match-wins gotcha. The path
   * segment is `profile` so it can't collide
   * with `invoice/:id` anyway, but keeping the
   * convention tidy.
   */
  @Get('profile')
  async getProfile(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('token is required')
    }
    return this.svc.getCustomerProfile(token)
  }

  @Patch('profile')
  @HttpCode(200)
  async updateProfile(
    @Query('token') token: string,
    @Body() body: {
      name?: string
      vatId?: string | null
      // The contact object is partial —
      // omitted keys are preserved. The frontend
      // sends the whole shape so it's easier to
      // reason about; we still merge here so a
      // partial POST (e.g. just the email) works.
      contact?: {
        email?: string | null
        phone?: string | null
        name?: string | null
      }
      address?: {
        street?: string | null
        postalCode?: string | null
        city?: string | null
        country?: string | null
      }
    },
  ) {
    if (!token) {
      throw new BadRequestException('token is required')
    }
    return this.svc.updateCustomerProfile(token, body || {})
  }

  // ─── Admin endpoints (Tier 132) ──────────────────────
  // Operator can generate a portal session for a
  // specific customer — used by the "Portal-Login
  // senden" button on the customer detail page. Bypasses
  // the public rate-limit (operator is the trust
  // boundary). Returns the full URL the admin can
  // copy + paste into an email / WhatsApp.
  @Auth()
  @Post('admin/create-session')
  @Require('customer.update')
  async adminCreateSession(
    @Body() body: { customerId?: string; companyId?: string },
    @Req() req: Request,
  ) {
    if (!body?.customerId) {
      throw new BadRequestException('customerId is required')
    }
    // Look up the customer's contact.email. The
    // service.requestSession takes the email and
    // does the rate-limit + token generation. We
    // intentionally don't have a per-customerId rate
    // limit here (admin clicks = low frequency) —
    // the public email path's limit is what protects
    // against abuse.
    const customer = await this.prisma.customer.findFirst({
      where: {
        id: body.customerId,
        companyId: body.companyId,
      },
    })
    if (!customer) {
      throw new BadRequestException('Kunde nicht gefunden')
    }
    const email = (customer.contact as any)?.email
    if (!email) {
      throw new BadRequestException('Kunde hat keine E-Mail-Adresse hinterlegt')
    }
    const origin = this.originFromRequest(req)
    const result = await this.svc.requestSession(
      email,
      origin,
      req.ip as string,
      // Tier 291: pass customerId so the service's
      // findFirst scopes to the right (customer, email)
      // pair when the same email is shared across
      // multiple companies. Without this, the wrong
      // company's customer row could win the lookup and
      // the resulting session would be invisible to the
      // controller's (customerId, companyId)-scoped
      // re-read, producing url=null.
      customer.id,
    )
    // requestSession always returns { sent: true } —
    // we need the actual URL to give the admin. Re-read
    // the latest session row.
    // Tier 207 — HIGH-001 from the code audit.
    // The previous version filtered only by
    // `email` (no `companyId` / `customerId`).
    // If the same email is used by a customer in
    // two different companies (e.g. a freelancer
    // who is a customer of two Mandanten), the
    // returned URL pointed to whichever company
    // generated the most recent session — NOT the
    // one the admin clicked from. The admin would
    // email the wrong-company login URL to the
    // customer. Fix: filter by `customerId` and
    // `companyId` so the freshest session for THIS
    // specific (customer, company) pair is returned.
    const latest = await this.prisma.customerPortalSession.findFirst({
      where: {
        email: email.toLowerCase(),
        customerId: customer.id,
        companyId: body.companyId,
      },
      orderBy: { createdAt: 'desc' },
    })
    const url = latest
      ? `${origin.replace(/\/$/, '')}/portal?token=${latest.token}`
      : null
    return {
      ...result,
      url,
      email,
      customerId: customer.id,
      expiresAt: latest?.expiresAt,
    }
  }

  private originFromRequest(req: Request): string {
    const proto =
      (req.headers['x-forwarded-proto'] as string)?.split(',')[0] ||
      (req as any).protocol ||
      'http'
    const host =
      (req.headers['x-forwarded-host'] as string)?.split(',')[0] ||
      (req.headers.host as string) ||
      'localhost:3100'
    return `${proto}://${host}`
  }

  private ipFromRequest(req: Request): string | undefined {
    const fwd = req.headers['x-forwarded-for'] as string
    if (fwd) return fwd.split(',')[0].trim()
    return (req as any).ip || (req.socket as any)?.remoteAddress
  }
}
