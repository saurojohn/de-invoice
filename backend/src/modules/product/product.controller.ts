import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ProductService } from './product.service';

@Controller('products')
export class ProductController {
  constructor(private productService: ProductService) {}

  @Get()
  async findAll(@Query('companyId') companyId: string) {
    return this.productService.findAll(companyId);
  }

  @Post()
  async create(@Query('companyId') companyId: string, @Body() data: any) {
    return this.productService.create(companyId, data);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() data: any) {
    return this.productService.update(id, data);
  }
}
