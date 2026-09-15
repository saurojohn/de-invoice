import {
  Headers,
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  Res,
  BadRequestException,
  Header,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { DirectDebitService } from './direct-debit.service'
import { CreateMandateDto, CreateDirectDebitBatchDto } from './dto/sepa.dto'
import { Auth, Require } from '../../auth/roles.decorator'
import { HeaderAuthGuard } from '../../auth/header-auth.guard'
import { UseGuards } from '@nestjs/common'

/**
 * Tier 112: SEPA pain.008 (Lastschrift / Direct Debit)
 * HTTP endpoints.
 *
 *   GET    /api/v1/payments/mandates                  — list mandates
 *   POST   /api/v1/payments/mandates                  — create mandate
 *   DELETE /api/v1/payments/mandates/:id              — revoke mandate
 *   GET    /api/v1/payments/direct-debit/open         — list open invoices
 *   POST   /api/v1/payments/direct-debit/batches      — create batch
 *   GET    /api/v1/payments/direct-debit/batches      — list past batches
 *   GET    /api/v1/payments/direct-debit/batches/:id  — get one batch
 *   GET    /api/v1/payments/direct-debit/batches/:id/xml
 *                                                    — download pain.008 XML
 *
 * The flow:
 *   1. Berater issues invoices (existing flow).
 *   2. Customer signs a SEPA-Lastschriftmandat
 *      (paper or in-app). Berater records it via
 *      POST /payments/mandates.
 *   3. Some time later (e.g. dueDate minus 5 days),
 *      Berater opens /dashboard/payments/direct-debit,
 *      sees the open invoices eligible for collection
 *      (status sent/overdue + has active mandate).
 *   4. Berater selects the invoices to collect, picks
 *      an execution date, clicks "Lastschrift erzeugen".
 *   5. Backend validates (mandate active, IBAN valid,
 *      creditor info set), generates pain.008.001.02
 *      XML, persists the batch + collections + marks
 *      the invoices as collected.
 *   6. Berater downloads the XML and uploads it to
 *      the bank's online banking portal.
 *   7. Bank settles the direct debits T+1 (B2B) or
 *      T+1 (CORE). Bank statement auto-import
 *      (existing flow) reconciles the actual
 *      settlement against the planned batch.
 */
@Auth()
@Controller('payments')
@UseGuards(HeaderAuthGuard)
export class DirectDebitController {
  constructor(private directDebit: DirectDebitService) {}

  // ─── Mandates ─────────────────────────────────────────────

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('mandates')
  @Require('customer.read')
  async listMandates(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.directDebit.listMandates(companyId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('mandates')
  @Require('customer.create')
  async createMandate(
    @Body() body: CreateMandateDto,
  ) {
    if (!body || !body.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!body.customerId) {
      throw new BadRequestException('customerId ist erforderlich')
    }
    if (!body.dateOfSignature) {
      throw new BadRequestException('dateOfSignature ist erforderlich (YYYY-MM-DD)')
    }
    if (!body.iban) {
      throw new BadRequestException('IBAN ist erforderlich')
    }
    if (!body.debitorName) {
      throw new BadRequestException('debitorName ist erforderlich')
    }
    return this.directDebit.createMandate(body.companyId, {
      customerId: body.customerId,
      mandateReference: body.mandateReference,
      dateOfSignature: body.dateOfSignature,
      type: body.type,
      iban: body.iban,
      bic: body.bic,
      debitorName: body.debitorName,
      description: body.description,
    })
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Delete('mandates/:id')
  @Require('customer.update')
  async revokeMandate(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('reason') reason?: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.directDebit.revokeMandate(companyId, id, reason)
  }

  // ─── Direct-debit batch flow ──────────────────────────────

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('direct-debit/open')
  @Require('invoice.read')
  async listOpenInvoices(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.directDebit.listOpenInvoices(companyId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('direct-debit/batches')
  @Require('invoice.read')
  async listBatches(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.directDebit.listBatches(companyId)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('direct-debit/batches/:id')
  @Require('invoice.read')
  async getBatch(@Param('id') id: string, @Headers('x-company-id') companyId: string) {
    const batch = await this.directDebit.getBatch(companyId, id)
    if (!batch) {
      throw new BadRequestException('Lastschrift-Batch nicht gefunden')
    }
    return batch
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('direct-debit/batches/:id/xml')
  @Require('invoice.read')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async getBatchXml(
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Headers('x-company-id') companyId: string,
  ) {
    const batch = await this.directDebit.getBatch(companyId, id)
    if (!batch) {
      throw new BadRequestException('Lastschrift-Batch nicht gefunden')
    }
    const filename = `SEPA-Lastschrift_${batch.id}.xml`
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    )
    return batch.xmlContent
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('direct-debit/batches')
  @Require('invoice.write')
  async createBatch(
    @Body() body: CreateDirectDebitBatchDto,
  ) {
    if (!body || !body.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.directDebit.generateBatch(body.companyId, {
      collections: body.collections,
      executionDate: body.executionDate,
      type: body.type,
      notes: body.notes,
      creditorIban: body.creditorIban,
      creditorBic: body.creditorBic,
      creditorName: body.creditorName,
      creditorIdentifier: body.creditorIdentifier,
    })
  }
}
