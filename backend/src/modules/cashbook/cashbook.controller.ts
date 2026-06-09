import { Controller, Get, Post, Put, Delete, Body, Param, Query, BadRequestException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { KassenbuchService, CashBookEntryType } from './kassenbuch.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('cashbook')
export class CashBookController {
  constructor(private readonly svc: KassenbuchService) {}

  // ========== Entries ==========

  @Get('entries')
  @Require('accounting.read')
  async list(
    @Query('companyId') companyId: string,
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.listEntries(companyId, {
      from: fromStr ? new Date(fromStr) : undefined,
      to: toStr ? new Date(toStr) : undefined,
      page: pageStr ? parseInt(pageStr, 10) : undefined,
      pageSize: pageSizeStr ? parseInt(pageSizeStr, 10) : undefined,
    });
  }

  @Get('balance')
  @Require('accounting.read')
  async balance(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.cashBalance(companyId);
  }

  @Get('day')
  @Require('accounting.read')
  async day(
    @Query('companyId') companyId: string,
    @Query('date') dateStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!dateStr) throw new BadRequestException('date is required');
    return this.svc.dayBalance(companyId, new Date(dateStr));
  }

  @Post('entries')
  @Require('accounting.create')
  async create(
    @Query('companyId') companyId: string,
    @Body() body: { createdById?: string } & {
      businessDate: string
      type: CashBookEntryType
      description: string
      amount: number
      vatRate?: number
      counterparty?: string
      belegNumber?: string
      expenseId?: string
      invoiceId?: string
      notes?: string
    },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const { createdById, ...rest } = body;
    return this.svc.createEntry(companyId, createdById, {
      ...rest,
      businessDate: new Date(rest.businessDate),
    });
  }

  @Put('entries/:id')
  @Require('accounting.update')
  async update(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.updateEntry(companyId, id, body);
  }

  @Delete('entries/:id')
  @Require('accounting.delete')
  async remove(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.deleteEntry(companyId, id);
  }

  /**
   * Post a Storno (reversal) for an entry. The original
   * row stays in the book; a new entry with the same
   * amount is created so the balance nets to zero.
   * Required for correcting a closed day.
   */
  @Post('entries/:id/reverse')
  @Require('accounting.update')
  async reverse(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: { reason: string; createdById?: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.reverseEntry(companyId, id, body.reason, body.createdById);
  }

  // ========== Tagesabschluss (Z-Bericht) ==========

  /**
   * Close a day. Captures the day's aggregates + a JSON
   * snapshot of every entry, so the close is auditable
   * even after later Storno entries.
   */
  @Post('close-day')
  @Require('accounting.update')
  async closeDay(
    @Query('companyId') companyId: string,
    @Body() body: { date: string; physicalCount: number; closedById?: string; differenzNote?: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!body.date) throw new BadRequestException('date is required');
    if (typeof body.physicalCount !== 'number') {
      throw new BadRequestException('physicalCount is required (number)');
    }
    return this.svc.closeDay(companyId, new Date(body.date), body.physicalCount, body.closedById, body.differenzNote);
  }

  /**
   * Re-open a previously closed day by deleting the close
   * record. The entries themselves are not affected.
   * Logged explicitly because it touches the GoBD audit
   * chain.
   */
  @Post('reopen-day')
  @Require('accounting.update')
  async reopenDay(
    @Query('companyId') companyId: string,
    @Body() body: { date: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!body.date) throw new BadRequestException('date is required');
    return this.svc.reopenDay(companyId, new Date(body.date));
  }

  @Get('close')
  @Require('accounting.read')
  async getClose(
    @Query('companyId') companyId: string,
    @Query('date') dateStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!dateStr) throw new BadRequestException('date is required');
    return this.svc.getClose(companyId, new Date(dateStr));
  }

  @Get('closes')
  @Require('accounting.read')
  async listCloses(
    @Query('companyId') companyId: string,
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.listCloses(companyId, {
      from: fromStr ? new Date(fromStr) : undefined,
      to: toStr ? new Date(toStr) : undefined,
    });
  }

  // ========== Monthly summary ==========

  @Get('month')
  @Require('accounting.read')
  async month(
    @Query('companyId') companyId: string,
    @Query('year') yearStr: string,
    @Query('month') monthStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!yearStr || !monthStr) throw new BadRequestException('year and month are required');
    return this.svc.monthSummary(companyId, parseInt(yearStr, 10), parseInt(monthStr, 10));
  }

  /**
   * Export the Kassenbuch as a CSV file (German decimal
   * comma, semicolon separator, UTF-8 BOM so Excel
   * opens it correctly). Goes through @Res() because
   * we need to set the Content-Disposition inline rather
   * than letting Nest's default JSON serialiser handle
   * a string body.
   */
  @Get('export')
  @Require('accounting.read')
  async export(
    @Query('companyId') companyId: string,
    @Query('from') fromStr: string,
    @Query('to') toStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!fromStr || !toStr) throw new BadRequestException('from and to are required');
    const list = await this.svc.listEntries(companyId, {
      from: new Date(fromStr),
      to: new Date(toStr),
      pageSize: 100000,
    });
    const closes = await this.svc.listCloses(companyId, {
      from: new Date(fromStr),
      to: new Date(toStr),
    });
    const closeByDate = new Map(closes.map((c: any) => [c.businessDate.toISOString().split('T')[0], c]));

    const rows: string[][] = [
      ['Datum', 'Typ', 'Beschreibung', 'Gegenkonto', 'Beleg-Nr', 'Betrag EUR', 'MwSt %', 'Bemerkung', 'Z-Bericht'],
    ];
    for (const e of list.data) {
      const dateStr = e.businessDate.toISOString().split('T')[0];
      const close = closeByDate.get(dateStr);
      const amount = Number(e.amount).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const typeLabel = { einnahme: 'Einnahme', ausgabe: 'Ausgabe', umbuchung: 'Umbuchung', eroeffnung: 'Eröffnung' }[e.type] || e.type;
      rows.push([
        dateStr,
        typeLabel,
        e.description,
        e.counterparty || '',
        e.belegNumber || '',
        amount,
        e.vatRate ? `${(Number(e.vatRate) * 100).toFixed(0)}%` : '',
        e.notes || '',
        close ? `${close.endbestand} EUR (Differenz: ${close.differenz} EUR)` : 'offen',
      ]);
    }
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => /[",\n;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(';')).join('\r\n');
    const filename = `Kassenbuch_${fromStr}_${toStr}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(Buffer.from(csv, 'utf-8'));
  }
}
