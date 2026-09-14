// Tier 33: Public portal routes + admin link-management.
//
// Public routes (NO @Auth() decorator — the token IS
// the authentication):
//   GET  /api/v1/portal/:token        → invoice + company
//   POST /api/v1/portal/:token/mark-paid
//
// Admin routes (authenticated, role-checked):
//   POST /api/v1/invoices/:id/generate-payment-link
//   POST /api/v1/invoices/:id/revoke-payment-links
//
// The two namespaces are separate on purpose — keeping
// admin endpoints under /invoices keeps the routing
// hierarchy understandable ("action on invoice X"),
// while the public surface lives under /portal.

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  BadRequestException,
} from '@nestjs/common'
import { Request } from 'express'
import { PortalService } from './portal.service'
import { Auth, Require } from '../../auth/roles.decorator'
import { Public } from '../../auth/public.decorator'

@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  /**
   * Public — token-only auth.
   * Returns a curated invoice view (no customer PII,
   * no other invoices, no internal notes). See
   * PortalService.getInvoiceByToken for the exact
   * field whitelist.
   *
   * ip() handler param is omitted because the
   * service does its own audit log via the IP arg.
   */
  @Public()
  @Get(':token')
  async view(
    @Param('token') token: string,
    @Req() req: Request,
  ) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.ip
      ?? undefined
    return this.portal.getInvoiceByToken(token, ip)
  }

  /**
   * Public — POST /portal/:token/mark-paid.
   * The customer clicks the button on the pay page.
   * Body is empty — the token alone is the auth.
   * Returns 200 with the payment receipt summary.
   */
  @Public()
  @Post(':token/mark-paid')
  async markPaid(@Param('token') token: string) {
    return this.portal.markPaid(token)
  }
}

/**
 * Admin-side link management, kept under /invoices
 * because the link is a property of the invoice.
 */
@Controller('invoices/:id')
@Auth()
export class InvoicePortalController {
  constructor(private readonly portal: PortalService) {}

  /**
   * POST /invoices/:id/generate-payment-link
   * Mint a new link (or reuse the active one).
   * Body: { origin?: string } — passed in by the
   * frontend so the returned URL has the right base.
   * If omitted, the controller builds an absolute URL
   * from the request.
   */
  @Post('generate-payment-link')
  @Require('invoice.update')
  async generate(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: { origin?: string },
    @Req() req: Request,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const origin = body?.origin ?? `${req.protocol}://${req.get('host')}`
    return this.portal.generateLink(id, companyId, origin)
  }

  /**
   * POST /invoices/:id/revoke-payment-links
   * Revoke all active links for the invoice. Returns
   * the count of links revoked. Admin-only.
   */
  @Post('revoke-payment-links')
  @Require('invoice.update')
  async revoke(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.portal.revokeLinks(id, companyId)
  }
}