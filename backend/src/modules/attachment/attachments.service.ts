/**
 * Attachments service — file upload + retrieval.
 *
 * One file = one Attachment row. Multiple files per
 * Expense / Voucher are allowed (the relation is
 * 1:N via entityType + entityId, NOT a single
 * attachmentPath string on the parent). The GoBD
 * requirement is "Beleg muss kommen" — a single
 * receipt is enough to satisfy that, but the
 * 1:N design lets us attach multiple scans (e.g.
 * the front AND back of a folded receipt) or
 * supporting documents (a contract that explains
 * the invoice line).
 *
 * Storage:
 *   - Local disk: ~/data/invoice-system/attachments/
 *     <companyId>/<uuid>.<ext>
 *   - The StorageService already handles directory
 *     creation, magic-byte MIME detection, size
 *     limits, and the per-company /list endpoint.
 *     We just wrap it with the Attachment row write.
 *
 * Integrity:
 *   - SHA-256 of the file content is stored in
 *     contentHash — GoBD §147 AO requires the
 *     original document to be verifiable. A future
 *     re-import (e.g. for a tax audit) can recompute
 *     the hash and confirm no one has tampered with
 *     the bytes on disk.
 *   - The hash is also indexed in DB so a duplicate
 *     upload (same file attached twice) can be
 *     detected and surfaced as a warning, NOT
 *     silently de-duplicated (we want each Expense
 *     to have its own Attachment row even if the
 *     underlying bytes are identical).
 */
import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService, SavedFile } from '../storage/storage.service';
import { OcrService } from './ocr.service';

