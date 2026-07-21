import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { AttachmentsService } from '../attachment/attachments.service'

/**
 * Tier 79: Berater Document Exchange — the
 * write-back channel from the Steuerberater
 * (UserCompany.role='berater') to the Mandant.
 *
 * Tier 66 + 71 gave the Berater read access.
 * This service adds the counterpart: the
 * Berater can leave notes + upload supporting
 * documents on specific records (an invoice,
 * an expense, a voucher, etc.) and the Mandant
 * sees them in a queue and can acknowledge or
 * dismiss.
 *
 * Role boundaries (enforced here, not in the
 * schema):
 *   - 'create' requires the caller to have
 *     role='berater' on the UserCompany for
 *     the target companyId. The Mandant
 *     (admin / accountant) cannot create
 *     berater notes.
 *   - 'acknowledge' + 'dismiss' require the
 *     caller to have role != 'berater' on
 *     the UserCompany. The Berater cannot
 *     act on their own notes (they have to
 *     wait for the Mandant).
 *   - 'read' is open to anyone with access
 *     to the company (Berater + Mandant).
 *
 * The lifecycle is open → acknowledged |
 * dismissed. A note is never hard-deleted
 * (the Berater can see "yep, the Mandant saw
 * it and chose not to act" — important for
 * the audit trail).
 */
