import { Controller, Get, Post, Put, Delete, Param, Query, Body, BadRequestException } from '@nestjs/common';
import { VoucherTemplateService } from './voucher-template.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('voucher-templates')
export class VoucherTemplateController {
  constructor(private svc: VoucherTemplateService) {}

  @Get()
  @Require('invoice.read')
  async findAll(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.svc.findAll(companyId);
  }

  @Get(':id')
  @Require('invoice.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.svc.findOne(id, companyId);
  }

  @Post()
  @Require('invoice.create')
  async create(@Query('companyId') companyId: string, @Body() body: any) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.svc.create(companyId, body);
  }

  @Put(':id')
  @Require('invoice.create')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: any,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.svc.update(id, companyId, body);
  }

  @Delete(':id')
  @Require('invoice.create')
  async remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.svc.remove(id, companyId);
  }

  /**
   * Resolve a template into modal-ready lines for a
   * specific amount + date. POST instead of GET
   * because the body carries the apply data
   * (amount, date, counterparty). Returns lines +
   * resolved description + any placeholders the
   * user must still fill in.
   */
  @Post(':id/apply')
  @Require('invoice.create')
  async apply(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: { amount: number; date: string; counterparty?: string; description?: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.svc.applyTemplate(id, companyId, body);
  }
}
