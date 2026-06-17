import { BadRequestException, Controller, Get, Post, Put, Delete, Body, Param, Query, Header } from '@nestjs/common';
import { CustomerService, ImportCustomerRow } from './customer.service';
import { CreateCustomerDto } from './dto/customer.dto';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('customers')
export class CustomerController {
  constructor(private customerService: CustomerService) {}

  @Get()
  @Require('customer.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    this.assertCompanyId(companyId)
    return this.customerService.findAll(companyId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
    });
  }

  @Get('next-number')
  @Require('customer.read')
  async previewNextNumber(@Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.customerService.previewNextCustomerNumber(companyId)
  }

  @Get(':id')
  @Require('customer.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.customerService.findOne(id, companyId);
  }

  @Post()
  @Require('customer.create')
  async create(@Query('companyId') companyId: string, @Body() data: CreateCustomerDto) {
    this.assertCompanyId(companyId)
    return this.customerService.create(companyId, data);
  }

  @Put(':id')
  @Require('customer.update')
  async update(@Param('id') id: string, @Query('companyId') companyId: string, @Body() data: any) {
    this.assertCompanyId(companyId)
    return this.customerService.update(id, companyId, data);
  }

  /**
   * Verify this customer's VAT ID against VIES.
   * The detail page's "USt-ID prüfen" button hits
   * this. Returns the VIES result + log id (the
   * frontend can read `status` to show the badge
   * and `cached` to show "frisch geprüft" vs
   * "aus Cache"). We use POST (not GET) because
   * it's a side-effectful operation that writes
   * to VatValidationLog — even though there's no
   * "form" body, POST is the right verb here.
   */
  @Post(':id/verify-vat')
  @Require('customer.update')
  async verifyVat(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    this.assertCompanyId(companyId)
    return this.customerService.verifyVatId(id, companyId)
  }

  /**
   * VIES check history for a single customer.
   * Returns { latest, history } — the latest is
   * what the detail page's badge shows, the
   * history is the "Verlauf" tab content. Same
   * shape as VatValidationService's own endpoint
   * but co-located on the customer so the detail
   * page can hit one URL.
   */
  @Get(':id/vat-history')
  @Require('customer.read')
  async vatHistory(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('limit') limitStr?: string,
  ) {
    this.assertCompanyId(companyId)
    return this.customerService.vatHistory(
      id, companyId,
      limitStr ? Math.min(50, Math.max(1, Number(limitStr))) : 20,
    )
  }

  @Delete(':id')
  @Require('customer.delete')
  async remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.customerService.remove(id, companyId);
  }

  /**
   * Bulk-import customers from a CSV-like array of rows.
   * The frontend parses the CSV (Papa Parse, etc.) and posts the
   * resulting array of objects here. We do the server-side validation
   * and dedup against existing customers.
   *
   * Returns a per-row summary: `{ total, imported, skipped, errors }`.
   */
  @Post('import')
  @Require('customer.create')
  async import(
    @Query('companyId') companyId: string,
    @Body() body: { rows: ImportCustomerRow[] },
  ) {
    this.assertCompanyId(companyId)
    if (!body || !Array.isArray(body.rows)) {
      throw new BadRequestException('rows array is required')
    }
    if (body.rows.length > 5000) {
      throw new BadRequestException('Maximal 5000 Zeilen pro Import')
    }
    return this.customerService.importBulk(companyId, body.rows)
  }

  /**
   * CSV template for customer import — column names in
   * German + 3 example rows (one business with full
   * address, one private without VAT ID, one with
   * paymentTerms override). UTF-8 + BOM for Excel.
   */
  @Get('import/template.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="kunden-import.csv"')
  getTemplate(): string {
    return [
      'name;vatId;type;street;postalCode;city;country;email;phone;paymentTerms;taxExempt;tags',
      'Beispiel GmbH;DE123456789;business;Beispielweg 1;12345;Berlin;DE;rechnung@beispiel.de;+49 30 12345;30;false;B2C;Standard',
      'Maria Mustermann;;private;Musterstraße 7;80331;München;DE;maria@example.org;;0;false;Privat',
      'Firma XYZ AG;DE987654321;business;Industriestraße 5;60311;Frankfurt;DE;info@xyz.de;+49 69 99999;14;true;Großkunde',
    ].join('\n')
  }

  /**
   * Normalise the "companyId required" guard to a 400 instead of
   * an unhandled 500. Every public route on this controller calls
   * this, so a missing header (e.g. the user picked the wrong API
   * base or the request came from a script that forgot the param)
   * becomes a clean error message in the UI.
   */
  private assertCompanyId(companyId?: string | null) {
    if (!companyId || !companyId.trim()) {
      throw new BadRequestException('companyId is required')
    }
  }
}
