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

  /**
   * Verify this supplier's VAT ID against VIES.
   * Same as Customer's verifyVat endpoint but
   * pointed at the supplier row. Used by the
   * Lieferanten detail page.
   */
  @Post(':id/verify-vat')
  @Require('customer.update')
  async verifyVat(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    this.assertCompanyId(companyId);
    return this.supplierService.verifyVatId(id, companyId);
  }

  /**
   * VIES check history for a supplier. Returns
   * { latest, history } in the same shape as the
   * customer variant. The detail page's "Verlauf"
   * tab renders the history array as a table.
   */
  @Get(':id/vat-history')
  @Require('customer.read')
  async vatHistory(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('limit') limitStr?: string,
  ) {
    this.assertCompanyId(companyId);
    return this.supplierService.vatHistory(
      id, companyId,
      limitStr ? Math.min(50, Math.max(1, Number(limitStr))) : 20,
    );
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
