import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { CustomerService } from './customer.service';

@Controller('customers')
export class CustomerController {
  constructor(private customerService: CustomerService) {}

  @Get()
  async findAll(@Query('companyId') companyId: string) {
    return this.customerService.findAll(companyId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    return this.customerService.findOne(id, companyId);
  }

  @Post()
  async create(@Query('companyId') companyId: string, @Body() data: any) {
    return this.customerService.create(companyId, data);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Query('companyId') companyId: string, @Body() data: any) {
    return this.customerService.update(id, companyId, data);
  }
}
