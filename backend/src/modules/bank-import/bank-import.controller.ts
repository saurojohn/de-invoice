import { Controller, Get, Post, Delete, Body, Param, Query, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BankImportService } from './bank-import.service';
import { Auth, Require } from '../../auth/roles.decorator';

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
   *  already have a saved match are skipped. */
  @Post(':id/suggest')
  @Require('invoice.update')
  async suggest(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.generateSuggestions(companyId, id);
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
}
