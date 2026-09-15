import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Res,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  HttpCode,
  Headers,
} from '@nestjs/common'
import { Response } from 'express'
import * as path from 'path'
import { Auth, Require, CurrentUser } from '../../auth/roles.decorator'
import { BeraterService } from './berater.service'
import { PrismaService } from '../../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { CallerBoundUpload } from '../../auth/caller-bound-upload'

/**
 * Mirror of the Multer file shape used by the
 * attachments controller — FileInterceptor
 * puts the parsed file on req.file and the
 * service layer only cares about the buffer
 * + metadata.
 */
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

/**
 * Tier 79: Berater Document Exchange controller.
 *
 * Mounted at /api/v1/berater/notes. The routes:
 *   GET  /                       list (filterable)
 *   GET  /:id                    single note
 *   POST /                       create (Berater only)
 *   GET  /:id/attachment         download the file
 *   POST /:id/acknowledge        mark "seen" (Mandant)
 *   POST /:id/dismiss            mark "no action" (Mandant)
 *
 * The 10MB upload limit is enforced by the
 * FileInterceptor (mirrored from
 * attachments.controller.ts). 10MB is generous
 * for a Berater scan; if a Steuerberater
 * regularly uploads bigger files we can lift
 * the limit per-tenant later.
 */
@Auth()
@Controller('berater/notes')
export class BeraterController {
  constructor(
    private readonly berater: BeraterService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * List notes for the company. Both the Berater
   * and the Mandant can call this — they each
   * see the same queue, but the UI hides the
   * "acknowledge" / "dismiss" buttons for the
   * Berater (server-side role check is the
   * authoritative guard).
   *
   * Query params:
   *   - companyId   (required)
   *   - status      (optional: 'open' | 'acknowledged' | 'dismissed')
   *   - entityType  (optional filter)
   *   - entityId    (optional filter; requires entityType)
   *   - createdById (optional: "my sent notes" view for the Berater)
   *   - limit       (optional, default 100, max 500)
   *   - skip        (optional, default 0)
   */
  @Get()
  @Require('berater.note.read')
  async list(
    @Query('companyId') companyId: string,
    @Query('status') status?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('createdById') createdById?: string,
    @Query('limit') limitRaw?: string,
    @Query('skip') skipRaw?: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const limit = limitRaw
      ? Math.min(Math.max(parseInt(limitRaw, 10) || 100, 1), 500)
      : 100
    const skip = skipRaw ? Math.max(parseInt(skipRaw, 10) || 0, 0) : 0
    return this.berater.list({
      companyId,
      status,
      entityType,
      entityId,
      createdById,
      limit,
      skip,
    })
  }

  @Get(':id')
  @Require('berater.note.read')
  async getOne(@Param('id') id: string, @Headers('x-company-id') companyId: string) {
    if (!id) throw new BadRequestException('id ist erforderlich')
    // Tier 378: getById looks the note up by id alone; any tenant could read
    // another company's note (measured). Same answer for foreign and unknown.
    const note = await this.berater.getById(id).catch(() => null)
    if (!note || note.companyId !== companyId) {
      throw new NotFoundException('Notiz nicht gefunden')
    }
    return note
  }

  /**
   * Create a note. multipart/form-data with:
   *   - file (optional): the binary
   *   - companyId (required)
   *   - entityType (required, e.g. 'invoice')
   *   - entityId (required)
   *   - message (required, 1-4000 chars)
   *
   * Role check (berater only) happens in the
   * service — see berater.service.ts. The
   * @Require here just gates the route on a
   * minimum role rank.
   */
  @Post()
  @Require('berater.note.create')
  @CallerBoundUpload('file', {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  })
  async create(
    @UploadedFile() file: MulterFile | undefined,
    @Body()
    body: {
      companyId: string
      entityType: string
      entityId: string
      message: string
    },
    @CurrentUser() user: { id: string } | undefined,
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!body?.entityType || !body?.entityId) {
      throw new BadRequestException('entityType und entityId sind erforderlich')
    }
    if (!body?.message || !body.message.trim()) {
      throw new BadRequestException('message ist erforderlich')
    }
    // The callerUserId comes from the auth
    // header (HeaderAuthGuard attaches it to
    // req.user.id). @CurrentUser pulls it.
    if (!user?.id) {
      throw new BadRequestException(
        'callerUserId ist erforderlich (X-User-ID Header)',
      )
    }
    return this.berater.create({
      companyId: body.companyId,
      entityType: body.entityType,
      entityId: body.entityId,
      message: body.message,
      file: file
        ? {
            buffer: file.buffer,
            originalName: file.originalname,
            declaredMimeType: file.mimetype,
            size: file.size,
          }
        : undefined,
      callerUserId: user.id,
    })
  }

