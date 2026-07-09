import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { HeaderAuthGuard } from '../../auth/header-auth.guard'
import { Require } from '../../auth/roles.decorator'
import {
  CreateInstallmentPlanDto,
  PayInstallmentDto,
} from './installment-plan.dto'
import { InstallmentPlanService } from './installment-plan.service'

/**
 * Tier 51: Ratenzahlung (installment payment plans)
 * REST surface. Mounted at /api/v1/installment-plans.
 *
 * Endpoints:
 *   GET  /                     list all plans (?status=active)
 *   GET  /:id                  single plan + Raten
 *   GET  /for-customer/:cid    open plans for a customer
 *   POST /                     create plan on an Invoice
 *   POST /:id/installments/:iid/pay  mark a Rate as paid
 *   DELETE /:id                soft-cancel a plan
 *
 * The `pay` endpoint is POST (not PATCH) because
 * a payment is an event, not a state mutation —
 * mirrors the existing `/payments` endpoint
 * pattern.
 */
@Controller('installment-plans')
@UseGuards(HeaderAuthGuard)
export class InstallmentPlanController {
  constructor(private svc: InstallmentPlanService) {}

  @Get()
  @Require('invoice.read')
  async list(
    @Query('companyId') companyId: string,
    @Query('status') status?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.list(companyId, status)
  }

  @Get('for-customer/:customerId')
  @Require('invoice.read')
  async listForCustomer(
    @Param('customerId') customerId: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.listForCustomer(customerId, companyId)
  }

  // Per-invoice lookup. Returns the (one) Ratenplan
  // attached to an Invoice, or null. Used by the
  // invoice detail page to render the Raten schedule
  // without scanning every active plan.
  @Get('by-invoice/:invoiceId')
  @Require('invoice.read')
  async findByInvoice(
    @Param('invoiceId') invoiceId: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.findByInvoice(invoiceId, companyId)
  }

  @Get(':id')
  @Require('invoice.read')
  async findOne(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.findOne(id, companyId)
  }

  @Post()
  @Require('invoice.write')
  async create(
    @Body() dto: CreateInstallmentPlanDto,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.create(companyId, dto)
  }

  @Post(':id/installments/:installmentId/pay')
  @Require('invoice.write')
  async payInstallment(
    @Param('id') id: string,
    @Param('installmentId') installmentId: string,
    @Body() dto: PayInstallmentDto,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.payInstallment(id, installmentId, companyId, dto)
  }

  @Delete(':id')
  @Require('invoice.write')
  async cancel(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.cancel(id, companyId)
  }
}
