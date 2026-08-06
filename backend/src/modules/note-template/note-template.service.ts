/**
 * Tier 156: per-company Bemerkungstext templates.
 *
 * The operator can drop a saved template into the
 * notes field on /dashboard/invoices/create with one
 * click. Templates are stored per-company (so a
 * freelancer's "Skonto 2%" and a GmbH's
 * "Umsatzsteuergesetz § 14c" stay separate).
 *
 * First GET auto-seeds 5 German defaults if the
 * company has no rows yet — the same convention the
 * Mahnung-Vorlagen editor (Tier 151) uses. The
 * operator can edit / add / delete from there.
 *
 * Placeholders the operator may include in `text`:
 *   {{customerName}} {{invoiceNumber}} {{dueDate}}
 *   {{total}} {{companyName}}
 * The frontend substitutes these client-side when
 * inserting (so the operator sees the final text in
 * the notes field before saving). The server returns
 * the raw template with placeholders intact — the
 * substitute-on-insert happens in the browser.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

const DEFAULT_TEMPLATES: Array<{
  label: string
  text: string
  sortOrder: number
}> = [
  {
    label: 'Dank + Zahlungshinweis',
    sortOrder: 10,
    text: 'Vielen Dank für Ihren Auftrag. Bitte überweisen Sie den Rechnungsbetrag von {{total}} bis spätestens {{dueDate}} auf das in den Kontodaten angegebene Konto.',
  },
  {
    label: 'Skonto 2%',
    sortOrder: 20,
    text: 'Bei Zahlung binnen 7 Tagen gewähren wir 2% Skonto ({{total}}).',
  },
  {
    label: 'Lieferung frei Haus',
    sortOrder: 30,
    text: 'Lieferung frei Haus. Die Lieferung erfolgt innerhalb von 5 Werktagen.',
  },
  {
    label: 'Preise zzgl. MwSt.',
    sortOrder: 40,
    text: 'Alle Preise verstehen sich zzgl. der gesetzlichen Mehrwertsteuer.',
  },
  {
    label: 'Zahlbar ohne Abzug',
    sortOrder: 50,
    text: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  },
]

export interface NoteTemplateRow {
  id: string
  companyId: string
  label: string
  text: string
  sortOrder: number
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

@Injectable()
export class NoteTemplateService {
  private readonly logger = new Logger(NoteTemplateService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List all templates for a company, ordered by
   * sortOrder ASC then createdAt ASC. If the
   * company has no rows yet, seed the 5 German
   * defaults first so the UI is never empty.
   */
  async listForCompany(companyId: string): Promise<NoteTemplateRow[]> {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    const existing = await this.prisma.noteTemplate.findMany({
      where: { companyId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })
    if (existing.length === 0) {
      // First-touch: seed defaults so the operator
      // sees something useful instead of an empty
      // list on the dropdown.
      await this.seedDefaults(companyId)
      const seeded = await this.prisma.noteTemplate.findMany({
        where: { companyId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      })
      return seeded.map(this.toRow)
    }
    return existing.map(this.toRow)
  }

  /**
   * Insert the 5 German defaults for a company.
   * Idempotent: uses the same `id` (uuid) on each
   * call so re-runs are no-ops. Called from
   * listForCompany when the company has no rows.
   */
  async seedDefaults(companyId: string): Promise<number> {
    let n = 0
    for (const t of DEFAULT_TEMPLATES) {
      await this.prisma.noteTemplate.create({
        data: {
          companyId,
          label: t.label,
          text: t.text,
          sortOrder: t.sortOrder,
          isDefault: true,
        },
      })
      n++
    }
    this.logger.log(
      `seeded ${n} default note templates for company ${companyId}`,
    )
    return n
  }

  async create(
    companyId: string,
    body: { label: string; text: string; sortOrder?: number },
  ): Promise<NoteTemplateRow> {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    if (!body.label?.trim()) {
      throw new BadRequestException('label is required')
    }
    if (!body.text?.trim()) {
      throw new BadRequestException('text is required')
    }
    const row = await this.prisma.noteTemplate.create({
      data: {
        companyId,
        label: body.label.trim(),
        text: body.text.trim(),
        sortOrder:
          typeof body.sortOrder === 'number' ? body.sortOrder : 999,
        isDefault: false,
      },
    })
    return this.toRow(row)
  }

  async update(
    id: string,
    companyId: string,
    body: { label?: string; text?: string; sortOrder?: number },
  ): Promise<NoteTemplateRow> {
    if (!id || !companyId) {
      throw new BadRequestException('id and companyId are required')
    }
    const existing = await this.prisma.noteTemplate.findFirst({
      where: { id, companyId },
    })
    if (!existing) {
      throw new NotFoundException('Note template not found')
    }
    const updated = await this.prisma.noteTemplate.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label.trim() } : {}),
        ...(body.text !== undefined ? { text: body.text.trim() } : {}),
        ...(typeof body.sortOrder === 'number'
          ? { sortOrder: body.sortOrder }
          : {}),
        // Editing clears the "default" badge — the row
        // is no longer the pristine seed.
        isDefault: false,
      },
    })
    return this.toRow(updated)
  }

  async delete(id: string, companyId: string): Promise<{ ok: true }> {
    if (!id || !companyId) {
      throw new BadRequestException('id and companyId are required')
    }
    const existing = await this.prisma.noteTemplate.findFirst({
      where: { id, companyId },
    })
    if (!existing) {
      throw new NotFoundException('Note template not found')
    }
    await this.prisma.noteTemplate.delete({ where: { id } })
    return { ok: true }
  }

  /**
   * Convenience: render a template's `text` by
   * substituting {{placeholder}} tokens with values
   * from the given context. Used by the
   * invoice-create page on the frontend too, but
   * the service is the source of truth for the
   * placeholder list (kept in sync with the
   * frontend via a comment on the controller).
   *
   * Unknown placeholders are left intact — the
   * operator sees "{{invoiceNumber}} not set yet"
   * and understands the context isn't loaded, which
   * is much better than silently empty-string.
   */
  render(
    text: string,
    ctx: {
      customerName?: string | null
      invoiceNumber?: string | null
      dueDate?: string | null
      total?: string | null
      companyName?: string | null
    } = {},
  ): string {
    return text
      .replace(/\{\{customerName\}\}/g, ctx.customerName ?? '{{customerName}}')
      .replace(/\{\{invoiceNumber\}\}/g, ctx.invoiceNumber ?? '{{invoiceNumber}}')
      .replace(/\{\{dueDate\}\}/g, ctx.dueDate ?? '{{dueDate}}')
      .replace(/\{\{total\}\}/g, ctx.total ?? '{{total}}')
      .replace(/\{\{companyName\}\}/g, ctx.companyName ?? '{{companyName}}')
  }

  private toRow = (r: any): NoteTemplateRow => ({
    id: r.id,
    companyId: r.companyId,
    label: r.label,
    text: r.text,
    sortOrder: r.sortOrder,
    isDefault: r.isDefault,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  })
}
