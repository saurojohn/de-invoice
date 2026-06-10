import { Controller, Get, Post, Delete, Body, Param, Query, UseInterceptors, UploadedFile, BadRequestException, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BankImportService } from './bank-import.service';
import { Auth, Require } from '../../auth/roles.decorator';

// IMPORTANT: literal routes (`/import`, `/reconciliations/...`) MUST
// be registered BEFORE `:id` routes. NestJS Express matches in
// registration order, so `/bank-statements/reconciliations/...`
// would otherwise be eaten by `GET /:id` with `id='reconciliations'`.
@Auth()
@Controller('bank-statements')
export class BankImportController {
  constructor(private readonly svc: BankImportService) {}

  /** Upload a .sta / .mt940 / .xml file. Multipart
   *  upload — the file is parsed server-side and the
   *  transactions + statement are persisted in one go.
   *  The frontend then queries /:id/transactions to
   *  show the lines and triggers /:id/suggest to fill
   *  in the candidate matches. */
  @Post('import')
  @Require('invoice.create')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap — CAMT files for a year of statements fit easily
  }))
  async importFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('companyId') companyId: string,
    @Body('userId') userId: string | undefined,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    const content = file.buffer.toString('utf-8');
    return this.svc.importStatement(companyId, userId, file.originalname, content);
  }

  /** Confirm a candidate match (writes Payment, flips
   *  the reconciliation to "confirmed" and the invoice
   *  to "paid" if the cumulative payments cover the
   *  invoice total). */
  @Post('reconciliations/:reconId/confirm')
  @Require('invoice.update')
  async confirmRecon(
    @Req() req: any,
    @Query('companyId') companyId: string,
    @Param('reconId') reconId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const userId = req?.headers?.['x-user-id'] || undefined;
    return this.svc.confirmMatch(companyId, reconId, userId);
  }

  /** Reject a candidate match (flips the
   *  reconciliation to "rejected" so the UI hides it).
   *  The user can re-run suggest to get a different
   *  top candidate. */
  @Post('reconciliations/:reconId/reject')
  @Require('invoice.update')
  async rejectRecon(
    @Query('companyId') companyId: string,
    @Param('reconId') reconId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.rejectMatch(companyId, reconId);
  }

  /** List statements (most recent first). */
  @Get()
  @Require('invoice.read')
  async list(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.listStatements(companyId);
  }

  /** Single statement with transactions. */
  @Get(':id')
  @Require('invoice.read')
  async detail(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.getStatement(companyId, id);
  }

  /** Delete a statement. */
  @Delete(':id')
  @Require('invoice.delete')
  async remove(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.deleteStatement(companyId, id);
  }

  /** Generate candidate matches for all transactions
   *  in a statement. Idempotent — transactions that
   *  already have a saved match are skipped.
   *
   *  Optional body:
   *   { autoConfirmThreshold: 0-100 }
   *  When the threshold is > 0, any candidate whose
   *  confidence is ≥ the threshold is auto-confirmed
   *  (writes the Payment + Voucher in the same call).
   *  The response includes `autoConfirmed` so the
   *  UI can show "X confirmed, Y to review". */
  @Post(':id/suggest')
  @Require('invoice.update')
  async suggest(
    @Req() req: any,
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body('autoConfirmThreshold') autoConfirmThreshold?: number,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const userId = req?.headers?.['x-user-id'] || undefined;
    return this.svc.generateSuggestions(companyId, id, {
      autoConfirmThreshold: typeof autoConfirmThreshold === 'number' ? autoConfirmThreshold : 0,
      userId,
    });
  }

  /** Per-transaction candidates (top 5). */
  @Get(':id/transactions/:txnId/candidates')
  @Require('invoice.read')
  async candidates(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Param('txnId') txnId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    // Validate that the txn belongs to the statement
    // so a user can't probe transaction IDs from other
    // statements by accident.
    const stmt = await this.svc.getStatement(companyId, id);
    if (!stmt) throw new BadRequestException('Kontoauszug nicht gefunden');
    if (!stmt.transactions.some((t) => t.id === txnId)) {
      throw new BadRequestException('Transaktion gehört nicht zu diesem Kontoauszug');
    }
    return this.svc.getCandidates(companyId, txnId);
  }

  /** Manually match a bank transaction to an invoice
   *  (skips the candidate UI). Useful for transactions
   *  that don't auto-suggest anything. */
  @Post(':id/transactions/:txnId/match')
  @Require('invoice.update')
  async matchManual(
    @Req() req: any,
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Param('txnId') txnId: string,
    @Body('invoiceId') invoiceId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!invoiceId) throw new BadRequestException('invoiceId ist erforderlich');
    const stmt = await this.svc.getStatement(companyId, id);
    if (!stmt) throw new BadRequestException('Kontoauszug nicht gefunden');
    if (!stmt.transactions.some((t) => t.id === txnId)) {
      throw new BadRequestException('Transaktion gehört nicht zu diesem Kontoauszug');
    }
    const userId = req?.headers?.['x-user-id'] || undefined;
    return this.svc.manualMatch(companyId, txnId, invoiceId, userId);
  }

  /** List all reconciliations for a statement (for
   *  the matching-status panel: suggested / confirmed
   *  / rejected counts per transaction). */
  @Get(':id/reconciliations')
  @Require('invoice.read')
  async listRecons(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.listReconciliations(companyId, id);
  }

  /** Book a debit bank transaction (money leaving
   *  the account) as a GoBD expense voucher. Used
   *  when no matching customer invoice is found and
   *  the user wants to record it as Aufwand
   *  (e.g. tax payment, supplier bill without a
   *  vendor-invoice flow, bank fees). */
  @Post(':id/transactions/:txnId/book-expense')
  @Require('invoice.create')
  async bookExpense(
    @Req() req: any,
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Param('txnId') txnId: string,
    @Body('expenseAccountNumber') expenseAccountNumber?: string,
    @Body('description') description?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const stmt = await this.svc.getStatement(companyId, id);
    if (!stmt) throw new BadRequestException('Kontoauszug nicht gefunden');
    if (!stmt.transactions.some((t) => t.id === txnId)) {
      throw new BadRequestException('Transaktion gehört nicht zu diesem Kontoauszug');
    }
    const userId = req?.headers?.['x-user-id'] || undefined;
    return this.svc.bookExpense(companyId, txnId, userId, {
      expenseAccountNumber,
      description,
    });
  }
}
