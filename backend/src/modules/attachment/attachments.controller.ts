/**
 * Attachments controller — file upload / list /
 * download / delete endpoints.
 *
 * Mounted at /api/v1/attachments (NOT
 * /api/v1/storage — the existing storage endpoints
 * are for the company-wide Storage Center). These
 * endpoints are bound to a specific parent record
 * (an Expense or a Voucher) and carry the
 * bookkeeping-bound semantics.
 *
 * Routes:
 *   POST   /attachments          upload (multipart/form-data)
 *                                required fields: file, companyId,
 *                                entityType ('expense'|'voucher'),
 *                                entityId
 *   GET    /attachments          list, filtered by query params
 *                                (?companyId=…&entityType=…&entityId=…)
 *   GET    /attachments/:id/file download the file bytes
 *   GET    /attachments/:id/ocr  return the OCR text only
 *   DELETE /attachments/:id      delete both row and file
 *
 * The upload uses NestJS's FileInterceptor which
 * already enforces a 10MB limit (set in
 * storage.controller.ts). We don't duplicate
 * that limit here — the storage service owns the
 * global upload policy.
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseInterceptors,
  UploadedFile,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { Auth, Require } from '../../auth/roles.decorator';
import { AttachmentsService } from './attachments.service';

// Mirror of the Multer file shape used by the
// storage controller — FileInterceptor puts the
// parsed file on req.file and the service layer
// only cares about the buffer + metadata.
interface MulterFile {
  fieldname: string
  originalname: string
  encoding: string
  mimetype: string
  size: number
  buffer: Buffer
  destination?: string
  filename?: string
  path?: string
}

@Auth()
@Controller('attachments')
export class AttachmentsController {
  constructor(private attachments: AttachmentsService) {}

  /**
   * Upload a file. multipart/form-data with fields:
   *   - file:        the binary (required)
   *   - companyId:   the parent company's UUID
   *   - entityType:  'expense' | 'voucher'
   *   - entityId:    the parent's UUID
   *
   * The user is stamped from x-user-id by NestJS's
   * global HeaderAuthGuard. We read it via the
   * request object because the controller doesn't
   * expose @Headers() for the upload form data.
   */
  @Post()
  @Require('invoice.create')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  }))
  async upload(
    @UploadedFile() file: MulterFile,
    @Body() body: { companyId: string; entityType: string; entityId: string; uploadedById?: string },
  ) {
    if (!file) throw new BadRequestException('Keine Datei hochgeladen.')
    if (!body?.companyId) throw new BadRequestException('companyId is required')
    if (!body?.entityType || !body?.entityId) {
      throw new BadRequestException('entityType und entityId sind erforderlich')
    }
    if (body.entityType !== 'expense' && body.entityType !== 'voucher') {
      throw new BadRequestException(`entityType muss 'expense' oder 'voucher' sein (erhielt: ${body.entityType})`)
    }
    return this.attachments.upload({
      companyId: body.companyId,
      entityType: body.entityType,
      entityId: body.entityId,
      buffer: file.buffer,
      originalName: file.originalname,
      declaredMimeType: file.mimetype,
      size: file.size,
      uploadedById: body.uploadedById,
    })
  }

  /**
   * List attachments for a given parent record.
   * Returns the array directly (the UI doesn't need
   * pagination — most Expenses have 1-3 attachments).
   */
  @Get()
  @Require('invoice.read')
  async list(
    @Query('companyId') companyId: string,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    if (!entityType || !entityId) {
      throw new BadRequestException('entityType und entityId sind erforderlich')
    }
    return this.attachments.listForEntity(companyId, entityType, entityId)
  }

  /**
   * Download / preview the file bytes. Content-Type
   * is set to the server-detected MIME type, with
   * Content-Disposition: inline so browsers render
   * PDFs / images in the tab instead of triggering
   * a download.
   *
   * Use ?download=1 to force a download with the
   * original filename (Content-Disposition:
   * attachment). The default is inline because the
   * common case is "I want to look at this scan".
   */
  @Get(':id/file')
  @Require('invoice.read')
  async getFile(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('download') download: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const file = await this.attachments.getFile(companyId, id)
    const disposition = download
      ? `attachment; filename="${encodeURIComponent(file.originalName)}"`
      : `inline; filename="${encodeURIComponent(file.originalName)}"`
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': file.size,
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=3600',
    })
    res.end(file.buffer)
  }

  /**
   * Return just the OCR text. The UI calls this when
   * the user toggles "Volltext anzeigen" so the
   * preview dialog can show the extracted text
   * inline (copyable, searchable) without the user
   * needing to re-download the original.
   */
  @Get(':id/ocr')
  @Require('invoice.read')
  async getOcr(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.attachments.getOcrText(companyId, id)
  }

  @Delete(':id')
  @Require('invoice.update')
  async delete(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.attachments.delete(companyId, id)
  }
}
