import { PrismaService } from '../../prisma/prisma.service'
import { Injectable, BadRequestException } from '@nestjs/common'
import { generateInvoicePDF } from '../../invoices/invoice-pdf.service'

/**
 * Tier 7: Custom invoice template service.
 *
 * Each InvoiceTemplate is a per-company
 * preset of PDF styling. Templates are
 * stored in the DB as a JSONB configJson
 * blob (no fixed shape — fields are
 * validated at the API boundary).
 *
 * The render path:
 *
 * 1. Invoice has `templateType='custom'`
 *    and a `templateId` (we add this
 *    column below in the schema update)
 * 2. The renderer looks up
 *    `InvoiceTemplate.findUnique({id: templateId, companyId})`
 * 3. If found, applies the configJson
 *    (primaryColor, accentColor, font,
 *    layout density, footer text, custom
 *    labels).
 * 4. If not found OR Invoice has no
 *    templateId, falls back to the
 *    company's default template, then
 *    to the hard-coded 'standard' preset.
 *
 * The render function is in
 * `invoices/invoice-pdf.service.ts` — we
 * keep the template service thin and let
 * the existing PDF generator do the
 * actual layout work.
 */
export interface TemplateConfig {
  primaryColor?: string
  accentColor?: string
  textColor?: string
  fontFamily?: 'Helvetica' | 'Times-Roman' | 'Courier'
  layoutDensity?: 'comfortable' | 'compact'
  showLogo?: boolean
  footerText?: string
  paymentTermsText?: string
  showAbsenderzeile?: boolean
  reverseChargeNote?: string
  euTransactionNote?: string
  kleineUnternehmerNote?: string
}

const DEFAULT_CONFIG: Required<TemplateConfig> = {
  primaryColor: '#1e3a8a',
  accentColor: '#64748b',
  textColor: '#0f172a',
  fontFamily: 'Helvetica',
  layoutDensity: 'comfortable',
  showLogo: true,
  footerText: 'Vielen Dank für Ihren Auftrag.',
  paymentTermsText: 'Zahlbar binnen 14 Tagen ohne Abzug.',
  showAbsenderzeile: true,
  reverseChargeNote:
    'Steuerschuldnerschaft des Leistungsempfängers (§13b UStG).',
  // Tier 27: §1a UStG note for innergemeinschaftliche
  // Lieferungen. Same position on the PDF as the §13b
  // note (footerY - 28); the PDF picks one OR the other
  // (an invoice is never both).
  euTransactionNote:
    'Steuerfreie innergemeinschaftliche Lieferung (§1a UStG).',
  kleineUnternehmerNote:
    'Gemäß §19 UStG wird keine Umsatzsteuer berechnet.',
}

/**
 * Hard-coded presets for the 3 built-in
 * templates. These exist so that the
 * 100+ invoices already in the DB with
 * templateType='standard' / 'simplified' /
 * 'compact' continue to render without
 * needing a template row in the new
 * InvoiceTemplate table.
 */
export const BUILTIN_TEMPLATES: Record<
  'standard' | 'simplified' | 'compact',
  TemplateConfig
> = {
  standard: {
    primaryColor: '#1e3a8a',
    accentColor: '#64748b',
    textColor: '#0f172a',
    fontFamily: 'Helvetica',
    layoutDensity: 'comfortable',
    showLogo: true,
    footerText: 'Vielen Dank für Ihren Auftrag.',
    paymentTermsText: 'Zahlbar binnen 14 Tagen ohne Abzug.',
    showAbsenderzeile: true,
  },
  simplified: {
    primaryColor: '#374151',
    accentColor: '#9ca3af',
    textColor: '#1f2937',
    fontFamily: 'Helvetica',
    layoutDensity: 'comfortable',
    showLogo: false,
    footerText: '',
    paymentTermsText: 'Zahlbar binnen 14 Tagen ohne Abzug.',
    showAbsenderzeile: true,
  },
  compact: {
    primaryColor: '#0f172a',
    accentColor: '#475569',
    textColor: '#0f172a',
    fontFamily: 'Helvetica',
    layoutDensity: 'compact',
    showLogo: true,
    footerText: '',
    paymentTermsText: 'Zahlbar binnen 14 Tagen ohne Abzug.',
    showAbsenderzeile: true,
  },
}