  /**
   * Download the attachment (if any). Sets
   * Content-Type to the server-detected MIME
   * type and Content-Disposition: inline so
   * browsers render the file in the tab.
   *
   * Use ?download=1 to force a download.
   */
  @Get(':id/attachment')
  @Require('berater.note.read')
  async getAttachment(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    if (!id) throw new BadRequestException('id ist erforderlich')
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const note = await this.berater.getById(id)
    if (note.companyId !== companyId) {
      throw new BadRequestException('Notiz gehört zu einer anderen Firma')
    }
    if (!note.attachment) {
      throw new NotFoundException('Kein Anhang vorhanden')
    }
    const att = note.attachment
    // Tier 207 — HIGH-002 from the code audit.
    // The previous version used string concat
    // (`${storageRoot}/${att.storagePath}`) and a
    // private-field any-cast on
    // `(this.storage as any).config?.localPath`.
    // If `config.localPath` is unset, the root
    // defaulted to '' and any relative path worked.
    // If `att.storagePath` ever contained `..`
    // (e.g. a tampered DB row or a future
    // migration), the controller would happily
    // stream `/etc/passwd`. Fix: use `path.join`
    // + `path.resolve`, then guard that the
    // resolved path is INSIDE the storage root.
    const storageRoot = (this.storage as any).config?.localPath || ''
    if (!storageRoot) {
      throw new NotFoundException('Storage root not configured')
    }
    const resolvedRoot = path.resolve(storageRoot)
    const resolvedFile = path.resolve(path.join(resolvedRoot, att.storagePath))
    if (
      resolvedFile !== resolvedRoot &&
      !resolvedFile.startsWith(resolvedRoot + path.sep)
    ) {
      // Path traversal attempt — refuse to
      // serve anything outside the storage
      // root. Same 404 as "file not on disk"
      // so an attacker can't probe for the
      // existence of `/etc/passwd`.
      throw new NotFoundException('File on disk not found')
    }
    const fs = require('fs') as typeof import('fs')
    if (!fs.existsSync(resolvedFile)) {
      throw new NotFoundException('File on disk not found')
    }
    const disposition = download === '1' ? 'attachment' : 'inline'
    res.setHeader('Content-Type', att.mimeType || 'application/octet-stream')
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${att.originalName}"`,
    )
    fs.createReadStream(resolvedFile).pipe(res)
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @Require('berater.note.acknowledge')
  async acknowledge(
    @Param('id') id: string,
    @Body() body: { companyId: string },
    @CurrentUser() user: { id: string } | undefined,
  ) {
    if (!id) throw new BadRequestException('id ist erforderlich')
    if (!body?.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!user?.id) {
      throw new BadRequestException('callerUserId ist erforderlich')
    }
    return this.berater.acknowledge({
      id,
      companyId: body.companyId,
      callerUserId: user.id,
    })
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @Require('berater.note.dismiss')
  async dismiss(
    @Param('id') id: string,
    @Body() body: { companyId: string },
    @CurrentUser() user: { id: string } | undefined,
  ) {
    if (!id) throw new BadRequestException('id ist erforderlich')
    if (!body?.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!user?.id) {
      throw new BadRequestException('callerUserId ist erforderlich')
    }
    return this.berater.dismiss({
      id,
      companyId: body.companyId,
      callerUserId: user.id,
    })
  }
}
