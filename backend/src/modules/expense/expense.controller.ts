import { Controller, Get, Post, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('expenses')
export class ExpenseController {
  constructor(private expenseService: ExpenseService) {}

  @Get()
  @Require('invoice.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('supplierId') supplierId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    this.assertCompanyId(companyId);
    return this.expenseService.findAll(companyId, { supplierId, status, search });
  }

  @Get(':id')
  @Require('invoice.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId);
    return this.expenseService.findOne(id, companyId);
  }

  @Post()
  @Require('invoice.create')
  async create(@Query('companyId') companyId: string, @Body() data: any) {
    this.assertCompanyId(companyId);
    return this.expenseService.create(companyId, data);
  }

  private assertCompanyId(companyId?: string | null) {
    if (!companyId || !companyId.trim()) {
      throw new BadRequestException('companyId is required');
    }
  }
}
