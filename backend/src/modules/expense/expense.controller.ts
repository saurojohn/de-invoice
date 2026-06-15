import { Controller, Get, Post, Body, Param, Query, BadRequestException, Header } from '@nestjs/common';
import { ExpenseService, ImportExpenseRow } from './expense.service';
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

  /**
   * Bulk-import expenses (Eingangsrechnungen) from a
   * CSV-like row array. Same shape as the customer /
   * product bulk-import endpoints — see those for the
   * design notes. The frontend's BulkImport page
   * posts { rows: [...] } and gets back the standard
   * { total, imported, skipped, errors } shape.
   */
  @Post('import')
  @Require('invoice.create')
  async import(
    @Query('companyId') companyId: string,
    @Body() body: { rows: ImportExpenseRow[] },
  ) {
    this.assertCompanyId(companyId);
    if (!body || !Array.isArray(body.rows)) {
      throw new BadRequestException('rows array is required');
    }
    if (body.rows.length > 5000) {
      throw new BadRequestException('Maximal 5000 Zeilen pro Import');
    }
    return this.expenseService.importBulk(companyId, body.rows);
  }

  /**
   * CSV template for expense import — column names in
   * German to match the rest of the UI, plus 3 example
   * rows (one per common shape: explicit supplierId,
   * existing supplierName, new supplierName+auto-create).
   * UTF-8 + BOM for Excel (the importer's main target
   * is users who export from sevDesk / lexoffice /
   * DATEV and paste into Excel first).
   */
  @Get('import/template.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="eingangsrechnungen-import.csv"')
  getTemplate(): string {
    return [
      'description;invoiceDate;invoiceNumber;supplierName;supplierVatId;netAmount;vatRate;vatAmount;grossAmount;category;notes',
      'Büromaterial;15.06.2026;RE-2026-001;Staples GmbH;DE123456789;100.00;0.19;19.00;119.00;Bürobedarf;Q2 Sammelrechnung',
      'Miete Juni 2026;01.06.2026;M-2026-06;Vermieter GmbH;;1500.00;0.19;285.00;1785.00;Miete;',
      'Beratungsleistung;2026-06-10;BS-100;Neue Beratung;DE987654321;2500.00;0.19;475.00;2975.00;Beratung;Stunden á 250€',
    ].join('\n');
  }

  private assertCompanyId(companyId?: string | null) {
    if (!companyId || !companyId.trim()) {
      throw new BadRequestException('companyId is required');
    }
  }
}
