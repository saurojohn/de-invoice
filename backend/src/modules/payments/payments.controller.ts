import { Controller, Get, Post, Body, Query, Param, Res, BadRequestException, Header } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { PaymentsService } from './payments.service'
import { Auth, Require } from '../../auth/roles.decorator'
import { HeaderAuthGuard } from '../../auth/header-auth.guard'
import { UseGuards } from '@nestjs/common'

/**
 * Tier 108: SEPA pain.001 batch payments.
 *
 * Three endpoints:
 *   GET  /api/v1/payments/unpaid   — list open payables
 *   POST /api/v1/payments/batches  — create a new batch
 *                                    from selected expense IDs
 *   GET  /api/v1/payments/batches/:id/xml  — download the
 *                                           pain.001 XML
 *   GET  /api/v1/payments/batches  — list past batches
 *
 * The flow:
 *   1. Berater opens /dashboard/payments, sees the
 *      unpaid expenses (sortable by supplier +
 *      invoice date), checks the ones to pay.
 *   2. Backend validates that every selected
 *      expense has a supplier with a valid IBAN.
 *   3. Backend generates a single pain.001 XML
 *      with all selected payments as one batch.
 *   4. Backend persists the batch (SepaBatch)
 *      and marks the expenses as paidAt =
 *      executionDate.
 *   5. Berater downloads the XML and uploads it
 *      to the bank's online banking portal.
 *   6. Bank settles the payments 1-2 days later.
 *   7. Bank statement auto-import (existing flow)
 *      reconciles the actual settlement against
 *      the planned batch.
 */
@Auth()
@Controller('payments')
@UseGuards(HeaderAuthGuard)
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('unpaid')
  @Require('expense.read')
  async listUnpaid(
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.payments.listUnpaidExpenses(companyId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('batches')
  @Require('expense.read')
  async listBatches(
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.payments.listBatches(companyId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('batches/:id')
  @Require('expense.read')
  async getBatch(@Param('id') id: string) {
    const batch = await this.payments.getBatch(id)
    if (!batch) {
      throw new BadRequestException('Batch nicht gefunden')
    }
    return batch
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('batches/:id/xml')
  @Require('expense.read')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async getBatchXml(
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
  ) {
    const batch = await this.payments.getBatch(id)
    if (!batch) {
      throw new BadRequestException('Batch nicht gefunden')
    }
    const filename = `SEPA_${batch.id}.xml`
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    )
    return batch.xmlContent
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('batches')
  @Require('expense.write')
  async createBatch(
    @Body()
    body: {
      companyId: string
      expenseIds: string[]
      executionDate: string
      notes?: string
      debtorIban?: string
      debtorBic?: string
      debtorName?: string
    },
  ) {
    if (!body || !body.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.payments.generateBatch(body.companyId, null, {
      expenseIds: body.expenseIds,
      executionDate: body.executionDate,
      notes: body.notes,
      debtorIban: body.debtorIban,
      debtorBic: body.debtorBic,
      debtorName: body.debtorName,
    })
  }
}
