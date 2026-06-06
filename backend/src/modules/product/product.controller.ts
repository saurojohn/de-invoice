import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ProductService } from './product.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('products')
export class ProductController {
  constructor(private productService: ProductService) {}

  @Get()
  @Require('product.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return this.productService.findAll(companyId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
    });
  }

  @Post()
  @Require('product.create')
  async create(@Query('companyId') companyId: string, @Body() data: any) {
    return this.productService.create(companyId, data);
  }

  @Put(':id')
  @Require('product.update')
  async update(@Param('id') id: string, @Body() data: any) {
    return this.productService.update(id, data);
  }
}