export interface UploadInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private ocr: OcrService,
  ) {}

  /**
   * Persist a new file as an Attachment for the
   * given parent (Expense or Voucher). The file
   * bytes are written to disk under
   * <storage>/attachments/<companyId>/<uuid>.<ext>
   * via the StorageService, which also detects
   * the real MIME type from the magic bytes (so
   * the mimeType in the saved row is server-
   * determined, not client-claimed).
   */
  async upload(input: {
    companyId: string;
    entityType: 'expense' | 'voucher';
    entityId: string;
    buffer: Buffer;
    originalName: string;
    declaredMimeType: string;
    size: number;
    uploadedById?: string;
  }): Promise<any> {
    // Sanity: the parent must exist and belong to
    // this company. We don't trust the entityId
    // blindly — a forged request could pass any UUID
    // and create a row pointing at an unrelated
    // record. The Prisma `where: { id, companyId }`
    // below does the check atomically.
    if (input.entityType === 'expense') {
      const exp = await this.prisma.expense.findFirst({
        where: { id: input.entityId, companyId: input.companyId },
        select: { id: true },
      })
      if (!exp) throw new NotFoundException('Eingangsrechnung nicht gefunden')
    } else if (input.entityType === 'voucher') {
      const v = await this.prisma.voucher.findFirst({
        where: { id: input.entityId, companyId: input.companyId },
        select: { id: true },
      })
      if (!v) throw new NotFoundException('Beleg nicht gefunden')
    } else {
      throw new BadRequestException(`entityType ${input.entityType} wird nicht unterstützt`)
    }

    // Hash the bytes BEFORE we write them to disk.
    // The hash is the integrity anchor for the
    // audit trail — see the docblock above.
    const contentHash = crypto
      .createHash('sha256')
      .update(input.buffer)
      .digest('hex')

    // Persist to disk via StorageService. We trust
    // its mimeType detection (magic bytes) over the
    // client-declared type — see storage.service.ts.
    const saved: SavedFile = await this.storage.saveFile(
      input.buffer,
      input.originalName,
      'attachments',
      input.companyId,
    )

    // OCR — best-effort. For PDFs we extract text
    // via pdf-parse; for images we currently skip
    // (future Tesseract integration). On any OCR
    // error we log and continue — the file is
    // stored either way, the user can still see
    // the original and the audit trail is intact.
    let ocrText: string | null = null
    try {
      const result = await this.ocr.extractText(input.buffer, saved.mimeType)
      // result.text is the extracted text (may be empty
      // for OCR-attempted-but-failed). Convert empty to
      // null so the DB row stays compact and the UI
      // can treat null/empty the same way.
      ocrText = result?.text ? result.text : null
    } catch (e: any) {
      this.logger.warn(`OCR failed for ${input.originalName}: ${e?.message}`)
    }

    return this.prisma.attachment.create({
      data: {
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        originalName: input.originalName,
        mimeType: saved.mimeType,
        size: saved.size,
        storagePath: saved.path,
        ocrText,
        contentHash,
        uploadedById: input.uploadedById,
      },
    })
  }

  /**
   * List all attachments for a given parent record.
   * Sorted oldest-first so the UI shows the
   * original scan first and any later corrections
   * below it.
   */
  async listForEntity(
    companyId: string,
    entityType: string,
    entityId: string,
  ): Promise<any[]> {
    return this.prisma.attachment.findMany({
      where: { companyId, entityType, entityId },
      orderBy: { createdAt: 'asc' },
      include: {
        // Surface the uploader's email so the audit
        // trail shows who attached what (GoBD §146
        // requires every booking to be traceable to
        // a person, not just a user-id).
        uploadedBy: { select: { id: true, email: true } },
      },
    })
  }

  /**
   * Get the file bytes for download/preview.
   * Returns the metadata + buffer. The controller
   * is responsible for setting Content-Type /
   * Content-Disposition based on the metadata.
   *
   * Throws NotFoundException if the row is gone
   * OR the file is missing on disk (caller sees
   * a 404 either way — for the user, both mean
   * "we don't have that file for you").
   */
  async getFile(
    companyId: string,
    attachmentId: string,
  ): Promise<{
    buffer: Buffer;
    mimeType: string;
    originalName: string;
    size: number;
  }> {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, companyId },
    })
    if (!att) throw new NotFoundException('Anhang nicht gefunden')
    const file = await this.storage.getFile(att.storagePath)
    if (!file) {
      // The row exists but the bytes are gone.
      // This is a serious condition — the audit
      // trail claims the file is there but disk
      // says otherwise. We throw 404 (not 500) so
      // the user sees "file not found" and we
      // log loudly for ops to investigate.
      this.logger.error(
        `Attachment ${att.id} (${att.originalName}) has no file at ${att.storagePath}`,
      )
      throw new NotFoundException('Datei nicht auf dem Server')
    }
    return {
      buffer: file.buffer,
      mimeType: att.mimeType,
      originalName: att.originalName,
      size: att.size,
    }
  }

  /**
   * Delete an attachment. Removes both the DB row
   * AND the bytes on disk. Cascades: when the
   * parent (Expense / Voucher) is deleted, the
   * FK on Attachment sets this row to orphan —
   * that's a bug for the storage layer to handle.
   *
   * Currently we don't auto-clean orphaned
   * attachments on parent delete. A future Tier
   // will add a janitor that scans for
   // orphan rows and unlinks the bytes. For
   // now, the `onDelete: Cascade` on Company
   // handles the company-deletion path; per-
   // record deletion leaves the bytes on disk
   // until the operator manually runs the
   // janitor.
   */
  async delete(companyId: string, attachmentId: string): Promise<{ success: boolean }> {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, companyId },
    })
    if (!att) throw new NotFoundException('Anhang nicht gefunden')
    // Delete the bytes first; if the file is already
    // gone, getFile() would 404 anyway. We log the
    // miss but proceed with the DB delete — the
    // user's intent is to remove the attachment,
    // not to debug missing bytes.
    try {
      await this.storage.deleteFile(att.storagePath)
    } catch (e: any) {
      this.logger.warn(
        `Failed to delete file ${att.storagePath} for attachment ${att.id}: ${e?.message}`,
      )
    }
    await this.prisma.attachment.delete({ where: { id: att.id } })
    return { success: true }
  }

  /**
   * Return the OCR text for an attachment. Used
   * by the "Volltext anzeigen" toggle in the
   * preview dialog — the user can copy / search
   * the extracted text without re-downloading
   * the original.
   */
  async getOcrText(companyId: string, attachmentId: string): Promise<{ text: string | null }> {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, companyId },
      select: { ocrText: true },
    })
    if (!att) throw new NotFoundException('Anhang nicht gefunden')
    return { text: att.ocrText }
  }
}
