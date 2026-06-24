// Tier 12: Buchungsjournal PDF export.
//
// Route:
//   GET /api/v1/accounting/journal.pdf?companyId=X&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
//   GET /api/v1/accounting/journal.pdf?companyId=X&voucherNumber=BK-2026-0001
//
// Returns application/pdf. The Content-
// Disposition is `inline` so the browser
// opens it in a tab (with the browser's
// built-in PDF viewer). `filename=`
// carries the suggested name so "Save As"
// defaults to something useful.
//
// Auth: `@Auth()` (header guard) +
// `@Require('reports.read')` (any
// authenticated user can read the
// journal — the action is "view
// accounting", not "modify").
//
// We accept either a date range OR a
// single voucherNumber — the latter
// is the "print one Beleg" use case
// the Steuerberater uses when an
// auditor asks for a specific receipt.

import {
  Controller,
  Get,
  Query,
  BadRequestException,
  Res,
} from '@nestjs/common'
import { Response } from 'express'
import { Auth, Require } from '../../auth/roles.decorator'
import { JournalService } from './journal.service'

@Auth()
@Controller('accounting/journal')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get('pdf')
  @Require('reports.read')
  async download(
    @Query('companyId') companyId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('voucherNumber') voucherNumber: string | undefined,
    @Res() res: Response,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    // If a single voucher is requested,
    // the date range is optional. If
    // a range is requested, BOTH ends
    // must be present and look like
    // YYYY-MM-DD (the date-input shape
    // from the frontend).
    if (!voucherNumber) {
      if (!dateFrom || !dateTo) {
        throw new BadRequestException(
          'dateFrom und dateTo sind erforderlich (oder voucherNumber)',
        )
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        throw new BadRequestException('Datum muss YYYY-MM-DD sein')
      }
      if (dateFrom > dateTo) {
        throw new BadRequestException('dateFrom muss vor dateTo liegen')
      }
    }
    const { buffer, count, totalDebit, totalCredit } = await this.journal.renderPdf({
      companyId,
      dateFrom: dateFrom || '1970-01-01',
      dateTo: dateTo || '2099-12-31',
      voucherNumber,
    })
    const filename = voucherNumber
      ? `Buchungsjournal_${voucherNumber}.pdf`
      : `Buchungsjournal_${dateFrom}_bis_${dateTo}.pdf`
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
      // X-Journal-* headers carry
      // metadata the frontend can
      // show next to the iframe
      // ("3 Belege, Soll = Haben").
      // PDFKit doesn't have a clean
      // way to embed these, so we
      // piggy-back on HTTP.
      'X-Journal-Count': count.toString(),
      'X-Journal-Total-Debit': totalDebit.toFixed(2),
      'X-Journal-Total-Credit': totalCredit.toFixed(2),
      'X-Journal-Balanced': Math.abs(totalDebit - totalCredit) < 0.01 ? '1' : '0',
    })
    res.end(buffer)
  }
}