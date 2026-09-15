import { Controller, Get, Put, Body, Param, Query, Headers } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { Require } from '../../auth/roles.decorator';

@Controller('inventory')
export class InventoryController {
  constructor(private inventoryService: InventoryService) {}

  // Tier 228 fix: route ordering matters. Express 4 matches
  // the first registered handler that fits the pattern. We
  // put the literal-path routes (`/low-stock`) BEFORE the
  // wildcard-path routes (`:productId`) so a request to
  // /inventory/low-stock doesn't get greedily matched as
  // `:productId=low-stock` and silently return null. The
  // previous order had the wildcards first; tests passed
  // for stock-history but the low-stock endpoint was
  // returning 200 + empty body because findUnique('low-stock')
  // found no row. nestjs-prisma-gotchas.md §22.
  @Require('product.read')
  @Get('low-stock')
  async getLowStock(@Query('companyId') companyId: string) {
    return this.inventoryService.getLowStockProducts(companyId);
  }

  @Require('product.read')
  @Get(':productId')
  async getStock(@Param('productId') productId: string, @Headers('x-company-id') companyId: string) {
    return this.inventoryService.getStock(companyId, productId);
  }

  @Require('product.update')
  @Put(':productId/adjust')
  async adjustStock(
    @Param('productId') productId: string,
    @Headers('x-company-id') companyId: string,
    @Body() dto: AdjustStockDto,
  ) {
    return this.inventoryService.adjustStock(companyId, productId, dto);
  }

  @Require('product.read')
  @Get(':productId/history')
  async getHistory(
    @Param('productId') productId: string,
    @Headers('x-company-id') companyId: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.getStockHistory(companyId, productId, limit ? parseInt(limit) : 50);
  }
}