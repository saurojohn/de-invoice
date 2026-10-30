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
import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService, SavedFile } from '../storage/storage.service';
import { OcrService } from './ocr.service';
import { assertPeriodOpen } from '../reports/filed-period';

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
    entityType: 'expense' | 'voucher' | 'berater-note' | 'invoice';
    entityId: string;
    buffer: Buffer;
    originalName: string;
    declaredMimeType: string;
    size: number;
    uploadedById?: string;
    /** Tier 573: searchable text the caller already has (an e-invoice's content) */
    text?: string;
    /** Tier 740: the received e-invoice as it came — never taken off */
    keptOriginal?: boolean;
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
    } else if (input.entityType === 'berater-note') {
      // Tier 79: Berater Document Exchange. The
      // entityId is the eventual BeraterNote id
      // (or the placeholder 'pending' during the
      // upload — the caller patches entityId
      // after the BeraterNote row is created).
      // We DON'T enforce a DB-level FK here
      // because the Attachment is uploaded
      // BEFORE the BeraterNote exists; the
      // service caller is responsible for the
      // patch.
    } else if (input.entityType === 'invoice') {
      // Tier 140: outbound-invoice Belege. The
      // attachment can be any document the
      // Mandant / Berater wants to keep with
      // the invoice — a signed delivery note,
      // a customer-side credit-note scan, a
      // payment receipt screenshot, etc.
      const inv = await this.prisma.invoice.findFirst({
        where: { id: input.entityId, companyId: input.companyId },
        select: { id: true },
      })
      if (!inv) throw new NotFoundException('Rechnung nicht gefunden')
    } else {
      // unknown entityType — accept as
      // forward-compat; the row will be orphaned
      // (no real parent record) and the GET
      // list-for-entity endpoint will return it
      // anyway.
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
    let ocrText: string | null = input.text ?? null
    if (ocrText === null) {
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
        keptOriginal: input.keptOriginal === true,
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
      where: { companyId, entityType, entityId, deletedAt: null },
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
    opts: { removed?: boolean } = {}, // Tier 745: a removed Beleg, to look at before restoring it
  ): Promise<{
    buffer: Buffer;
    mimeType: string;
    originalName: string;
    size: number;
  }> {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, companyId, deletedAt: opts.removed ? { not: null } : null },
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
   * Tier 740 — take a Beleg off a record.
   *
   * This removed the row and the bytes, always. Measured: the Beleg of an
   * expense in closed books was gone with a 200, and so was the kept original
   * of a received e-invoice. A Beleg is kept unchanged for its whole period
   * (§ 146 Abs. 4, § 147 AO; GoBD Unveränderbarkeit). Now:
   *
   *   - the received e-invoice as it came (`keptOriginal`): refused;
   *   - a record in closed books or a submitted UStVA period: refused;
   *   - otherwise — a wrong file on an open record — it is marked: the record
   *     no longer shows it, row and bytes stay, the audit log has the change,
   *     and the GoBD exports keep it as removed.
   */
  async delete(companyId: string, attachmentId: string, userId?: string | null): Promise<{ success: boolean }> {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, companyId, deletedAt: null },
    })
    if (!att) throw new NotFoundException('Anhang nicht gefunden')
    if (att.keptOriginal) {
      throw new BadRequestException('Das ist die empfangene E-Rechnung im Original. Sie ist unverändert aufzubewahren und kann nicht entfernt werden.')
    }
    const date = await this.recordDate(companyId, att.entityType, att.entityId)
    if (date) await assertPeriodOpen(this.prisma, companyId, [date], 'das Entfernen eines Belegs')
    await this.prisma.attachment.update({
      where: { id: att.id },
      data: { deletedAt: new Date(), deletedById: userId ?? null },
    })
    return { success: true }
  }

  /**
   * Tier 745 — the Belege taken off a record, for the panel that puts them
   * back. `deletedById` is a snapshot; the address is looked up (an anonymised
   * account shows as such).
   */
  async listRemoved(companyId: string, entityType: string, entityId: string): Promise<any[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { companyId, entityType, entityId, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      select: { id: true, originalName: true, mimeType: true, size: true, contentHash: true, createdAt: true, deletedAt: true, deletedById: true },
    })
    const ids = [...new Set(rows.map((r) => r.deletedById).filter((x): x is string => !!x))]
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
      : []
    const email = new Map(users.map((u) => [u.id, u.email]))
    return rows.map(({ deletedById, ...r }) => ({ ...r, deletedBy: deletedById ? email.get(deletedById) ?? null : null }))
  }

  /**
   * Tier 745 — put a Beleg back on its record. Until now this took the
   * operator and a statement in the database. As with taking one off, closed
   * periods stay as they are; the audit log has the change.
   */
  async restore(companyId: string, attachmentId: string): Promise<{ success: boolean }> {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, companyId, deletedAt: { not: null } },
    })
    if (!att) throw new NotFoundException('Anhang nicht gefunden oder nicht entfernt')
    const date = await this.recordDate(companyId, att.entityType, att.entityId)
    if (date) await assertPeriodOpen(this.prisma, companyId, [date], 'das Wiederherstellen eines Belegs')
    const file = await this.storage.getFile(att.storagePath).catch(() => null)
    if (!file) {
      this.logger.error(`Attachment ${att.id} (${att.originalName}) has no file at ${att.storagePath}`)
      throw new BadRequestException('Die Datei dieses Belegs fehlt auf dem Server. Er kann nicht wiederhergestellt werden.')
    }
    await this.prisma.attachment.update({
      where: { id: att.id },
      data: { deletedAt: null, deletedById: null },
    })
    return { success: true }
  }

  /** The day a Beleg's record is booked on, for the closed-period check. */
  private async recordDate(companyId: string, entityType: string, entityId: string): Promise<Date | null> {
    if (entityType === 'expense') {
      return (await this.prisma.expense.findFirst({ where: { id: entityId, companyId }, select: { invoiceDate: true } }))?.invoiceDate ?? null
    }
    if (entityType === 'voucher') {
      return (await this.prisma.voucher.findFirst({ where: { id: entityId, companyId }, select: { date: true } }))?.date ?? null
    }
    if (entityType === 'invoice') {
      return (await this.prisma.invoice.findFirst({ where: { id: entityId, companyId }, select: { issueDate: true } }))?.issueDate ?? null
    }
    return null
  }

  /**
   * Row and bytes of a file whose record was never booked — the e-invoice
   * import rolling back. Nothing else calls this.
   */
  async removeUnbooked(companyId: string, attachmentId: string): Promise<void> {
    const att = await this.prisma.attachment.findFirst({ where: { id: attachmentId, companyId } })
    if (!att) return
    await this.storage.deleteFile(att.storagePath).catch(() => undefined)
    await this.prisma.attachment.delete({ where: { id: att.id } })
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
      where: { id: attachmentId, companyId, deletedAt: null },
      select: { ocrText: true },
    })
    if (!att) throw new NotFoundException('Anhang nicht gefunden')
    return { text: att.ocrText }
  }
}
