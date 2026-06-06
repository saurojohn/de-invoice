import { Controller, Get, Post, Put, Delete, Body, Query, Param, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UstvaService } from './ustva.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('ustva')
export class UstvaController {
  constructor(private ustva: UstvaService) {}

  // Computation (preview, no save) — looser rate limit (60/min)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('compute')
  @Require('ustva.read')
  async compute(
    @Query('companyId') companyId: string,
    @Query('year') yearStr: string,
    @Query('quarter') quarterStr?: string,
    @Query('month') monthStr?: string,
  ) {
    if (!companyId || !yearStr) throw new BadRequestException('companyId and year are required');
    const year = parseInt(yearStr, 10);
    const quarter = quarterStr ? parseInt(quarterStr, 10) : undefined;
    const month = monthStr ? parseInt(monthStr, 10) : undefined;
    return this.ustva.compute(companyId, year, quarter, month);
  }

  // Save (draft or submit)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('filings')
  @Require('ustva.submit')
  async saveFiling(
    @Query('companyId') companyId: string,
    @Body() body: any,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.saveFiling(companyId, body);
  }

  // List filings
  @Get('filings')
  @Require('ustva.read')
  async listFilings(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.listFilings(companyId);
  }

  // Get single filing
  @Get('filings/:id')
  @Require('ustva.read')
  async getFiling(@Query('companyId') companyId: string, @Param('id') id: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const filing = await this.ustva.getFiling(companyId, id);
    if (!filing) throw new BadRequestException('Filing not found');
    return filing;
  }

  // Expenses
  @Get('expenses')
  @Require('accounting.read')
  async listExpenses(
    @Query('companyId') companyId: string,
    @Query('year') yearStr?: string,
    @Query('quarter') quarterStr?: string,
    @Query('month') monthStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const year = yearStr ? parseInt(yearStr, 10) : undefined;
    const quarter = quarterStr ? parseInt(quarterStr, 10) : undefined;
    const month = monthStr ? parseInt(monthStr, 10) : undefined;
    return this.ustva.listExpenses(companyId, year, quarter, month);
  }

  @Post('expenses')
  @Require('accounting.create')
  async createExpense(@Query('companyId') companyId: string, @Body() body: any) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!body.description || !body.invoiceDate || body.netAmount === undefined) {
      throw new BadRequestException('description, invoiceDate, netAmount are required');
    }
    if (body.vatAmount === undefined) {
      // Auto-compute VAT if not given
      body.vatAmount = Number((body.netAmount * (body.vatRate || 0.19)).toFixed(2));
    }
    if (body.grossAmount === undefined) {
      body.grossAmount = Number(body.netAmount) + Number(body.vatAmount);
    }
    return this.ustva.createExpense(companyId, {
      supplierId: body.supplierId,
      invoiceNumber: body.invoiceNumber,
      description: body.description,
      invoiceDate: new Date(body.invoiceDate),
      netAmount: Number(body.netAmount),
      vatRate: Number(body.vatRate ?? 0.19),
      vatAmount: Number(body.vatAmount),
      grossAmount: Number(body.grossAmount),
      category: body.category,
      isIntraEU: body.isIntraEU ?? false,
      isReverseCharge: body.isReverseCharge ?? false,
      notes: body.notes,
    });
  }

  @Delete('expenses/:id')
  @Require('accounting.delete')
  async deleteExpense(@Query('companyId') companyId: string, @Param('id') id: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    await this.ustva.deleteExpense(companyId, id);
    return { ok: true };
  }
}
