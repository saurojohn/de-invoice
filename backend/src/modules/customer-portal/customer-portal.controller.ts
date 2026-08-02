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
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CustomerPortalService } from './customer-portal.service';

@Controller('customer-portal')
export class CustomerPortalController {
  constructor(private readonly svc: CustomerPortalService) {}

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
