import { Controller, Get, Put, Body, Param, Query } from '@nestjs/common';
import { InventoryService, AdjustStockDto } from './inventory.service';

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
  @Get('low-stock')
  async getLowStock(@Query('companyId') companyId: string) {
    return this.inventoryService.getLowStockProducts(companyId);
  }

  @Get(':productId')
  async getStock(@Param('productId') productId: string) {
    return this.inventoryService.getStock(productId);
  }

  @Put(':productId/adjust')
  async adjustStock(
    @Param('productId') productId: string,
    @Body() dto: AdjustStockDto,
  ) {
    return this.inventoryService.adjustStock(productId, dto);
  }

  @Get(':productId/history')
  async getHistory(
    @Param('productId') productId: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.getStockHistory(productId, limit ? parseInt(limit) : 50);
  }
}