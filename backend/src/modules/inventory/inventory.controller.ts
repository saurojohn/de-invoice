import { Controller, Get, Put, Body, Param, Query } from '@nestjs/common';
import { InventoryService, AdjustStockDto } from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(private inventoryService: InventoryService) {}

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

  @Get('low-stock')
  async getLowStock(@Query('companyId') companyId: string) {
    return this.inventoryService.getLowStockProducts(companyId);
  }

  @Get(':productId/history')
  async getHistory(
    @Param('productId') productId: string,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.getStockHistory(productId, limit ? parseInt(limit) : 50);
  }
}