import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ProductService } from './product.service';
import { CreateProductDto } from './dto/product.dto';
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
    this.assertCompanyId(companyId)
    return this.productService.findAll(companyId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
    });
  }

  @Get(':id')
  @Require('product.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.productService.findOneScoped(id, companyId)
  }

  @Post()
  @Require('product.create')
  async create(@Query('companyId') companyId: string, @Body() data: CreateProductDto) {
    this.assertCompanyId(companyId)
    return this.productService.create(companyId, data);
  }

  @Put(':id')
  @Require('product.update')
  async update(@Param('id') id: string, @Query('companyId') companyId: string, @Body() data: any) {
    this.assertCompanyId(companyId)
    return this.productService.update(id, companyId, data);
  }

  /**
   * Soft-delete a product. We never hard-delete products that have
   * ever been used on an invoice (it would leave line-item rows
   * pointing at a non-existent product) — instead we flip `active`
   * to false so it disappears from pickers but the historical
   * reference stays intact. A hard delete is only allowed for
   * products that have never been referenced.
   */
  @Delete(':id')
  @Require('product.delete')
  async remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.productService.remove(id, companyId)
  }

  private assertCompanyId(companyId?: string | null) {
    if (!companyId || !companyId.trim()) {
      throw new BadRequestException('companyId is required')
    }
  }
}
