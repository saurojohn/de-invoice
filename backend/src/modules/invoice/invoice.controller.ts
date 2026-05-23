import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { InvoiceService } from './invoice.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';

@Controller('invoices')
export class InvoiceController {
  constructor(private invoiceService: InvoiceService) {}

  @Get()
  async findAll(@Query('companyId') companyId: string, @Query('status') status?: string) {
    return this.invoiceService.findAll(companyId, { status });
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    return this.invoiceService.findOne(id, companyId);
  }

  @Post()
  async create(@Query('companyId') companyId: string, @Body() dto: CreateInvoiceDto) {
    return this.invoiceService.create(companyId, dto);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.invoiceService.update(id, companyId, dto);
  }

  @Put(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body('status') status: string,
  ) {
    return this.invoiceService.updateStatus(id, companyId, status);
  }
}