@Injectable()
export class BeraterService {
  private readonly logger = new Logger(BeraterService.name)

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private attachments: AttachmentsService,
  ) {}

  /**
   * The caller's role on the target company, read
   * from the UserCompany table. We don't trust
   * User.role (which is the global default) —
   * tier 66 made the per-company role the
   * authoritative grant check.
   */
  private async getCallerRole(
    userId: string,
    companyId: string,
  ): Promise<string | null> {
    const access = await this.prisma.userCompany.findUnique({
      where: { userId_companyId: { userId, companyId } },
      select: { role: true },
    })
    return access?.role ?? null
  }

  /**
   * List notes for a company, with optional
   * filters. The Berater sees the same queue as
   * the Mandant — both can list. The status
   * filter is the primary UI control: the
   * Mandant's dashboard defaults to status=open
   * ("things that need my attention"), with a
   * toggle to show acknowledged + dismissed.
   */
  async list(input: {
    companyId: string
    status?: string
    entityType?: string
    entityId?: string
    createdById?: string
    limit?: number
    skip?: number
  }): Promise<{ items: any[]; total: number }> {
    const where: any = { companyId: input.companyId }
    if (input.status) where.status = input.status
    if (input.entityType) where.entityType = input.entityType
    if (input.entityId) where.entityId = input.entityId
    if (input.createdById) where.createdById = input.createdById

    const [items, total] = await Promise.all([
      this.prisma.beraterNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(input.limit || 100, 500),
        skip: input.skip || 0,
        include: {
          createdBy: {
            select: { id: true, email: true, profile: true },
          },
          acknowledgedBy: {
            select: { id: true, email: true, profile: true },
          },
          dismissedBy: {
            select: { id: true, email: true, profile: true },
          },
          attachment: {
            select: {
              id: true,
              originalName: true,
              mimeType: true,
              size: true,
              storagePath: true,
            },
          },
        },
      }),
      this.prisma.beraterNote.count({ where }),
    ])
    return { items, total }
  }

  /**
   * Single note lookup. Returns the note with the
   * same includes as list() so the frontend can
   * render the detail view without a second
   * round-trip.
   */
  async getById(id: string) {
    const note = await this.prisma.beraterNote.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: { id: true, email: true, profile: true },
        },
        acknowledgedBy: {
          select: { id: true, email: true, profile: true },
        },
        dismissedBy: {
          select: { id: true, email: true, profile: true },
        },
        attachment: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            size: true,
            storagePath: true,
            contentHash: true,
          },
        },
      },
    })
    if (!note) throw new NotFoundException('Berater note not found')
    return note
  }

  /**
   * Berater creates a new note. The caller must
   * have role='berater' on the UserCompany for
   * the target companyId — Mandant (admin /
   * accountant) cannot post here.
   *
   * Optional attachment: the file is uploaded
   * via the existing AttachmentsService (same
   * storage path, same SHA-256, same MIME
   * detection). We then store the attachmentId
   * on the BeraterNote row. The Attachment is
   * owned by the company + a virtual entityType
   * 'berater-note' (we abuse the entityType
   * field — the Beleg doesn't belong to a
   * specific record, it's the Berater's upload
   * for the note).
   */
  async create(input: {
    companyId: string
    entityType: string
    entityId: string
    message: string
    file?: {
      buffer: Buffer
      originalName: string
      declaredMimeType: string
      size: number
    }
    callerUserId: string
  }) {
    // Role check — only the Berater can post.
    const role = await this.getCallerRole(input.callerUserId, input.companyId)
    if (role !== 'berater') {
      throw new ForbiddenException(
        'Nur Benutzer mit der Rolle "berater" dürfen Notizen erstellen',
      )
    }
    // Validation
    if (!input.entityType || !input.entityId) {
      throw new BadRequestException('entityType und entityId sind erforderlich')
    }
    const message = (input.message || '').trim()
    if (message.length < 1) {
      throw new BadRequestException('message darf nicht leer sein')
    }
    if (message.length > 4000) {
      throw new BadRequestException('message darf maximal 4000 Zeichen lang sein')
    }
    // Verify the referenced entity exists. We
    // only support the 3 main tables in v1; a
    // v2 could extend to customer / product.
    await this.assertEntityExists(input.companyId, input.entityType, input.entityId)

    // Optional file upload. We do this BEFORE
    // the BeraterNote insert so a storage
    // failure rolls back cleanly.
    let attachmentId: string | null = null
    if (input.file) {
      const att = await this.attachments.upload({
        companyId: input.companyId,
        // 'berater-note' is a synthetic entityType
        // that we use to namespace Berater uploads
        // separately from real Beleg-Bilder. The
        // storage path is the same, the Attachment
        // row is the same — just the entityType
        // discriminator differs.
        entityType: 'berater-note' as any,
        // entityId is the eventual BeraterNote
        // id — but we don't have it yet, so we
        // use a placeholder. The Attachments
        // service doesn't enforce FK to the
        // entity, so this is safe; we patch the
        // Attachment.entityId AFTER the BeraterNote
        // is inserted.
        entityId: 'pending',
        buffer: input.file.buffer,
        originalName: input.file.originalName,
        declaredMimeType: input.file.declaredMimeType,
        size: input.file.size,
        uploadedById: input.callerUserId,
      })
      attachmentId = att.id
    }

    const note = await this.prisma.beraterNote.create({
      data: {
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        attachmentId,
        message,
        status: 'open',
        createdById: input.callerUserId,
      },
    })

    // Patch the Attachment's entityId now that
    // we have the BeraterNote id. This makes the
    // Attachment's metadata line up with the
    // "BeraterNote <X> uploaded this file"
    // relationship.
    if (attachmentId) {
      await this.prisma.attachment.update({
        where: { id: attachmentId },
        data: { entityId: note.id },
      })
    }
    return this.getById(note.id)
  }

  /**
   * Mandant acknowledges a note. The note
   * moves from 'open' to 'acknowledged'.
   *
   * Only non-Berater roles (admin / accountant
   * / viewer-on-this-company) can acknowledge.
   * The Berater cannot ack their own note —
   * they'd just be "approving themselves".
   */
  async acknowledge(input: {
    id: string
    companyId: string
    callerUserId: string
  }) {
    const role = await this.getCallerRole(input.callerUserId, input.companyId)
    if (role === 'berater') {
      throw new ForbiddenException(
        'Nur der Mandant (nicht der Berater selbst) kann eine Notiz bestätigen',
      )
    }
    const note = await this.prisma.beraterNote.findUnique({
      where: { id: input.id },
      select: { id: true, companyId: true, status: true },
    })
    if (!note) throw new NotFoundException('Berater note not found')
    if (note.companyId !== input.companyId) {
      throw new ForbiddenException('Notiz gehört zu einer anderen Firma')
    }
    if (note.status === 'acknowledged') {
      // Idempotent — re-acknowledging is a no-op.
      return this.getById(note.id)
    }
    await this.prisma.beraterNote.update({
      where: { id: input.id },
      data: {
        status: 'acknowledged',
        acknowledgedById: input.callerUserId,
        acknowledgedAt: new Date(),
        // Clear the dismissal so a re-cycle (ack →
        // dismiss → ack again) is consistent.
        dismissedById: null,
        dismissedAt: null,
      },
    })
    return this.getById(input.id)
  }

  /**
   * Mandant dismisses a note. The note moves
   * from 'open' (or 'acknowledged') to
   * 'dismissed'. Same role boundary as
   * acknowledge: only the Mandant can dismiss.
   */
  async dismiss(input: {
    id: string
    companyId: string
    callerUserId: string
  }) {
    const role = await this.getCallerRole(input.callerUserId, input.companyId)
    if (role === 'berater') {
      throw new ForbiddenException(
        'Nur der Mandant (nicht der Berater selbst) kann eine Notiz schließen',
      )
    }
    const note = await this.prisma.beraterNote.findUnique({
      where: { id: input.id },
      select: { id: true, companyId: true, status: true },
    })
    if (!note) throw new NotFoundException('Berater note not found')
    if (note.companyId !== input.companyId) {
      throw new ForbiddenException('Notiz gehört zu einer anderen Firma')
    }
    await this.prisma.beraterNote.update({
      where: { id: input.id },
      data: {
        status: 'dismissed',
        dismissedById: input.callerUserId,
        dismissedAt: new Date(),
      },
    })
    return this.getById(input.id)
  }

  /**
   * Verify the (entityType, entityId) the
   * Berater is referring to actually exists in
   * this company. Catches typos + ID-forgetting
   * early so the note doesn't end up pointing
   * at a deleted record. We support 3 main
   * tables in v1; the entityType string is
   * open for future extension.
   */
  private async assertEntityExists(
    companyId: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    if (entityType === 'invoice') {
      const x = await this.prisma.invoice.findFirst({
        where: { id: entityId, companyId },
        select: { id: true },
      })
      if (!x) throw new BadRequestException(`Invoice ${entityId} not found`)
      return
    }
    if (entityType === 'expense') {
      const x = await this.prisma.expense.findFirst({
        where: { id: entityId, companyId },
        select: { id: true },
      })
      if (!x) throw new BadRequestException(`Expense ${entityId} not found`)
      return
    }
    if (entityType === 'voucher') {
      const x = await this.prisma.voucher.findFirst({
        where: { id: entityId, companyId },
        select: { id: true },
      })
      if (!x) throw new BadRequestException(`Voucher ${entityId} not found`)
      return
    }
    if (entityType === 'customer') {
      const x = await this.prisma.customer.findFirst({
        where: { id: entityId, companyId },
        select: { id: true },
      })
      if (!x) throw new BadRequestException(`Customer ${entityId} not found`)
      return
    }
    // Unknown entityType — accept (forward-compat).
    // The list endpoint will surface the orphan
    // note and the Mandant can dismiss it.
    this.logger.warn(
      `BeraterNote with unknown entityType='${entityType}' for companyId=${companyId} — accepted as forward-compat`,
    )
  }
}
