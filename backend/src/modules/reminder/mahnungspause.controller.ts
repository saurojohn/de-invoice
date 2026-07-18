import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common'
import { MahnungspauseService } from './mahnungspause.service'
import { Auth, Require } from '../../auth/roles.decorator'

/**
 * Tier 64: Mahnungspause HTTP API.
 *
 * Endpoints:
 *   GET    /api/v1/mahnungspausen          list (filter by customerId, activeOnly)
 *   POST   /api/v1/mahnungspausen          create
 *   PATCH  /api/v1/mahnungspausen/:id      update pausedUntil / reason
 *   DELETE /api/v1/mahnungspausen/:id      soft-cancel
 *
 * Authorization: mirrors the existing ReminderController
 * — GET = invoice.read, mutations = invoice.update.
 * (We don't have a dedicated `reminder.*` permission in
 * the RBAC table; the existing Mahnung endpoints all
 * use `invoice.*` because Mahnungen are part of the
 * invoice lifecycle.)
 */
@Auth()
@Controller('mahnungspausen')
export class MahnungspauseController {
  constructor(private readonly svc: MahnungspauseService) {}

  @Get()
  @Require('invoice.read')
  async list(
    @Query('companyId') companyId: string,
    @Query('customerId') customerId?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.list(companyId, {
      customerId,
      activeOnly: activeOnly === 'true',
    })
  }

  @Post()
  @Require('invoice.update')
  async create(
    @Query('companyId') companyId: string,
    @Body() body: {
      createdById?: string
      customerId?: string | null
      invoiceId?: string | null
      reason: string
      pausedFrom?: string
      pausedUntil?: string | null
    },
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.create(companyId, body.createdById, {
      customerId: body.customerId ?? null,
      invoiceId: body.invoiceId ?? null,
      reason: body.reason,
      pausedFrom: body.pausedFrom ? new Date(body.pausedFrom) : undefined,
      pausedUntil: body.pausedUntil ? new Date(body.pausedUntil) : null,
    })
  }

  @Patch(':id')
  @Require('invoice.update')
  async update(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: { pausedUntil?: string | null; reason?: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.update(companyId, id, {
      pausedUntil: body.pausedUntil
        ? new Date(body.pausedUntil)
        : body.pausedUntil === null
        ? null
        : undefined,
      reason: body.reason,
    })
  }

  @Delete(':id')
  @Require('invoice.update')
  async cancel(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.cancel(companyId, id)
  }
}
