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
  Res,
  Header,
} from '@nestjs/common';
import { ProductService, ImportProductRow } from './product.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
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

  /**
   * Bulk-import products from a CSV-like array of rows.
   * The frontend's BulkImport page parses the CSV and
   * posts the rows here; the controller forwards to the
   * service which does the per-row try/catch + dedup.
   *
   * Same shape as the customer bulk import endpoint
   * (see customer.controller.ts @Post('import')), so
   * the frontend can use the same preview component
   * for both. Returns { total, imported, skipped, errors }.
   */
  @Post('import')
  @Require('product.create')
  async import(
    @Query('companyId') companyId: string,
    @Body() body: { rows: ImportProductRow[] },
  ) {
    this.assertCompanyId(companyId)
    if (!body || !Array.isArray(body.rows)) {
      throw new BadRequestException('rows array is required')
    }
    if (body.rows.length > 5000) {
      throw new BadRequestException('Maximal 5000 Zeilen pro Import')
    }
    return this.productService.importBulk(companyId, body.rows)
  }

  /**
   * CSV template download — gives the user a starter
   * file with the right column headers in German, so
   * they don't have to guess which fields the
   * importer accepts. UTF-8 + BOM for Excel compat.
   *
   * The response is a literal string (not generated
   * from a row array) so the template is stable
   * across backend versions — adding a column is
   * a deliberate code change, not a side-effect of
   * adding a row to the seed data.
   */
  @Get('import/template.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="produkte-import.csv"')
  getTemplate(): string {
    // Header row in German to match the rest of the UI.
    // Column order matches the field order in
    // ImportProductRow + Product model — important
    // because some users map columns positionally
    // when their spreadsheet doesn't have header names.
    return [
      'name;sku;description;type;unit;basePrice;vatRate',
      'Beispiel-Produkt;P-001;Beschreibung;good;piece;19.99;0.19',
      'Dienstleistung;DL-100;Beratung;service;hour;120.00;0.19',
      'Material;MAT-7;Holz Werkstoff;good;piece;15.50;0.07',
    ].join('\n')
  }

  @Put(':id')
  @Require('product.update')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() data: UpdateProductDto,
  ) {
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
