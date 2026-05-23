import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { VatRateService } from './vat-rate.service';

@Controller('vat-rates')
export class VatRateController {
  constructor(private vatRateService: VatRateService) {}

  @Get()
  async findAll(@Query('countryCode') countryCode?: string) {
    return this.vatRateService.findAll(countryCode);
  }

  @Get('current')
  async getCurrentRate(@Query('countryCode') countryCode: string) {
    return this.vatRateService.getCurrentRate(countryCode);
  }

  @Post()
  async create(@Body() data: any) {
    return this.vatRateService.create(data);
  }
}
