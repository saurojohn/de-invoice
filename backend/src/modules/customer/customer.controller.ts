import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { CustomerService, ImportCustomerRow } from './customer.service';
import { CreateCustomerDto } from './dto/customer.dto';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('customers')
export class CustomerController {
  constructor(private customerService: CustomerService) {}

  @Get()
  @Require('customer.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return this.customerService.findAll(companyId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
    });
  }

  @Get(':id')
  @Require('customer.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    return this.customerService.findOne(id, companyId);
  }

  @Post()
  @Require('customer.create')
  async create(@Query('companyId') companyId: string, @Body() data: CreateCustomerDto) {
    return this.customerService.create(companyId, data);
  }

  @Put(':id')
  @Require('customer.update')
  async update(@Param('id') id: string, @Query('companyId') companyId: string, @Body() data: any) {
    return this.customerService.update(id, companyId, data);
  }

  @Delete(':id')
  @Require('customer.delete')
  async remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) throw new Error('companyId is required')
    return this.customerService.remove(id, companyId);
  }

  /**
   * Bulk-import customers from a CSV-like array of rows.
   * The frontend parses the CSV (Papa Parse, etc.) and posts the
   * resulting array of objects here. We do the server-side validation
   * and dedup against existing customers.
   *
   * Returns a per-row summary: `{ total, imported, skipped, errors }`.
   */
  @Post('import')
  @Require('customer.create')
  async import(
    @Query('companyId') companyId: string,
    @Body() body: { rows: ImportCustomerRow[] },
  ) {
    if (!companyId) throw new Error('companyId is required')
    if (!body || !Array.isArray(body.rows)) {
      throw new Error('rows array is required')
    }
    if (body.rows.length > 5000) {
      throw new Error('Maximal 5000 Zeilen pro Import')
    }
    return this.customerService.importBulk(companyId, body.rows)
  }
}
