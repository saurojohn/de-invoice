import { Controller, Get, Post, Put, Delete, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { SupplierService } from './supplier.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('suppliers')
export class SupplierController {
  constructor(private supplierService: SupplierService) {}

  @Get()
  @Require('customer.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('search') search?: string,
  ) {
    this.assertCompanyId(companyId);
    return this.supplierService.findAll(companyId, { search });
  }

  @Get(':id')
  @Require('customer.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId);
    return this.supplierService.findOne(id, companyId);
  }

  @Post()
  @Require('customer.create')
  async create(@Query('companyId') companyId: string, @Body() data: any) {
    this.assertCompanyId(companyId);
    return this.supplierService.create(companyId, data);
  }

  @Put(':id')
  @Require('customer.update')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() data: any,
  ) {
    this.assertCompanyId(companyId);
    return this.supplierService.update(id, companyId, data);
  }

  @Delete(':id')
  @Require('customer.delete')
  async remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId);
    return this.supplierService.remove(id, companyId);
  }

  private assertCompanyId(companyId?: string | null) {
    if (!companyId || !companyId.trim()) {
      throw new BadRequestException('companyId is required');
    }
  }
}
