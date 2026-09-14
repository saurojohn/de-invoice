import { Controller, Get, Post, Body, Query, Headers } from '@nestjs/common';
import { VatRateService } from './vat-rate.service';
import { CreateVatRateDto } from './dto/vat-rate.dto';
import { Require, CurrentUser } from '../../auth/roles.decorator';

/**
 * Tier 376: rates are per company. POST wrote rows with companyId NULL — a
 * global table any tenant's admin could change: tenant B's DE 99 % rate was
 * what tenant A's GET /current returned (measured). Now a created rate always
 * belongs to the caller's company, and reads see global rows (seeded by
 * operators, companyId NULL) plus the caller's own.
 */
@Controller('vat-rates')
export class VatRateController {
  constructor(private vatRateService: VatRateService) {}

  @Require('invoice.read')
  @Get()
  async findAll(
    @Headers('x-company-id') companyId: string,
    @Query('countryCode') countryCode?: string,
  ) {
    return this.vatRateService.findAll(companyId, countryCode);
  }

  @Require('invoice.read')
  @Get('current')
  async getCurrentRate(
    @Headers('x-company-id') companyId: string,
    @Query('countryCode') countryCode: string,
  ) {
    return this.vatRateService.getCurrentRate(companyId, countryCode);
  }

  @Require('company.update')
  @Post()
  async create(
    @Headers('x-company-id') companyId: string,
    @CurrentUser() user: { id: string } | undefined,
    @Body() data: CreateVatRateDto,
  ) {
    return this.vatRateService.create({ ...data, companyId, createdById: user?.id ?? data.createdById });
  }
}