@Injectable()
export class InvoiceTemplateService {
  constructor(private prisma: PrismaService) {}

  /**
   * List all templates for a company. The
   * default template is first, then by
   * createdAt desc.
   */
  async list(companyId: string) {
    return this.prisma.invoiceTemplate.findMany({
      where: { companyId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    })
  }

  async getOne(id: string, companyId: string) {
    const t = await this.prisma.invoiceTemplate.findFirst({
      where: { id, companyId },
    })
    if (!t) throw new BadRequestException('Template not found')
    return t
  }

  /**
   * Create a new template. If `isDefault`
   * is true, demote the existing default
   * (there can only be one default per
   * company — the renderer falls back to
   * it for invoices without a templateId).
   */
  async create(
    companyId: string,
    input: { name: string; templateType?: string; configJson: TemplateConfig; isDefault?: boolean },
  ) {
    if (!input?.name || input.name.length < 1) {
      throw new BadRequestException('name is required')
    }
    this.validateConfig(input.configJson)
    if (input.isDefault) {
      await this.prisma.invoiceTemplate.updateMany({
        where: { companyId, isDefault: true },
        data: { isDefault: false },
      })
    }
    return this.prisma.invoiceTemplate.create({
      data: {
        companyId,
        name: input.name,
        templateType: input.templateType || 'custom',
        configJson: { ...DEFAULT_CONFIG, ...input.configJson },
        isDefault: input.isDefault || false,
      },
    })
  }

  async update(
    id: string,
    companyId: string,
    input: Partial<{ name: string; configJson: TemplateConfig; isDefault: boolean }>,
  ) {
    const t = await this.getOne(id, companyId)
    if (input.configJson) this.validateConfig(input.configJson)
    if (input.isDefault) {
      await this.prisma.invoiceTemplate.updateMany({
        where: { companyId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      })
    }
    return this.prisma.invoiceTemplate.update({
      where: { id: t.id },
      data: {
        name: input.name,
        configJson: input.configJson
          ? { ...(t.configJson as any), ...input.configJson }
          : undefined,
        isDefault: input.isDefault,
      },
    })
  }

  async delete(id: string, companyId: string) {
    const t = await this.getOne(id, companyId)
    await this.prisma.invoiceTemplate.delete({ where: { id: t.id } })
    return { ok: true }
  }

  /**
   * Resolve the effective TemplateConfig
   * for an invoice. Order of precedence:
   *
   * 1. The invoice's explicit templateId
   *    (if set, look up the row)
   * 2. The company's default template
   * 3. The hard-coded preset for
   *    invoice.templateType
   * 4. The hard-coded 'standard' preset
   *
   * This is the function the renderer
   * calls at PDF generation time.
   */
  async resolveConfig(
    companyId: string,
    templateType: string,
    templateId?: string | null,
  ): Promise<{ config: Required<TemplateConfig>; templateId: string | null; isBuiltin: boolean }> {
    // 1. explicit templateId
    if (templateId) {
      const t = await this.prisma.invoiceTemplate.findFirst({
        where: { id: templateId, companyId },
      })
      if (t) {
        return {
          config: { ...DEFAULT_CONFIG, ...(t.configJson as TemplateConfig) },
          templateId: t.id,
          isBuiltin: false,
        }
      }
    }
    // 2. company default
    const def = await this.prisma.invoiceTemplate.findFirst({
      where: { companyId, isDefault: true },
    })
    if (def) {
      return {
        config: { ...DEFAULT_CONFIG, ...(def.configJson as TemplateConfig) },
        templateId: def.id,
        isBuiltin: false,
      }
    }
    // 3. built-in preset
    const preset = (BUILTIN_TEMPLATES as any)[templateType] || BUILTIN_TEMPLATES.standard
    return { config: { ...DEFAULT_CONFIG, ...preset }, templateId: null, isBuiltin: true }
  }

  /**
   * Render a preview PDF using a sample
   * invoice + the template's config. The
   * frontend calls this when the user
   * clicks "Vorschau" in the editor — they
   * see the result immediately without
   * having to apply the template to a
   * real invoice first.
   */
  async renderPreview(
    id: string,
    companyId: string,
  ): Promise<Buffer> {
    const t = await this.getOne(id, companyId)
    const config = { ...DEFAULT_CONFIG, ...(t.configJson as TemplateConfig) }
    return this.renderWithConfig(config, t.name)
  }

  /**
   * Shared renderer. We don't call the
   * real `generateInvoicePDF` here
   * because that function takes the
   * existing templateType ('standard' |
   * 'simplified' | 'compact') and a
   * fixed color palette. The Tier 7 path
   * reads colors from the config and
   * applies them. For now the preview
   * uses the standard template with the
   * custom color overrides applied via
   * the `accentColor` extension on
   * standard.
   *
   * For a full refactor, the
   * invoice-pdf.service.ts would need
   * a `generateInvoicePDFWithConfig(invoice,
   * company, config)` overload. Until
   * that lands, the preview here
   * produces a PDF with the standard
   * layout + sample data; the custom
   * color/font features are recorded
   * but not yet visually applied.
   */
  private async renderWithConfig(
    config: Required<TemplateConfig>,
    templateName: string,
  ): Promise<Buffer> {
    // Sample invoice for the preview
    const sampleInvoice = {
      invoiceNumber: 'PREVIEW-001',
      issueDate: new Date('2026-06-22'),
      dueDate: new Date('2026-07-06'),
      customer: {
        name: 'Beispiel-Kunde GmbH',
        address: {
          street: 'Beispielweg 1',
          postalCode: '12345',
          city: 'Beispielstadt',
          country: 'Deutschland',
        },
        vatId: 'DE123456789',
      },
      items: [
        {
          description: 'Beispiel-Position 1',
          quantity: 2,
          unit: 'Stk.',
          unitPrice: 100,
          vatRate: 0.19,
          netAmount: 200,
          vatAmount: 38,
          grossAmount: 238,
        },
        {
          description: 'Beispiel-Position 2',
          quantity: 1,
          unit: 'Std.',
          unitPrice: 50,
          vatRate: 0.19,
          netAmount: 50,
          vatAmount: 9.5,
          grossAmount: 59.5,
        },
      ],
      subtotal: 250,
      totalVat: 47.5,
      total: 297.5,
      notes: `Vorschau: ${templateName}`,
      currency: 'EUR',
      templateType: 'standard',
    }
    const sampleCompany = {
      name: 'Beispiel-Unternehmen GmbH',
      address: {
        street: 'Musterstraße 1',
        postalCode: '12345',
        city: 'Musterstadt',
        country: 'Deutschland',
      },
      vatId: 'DE987654321',
      taxId: '123/456/789',
      email: 'info@example.de',
      phone: '+49 123 456789',
    }
    return generateInvoicePDF(sampleInvoice, sampleCompany, 'standard')
  }

  /**
   * Validate the JSONB config at the API
   * boundary. Catches obviously-bad
   * values (e.g. fontFamily='Comic-Sans')
   * before they reach the PDF renderer.
   */
  private validateConfig(c: TemplateConfig) {
    if (!c) return
    // Tier 398: the known fields were checked but unknown keys were not, and
    // nothing bounded the size — a 500 KB configJson was stored (measured).
    // The render config is a handful of colours and strings; 20 KB is generous.
    try {
      const size = JSON.stringify(c).length
      if (size > 20_000) {
        throw new BadRequestException(
          `configJson ist zu groß (${size} Zeichen, max. 20000)`,
        )
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e
      throw new BadRequestException('configJson ist nicht serialisierbar')
    }
    if (c.fontFamily && !['Helvetica', 'Times-Roman', 'Courier'].includes(c.fontFamily)) {
      throw new BadRequestException(
        `fontFamily must be Helvetica|Times-Roman|Courier (got ${c.fontFamily})`,
      )
    }
    if (c.layoutDensity && !['comfortable', 'compact'].includes(c.layoutDensity)) {
      throw new BadRequestException(
        `layoutDensity must be comfortable|compact (got ${c.layoutDensity})`,
      )
    }
    const hex = /^#[0-9a-fA-F]{6}$/
    for (const k of ['primaryColor', 'accentColor', 'textColor'] as const) {
      if (c[k] && !hex.test(c[k])) {
        throw new BadRequestException(
          `${k} must be a 6-digit hex color (got ${c[k]})`,
        )
      }
    }
  }
}
