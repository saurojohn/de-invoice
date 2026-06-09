import { Controller, Get, Query, BadRequestException, Res, Header } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { AgingService } from './aging.service';
import { PrismaService } from '../../prisma/prisma.service';
import { generateDatevBuchungsstapel, buildBuchungenFromDb } from './datev.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly agingService: AgingService,
    private readonly prisma: PrismaService,
  ) {}

@Get('sales')
@Require('reports.read')
async getSalesReport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? new Date(endDate) : new Date();

    return this.reportsService.getSalesReport({
      companyId,
      startDate: start,
      endDate: end,
    });
  }

  @Get('vat')
  @Require('ustva.read')
  async getVatReport(
    @Query('companyId') companyId: string,
    @Query('year') year: string,
    @Query('quarter') quarter?: string,
    @Query('month') month?: string,
  ) {
    return this.reportsService.getVatReport({
      companyId,
      year: parseInt(year, 10),
      quarter: quarter ? parseInt(quarter, 10) : undefined,
      month: month ? parseInt(month, 10) : undefined,
    });
  }

  @Get('customers')
  @Require('reports.read')
  async getCustomerReport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportsService.getCustomerReport({
      companyId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    });
  }

  /**
   * Accounts-receivable aging report. Buckets each
   * customer's open (unpaid) invoice amount into
   * current / 1-30 / 31-60 / 61-90 / 90+ days overdue.
   *
   * The result includes:
   *   - per-customer rows (sorted by totalOpen desc)
   *   - per-bucket totals across the whole company
   *   - grandTotal (sum of all buckets)
   *   - asOf (ISO timestamp of when the report was generated)
   */
  @Get('aging')
  @Require('reports.read')
  async getAgingReport(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.agingService.generate(companyId);
  }

  /**
   * DATEV Buchungsstapel export — ASCII CSV in DATEV 5.0
   * format. Returns a Windows-1252 (Latin-1) text file
   * the Steuerberater imports into DATEV Rechnungswesen.
   *
   * Default date range: the current calendar year. Pass
   * `startDate` / `endDate` as ISO 8601 to override.
   *
   * The CSV includes one header line + one data line per
   * Buchungssatz. Source data is paid invoices (revenue
   * side) + booked expenses (input tax / cost side). The
   * Berater can remap the default SKR03 accounts in
   * DATEV before finalising the import.
   *
   * Response sets:
   *   - Content-Type: text/csv; charset=windows-1252
   *   - Content-Disposition: attachment; filename="..."
   *   - Body: Latin-1 encoded CSV
   */
  @Get('datev-export')
  @Require('reports.read')
  async datevExport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDateStr: string,
    @Query('endDate') endDateStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException('Company not found');

    const startDate = startDateStr
      ? new Date(startDateStr)
      : new Date(new Date().getFullYear(), 0, 1);
    const endDate = endDateStr
      ? new Date(endDateStr)
      : new Date();

    const buchungen = await buildBuchungenFromDb(
      this.prisma,
      companyId,
      startDate,
      endDate,
    );

    const csv = generateDatevBuchungsstapel({
      company: {
        id: company.id,
        name: company.name,
        taxId: company.taxId,
        // Per-company Berater-Nr / Mandanten-Nr. Stored
        // alongside the account map in Company.settings.
        // The Berater hands these to the client; without
        // them we fall back to placeholders that the
        // Berater overwrites on import.
        beraterNr: (company as any).settings?.datev?.beraterNr || '00000',
        mandantenNr: (company as any).settings?.datev?.mandantenNr || '00001',
      },
      startDate,
      endDate,
      buchungen,
    });

    const filename = `DATEV_Buchungsstapel_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv`;

    // Hand-rolled response: the @Header() decorator
    // doesn't reliably reach the buffer stream when
    // @Res() is in non-passthrough mode, and passthrough
    // mode swallows the body. The two-line approach
    // (set headers, res.end(buffer)) works in every
    // NestJS version. Content-Type uses Windows-1252
    // because that's what DATEV 5.0 expects.
    res.setHeader('Content-Type', 'text/csv; charset=windows-1252');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(Buffer.from(csv, 'latin1'));
  }
}
