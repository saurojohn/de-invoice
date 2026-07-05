import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface OverdueInvoice {
  id: string;
  invoiceNumber: string;
  customer: {
    name: string;
    contact: {
      email?: string;
      name?: string;
    };
    address: {
      street?: string;
      postalCode?: string;
      city?: string;
      country?: string;
    };
  };
  total: string;
  dueDate: string;
  // Rechnungsdatum — needed by the Mahnung PDF and
  // by the auto-reminder cron (which renders the
  // invoice date on the letter). Added in 3a-c.
  issueDate: string;
  daysOverdue: number;
  language: string;
  reminderCount: number;
  // Tier 40: cost-center stamps copied from Invoice.
  // Sent-through to the Mahnung PDF generator.
  costCenter: string | null;
  costObject: string | null;
}

export interface ReminderTemplate {
  subject: string;
  body: string;
  level?: 'first' | 'second' | 'final';
}

@Injectable()
export class ReminderService {
  constructor(protected prisma: PrismaService) {}

  /**
   * Update a reminder template row directly. Used by the
   * controller's PUT /templates/:level route — exposed as
   * a service method so the controller doesn't have to
   * reach into `prisma` (which would require making the
   * PrismaService field public).
   */
  async updateTemplateRow(
    companyId: string,
    level: 'first' | 'second' | 'final',
    data: { subject: string; body: string; isDefault: boolean },
  ) {
    return this.prisma.reminderTemplate.update({
      where: { companyId_level: { companyId, level } },
      data,
    });
  }

  /**
   * Delete any user-customised template so the next call
   * to getOrCreateTemplate re-seeds the default.
   */
  async deleteTemplate(companyId: string, level: 'first' | 'second' | 'final') {
    return this.prisma.reminderTemplate.deleteMany({ where: { companyId, level } });
  }

  /**
   * Return the most recent invoice id for the company, used
   * by the template preview route when the caller doesn't
   * supply an invoiceId.
   */
  async latestInvoiceId(companyId: string): Promise<string | null> {
    const r = await this.prisma.invoice.findFirst({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return r?.id || null;
  }

  /**
   * Find all overdue invoices for a company
   * Overdue = status is 'sent' and dueDate < today
   */
  async findOverdueInvoices(companyId: string): Promise<OverdueInvoice[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        status: 'sent',
        dueDate: {
          lt: today,
        },
        type: 'INV', // Only standard invoices, not credit notes
      },
      include: {
        customer: true,
        emailSends: {
          where: {
            templateType: {
              in: ['reminder_first', 'reminder_second', 'reminder_final'],
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { dueDate: 'asc' },
    });

    return invoices.map((inv) => {
      const dueDate = new Date(inv.dueDate!);
      const diffTime = today.getTime() - dueDate.getTime();
      const daysOverdue = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      // Count reminders by type
      const reminderCounts = inv.emailSends.reduce(
        (acc, email) => {
          if (email.templateType === 'reminder_first') acc.first++;
          else if (email.templateType === 'reminder_second') acc.second++;
          else if (email.templateType === 'reminder_final') acc.final++;
          return acc;
        },
        { first: 0, second: 0, final: 0 },
      );

      const totalReminders = reminderCounts.first + reminderCounts.second + reminderCounts.final;

      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customer: {
          name: inv.customer.name,
          contact: inv.customer.contact as any,
          address: inv.customer.address as any,
        },
        total: inv.total.toString(),
        dueDate: inv.dueDate!.toISOString(),
        issueDate: inv.issueDate.toISOString(),
        daysOverdue,
        language: inv.language || 'de-DE',
        reminderCount: totalReminders,
        // Tier 40: cost-center stamps from Invoice. Copied
        // onto the auto-send Mahnung PDF so the Berater can
        // see the cost-center assignment without cross-
        // referencing the underlying invoice.
        costCenter: (inv as any).costCenter ?? null,
        costObject: (inv as any).costObject ?? null,
      };
    });
  }

  /**
   * Generate reminder email content based on reminder level
   */
  generateReminderEmail(
    invoice: OverdueInvoice,
    company: { name: string; email?: string; address?: any; bankInfo?: any },
    level: 'first' | 'second' | 'final',
  ): ReminderTemplate {
    const customerName = invoice.customer.contact?.name || invoice.customer.name;
    const totalAmount = parseFloat(invoice.total).toFixed(2);
    const dueDateFormatted = new Date(invoice.dueDate).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });

    const templates: Record<'first' | 'second' | 'final', ReminderTemplate> = {
      first: {
        subject: `Erinnerung: Rechnung ${invoice.invoiceNumber} ist überfällig`,
        body: `Sehr geehrte/r ${customerName},

hiermit möchten wir Sie freundlich daran erinnern, dass die Rechnung ${invoice.invoiceNumber} vom ${dueDateFormatted} mit einem Betrag von EUR ${totalAmount} bereits überfällig ist.

Die Zahlung ist seit ${invoice.daysOverdue} Tag(en) überfällig.

Bitte begleichen Sie den offenen Betrag innerhalb von 14 Tagen auf folgendes Konto:

${company.bankInfo ? `Bank: ${company.bankInfo.bankName || ''}
Kontoinhaber: ${company.bankInfo.accountHolder || company.name}
IBAN: ${company.bankInfo.iban || ''}
BIC: ${company.bankInfo.bic || ''}` : ''}

Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.

Mit freundlichen Grüßen,
${company.name}`,
      },
      second: {
        subject: `2. Mahnung: Rechnung ${invoice.invoiceNumber} - Zahlung sofort erforderlich`,
        body: `Sehr geehrte/r ${customerName},

leider mussten wir feststellen, dass die Rechnung ${invoice.invoiceNumber} vom ${dueDateFormatted} trotz unserer ersten Erinnerung noch nicht beglichen wurde.

Fälliger Betrag: EUR ${totalAmount}
Überfällig seit: ${invoice.daysOverdue} Tag(en)

Wir bitten Sie, den offenen Betrag unverzüglich, spätestens jedoch innerhalb von 7 Tagen, auf folgendes Konto zu überweisen:

${company.bankInfo ? `Bank: ${company.bankInfo.bankName || ''}
Kontoinhaber: ${company.bankInfo.accountHolder || company.name}
IBAN: ${company.bankInfo.iban || ''}
BIC: ${company.bankInfo.bic || ''}` : ''}

Sollte die Zahlung nicht innerhalb der genannten Frist erfolgen, sehen wir uns gezwungen, weitere Schritte einzuleiten.

Mit freundlichen Grüßen,
${company.name}`,
      },
      final: {
        subject: `Letzte Mahnung: Rechnung ${invoice.invoiceNumber} - Außergerichtliches Inkasso`,
        body: `Sehr geehrte/r ${customerName},

trotz mehrfacher Aufforderung bleibt die Rechnung ${invoice.invoiceNumber} vom ${dueDateFormatted} weiterhin unbeglichen.

Offener Betrag: EUR ${totalAmount}
Überfällig seit: ${invoice.daysOverdue} Tag(en)

Dies ist unsere LETZTE Mahnung. Wir fordern Sie auf, den offenen Betrag innerhalb von 5 Tagen auf folgendes Konto zu überweisen:

${company.bankInfo ? `Bank: ${company.bankInfo.bankName || ''}
Kontoinhaber: ${company.bankInfo.accountHolder || company.name}
IBAN: ${company.bankInfo.iban || ''}
BIC: ${company.bankInfo.bic || ''}` : ''}

Erfolgt keine Zahlung innerhalb dieser Frist, werden wir die Angelegenheit an ein Inkassobüro übergeben. Die daraus entstehenden Kosten werden Ihnen in Rechnung gestellt.

Wir bitten Sie, die Zahlung umgehend zu veranlassen.

Mit freundlichen Grüßen,
${company.name}`,
      },
    };

    return templates[level];
  }

  /**
   * Determine the appropriate reminder level based on previous reminders
   */
  getNextReminderLevel(previousReminders: number): 'first' | 'second' | 'final' {
    if (previousReminders === 0) return 'first';
    if (previousReminders === 1) return 'second';
    return 'final';
  }

  /**
   * Record a reminder email send
   */
  async recordReminderSend(
    companyId: string,
    invoiceId: string,
    recipientEmail: string,
    recipientName: string,
    subject: string,
    body: string,
    level: 'first' | 'second' | 'final',
    createdById?: string,
  ) {
    return this.prisma.emailSend.create({
      data: {
        companyId,
        invoiceId,
        templateType: `reminder_${level}`,
        recipientEmail,
        recipientName,
        subject,
        bodyPreview: body.substring(0, 500),
        status: 'sent',
        sentAt: new Date(),
        createdById,
      },
    });
  }

  /**
   * Get the per-company template for a level. If the
   * company has never saved one, seed the three default
   * German templates (matching the previous hard-coded
   * wording) so the page works out of the box. The seeded
   * rows are flagged `isDefault=true` so the UI can
   * distinguish "unedited" from "edited by the user".
   */
  async getOrCreateTemplate(companyId: string, level: 'first' | 'second' | 'final') {
    const existing = await this.prisma.reminderTemplate.findUnique({
      where: { companyId_level: { companyId, level } },
    })
    if (existing) return existing

    // Seed defaults for the level the caller asked for.
    // Use the same wording the previous generateReminderEmail
    // hard-coded — preserves the user-visible behaviour.
    const defaults = this.defaultTemplates()
    return this.prisma.reminderTemplate.create({
      data: {
        companyId,
        level,
        subject: defaults[level].subject,
        body: defaults[level].body,
        isDefault: true,
      },
    })
  }

  /**
   * Default German templates. These are the seed values
   * for new companies; the user can edit them in the UI
   * and the override persists in ReminderTemplate.
   */
  private defaultTemplates(): Record<'first' | 'second' | 'final', { subject: string; body: string }> {
    return {
      first: {
        subject: 'Erinnerung: Rechnung {{invoiceNumber}} ist überfällig',
        body: `Sehr geehrte/r {{customerName}},

hiermit möchten wir Sie freundlich daran erinnern, dass die Rechnung {{invoiceNumber}} vom {{dueDateFormatted}} mit einem Betrag von EUR {{totalAmount}} bereits überfällig ist.

Die Zahlung ist seit {{daysOverdue}} Tag(en) überfällig.

Bitte begleichen Sie den offenen Betrag innerhalb von 14 Tagen auf folgendes Konto:

{{bankInfo}}

Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.

Mit freundlichen Grüßen,
{{companyName}}`,
      },
      second: {
        subject: '2. Mahnung: Rechnung {{invoiceNumber}} - Zahlung sofort erforderlich',
        body: `Sehr geehrte/r {{customerName}},

leider mussten wir feststellen, dass die Rechnung {{invoiceNumber}} vom {{dueDateFormatted}} trotz unserer ersten Erinnerung noch nicht beglichen wurde.

Fälliger Betrag: EUR {{totalAmount}}
Überfällig seit: {{daysOverdue}} Tag(en)

Wir bitten Sie, den offenen Betrag unverzüglich, spätestens jedoch innerhalb von 7 Tagen, auf folgendes Konto zu überweisen:

{{bankInfo}}

Sollte die Zahlung nicht innerhalb der genannten Frist erfolgen, sehen wir uns gezwungen, weitere Schritte einzuleiten.

Mit freundlichen Grüßen,
{{companyName}}`,
      },
      final: {
        subject: 'Letzte Mahnung: Rechnung {{invoiceNumber}} - Außergerichtliches Inkasso',
        body: `Sehr geehrte/r {{customerName}},

trotz mehrfacher Aufforderung bleibt die Rechnung {{invoiceNumber}} vom {{dueDateFormatted}} weiterhin unbeglichen.

Offener Betrag: EUR {{totalAmount}}
Überfällig seit: {{daysOverdue}} Tag(en)

Dies ist unsere LETZTE Mahnung. Wir fordern Sie auf, den offenen Betrag innerhalb von 5 Tagen auf folgendes Konto zu überweisen:

{{bankInfo}}

Nach fruchtlosem Ablauf der Frist werden wir weitere rechtliche Schritte einleiten.

Mit freundlichen Grüßen,
{{companyName}}`,
      },
    }
  }

  /**
   * Render a template by replacing {{placeholder}} tokens
   * with values from the context. Unknown placeholders are
   * left as-is so the user can spot typos in their custom
   * template.
   */
  renderTemplate(template: string, ctx: Record<string, string | number>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
      const v = ctx[key]
      if (v === undefined || v === null) return match
      return String(v)
    })
  }

  /**
   * Render the per-level template for an invoice, using
   * the company's saved template (or the default if none).
   * Returns the rendered subject + body.
   */
  async renderForInvoice(
    invoiceId: string,
    companyId: string,
    level: 'first' | 'second' | 'final',
  ): Promise<{ subject: string; body: string }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: { customer: true },
    })
    if (!invoice) throw new Error('Invoice not found')

    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) throw new Error('Company not found')

    const template = await this.getOrCreateTemplate(companyId, level)

    const customerName =
      (invoice.customer.contact as any)?.name || invoice.customer.name
    const totalAmount = parseFloat(invoice.total.toString()).toFixed(2)
    const dueDateFormatted = new Date(invoice.dueDate!).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    })
    const daysOverdue = Math.floor(
      (Date.now() - new Date(invoice.dueDate!).getTime()) / (1000 * 60 * 60 * 24),
    )
    const bank = (company as any).bankInfo || {}
    const bankInfo = [
      bank.bankName && `Bank: ${bank.bankName}`,
      bank.accountHolder && `Kontoinhaber: ${bank.accountHolder}`,
      bank.iban && `IBAN: ${bank.iban}`,
      bank.bic && `BIC: ${bank.bic}`,
    ].filter(Boolean).join('\n')

    const ctx: Record<string, string | number> = {
      customerName,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount,
      dueDateFormatted,
      daysOverdue,
      bankInfo: bankInfo || '(Bankverbindung fehlt — bitte unter Einstellungen ergänzen)',
      companyName: company.name,
    }

    return {
      subject: this.renderTemplate(template.subject, ctx),
      body: this.renderTemplate(template.body, ctx),
    }
  }

  /**
   * Get email data for a specific reminder level
   */
  async getReminderEmailData(
    invoiceId: string,
    companyId: string,
    level: 'first' | 'second' | 'final',
  ) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: { customer: true },
    });

    if (!invoice) {
      throw new Error('Invoice not found');
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      throw new Error('Company not found');
    }

    const overdueInvoice: OverdueInvoice = {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customer: {
        name: invoice.customer.name,
        contact: invoice.customer.contact as any,
        address: invoice.customer.address as any,
      },
      total: invoice.total.toString(),
      dueDate: invoice.dueDate!.toISOString(),
      issueDate: invoice.issueDate.toISOString(),
      daysOverdue: Math.floor(
        (new Date().getTime() - new Date(invoice.dueDate!).getTime()) / (1000 * 60 * 60 * 24),
      ),
      language: invoice.language || 'de-DE',
      reminderCount: 0,
      // Tier 40: not strictly needed for the email-data
      // path but the OverdueInvoice shape requires it.
      // Pulled from the source invoice when present.
      costCenter: (invoice as any).costCenter ?? null,
      costObject: (invoice as any).costObject ?? null,
    };

    // Render from the per-company DB template (or the
    // default seeded on first request). Replaces the old
    // hard-coded generateReminderEmail — see renderForInvoice
    // for the placeholder context.
    const rendered = await this.renderForInvoice(invoiceId, companyId, level);

    const recipientEmail = (invoice.customer.contact as any)?.email || '';
    const recipientName = (invoice.customer.contact as any)?.name || invoice.customer.name;

    return {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      recipientEmail,
      recipientName,
      subject: rendered.subject,
      body: rendered.body,
      level,
      pdfUrl: `/api/v1/invoices/${invoiceId}/pdf?companyId=${companyId}`,
    };
  }

  /**
   * Get reminder statistics for dashboard
   */
  async getReminderStats(companyId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [overdueCount, totalOverdueAmount, recentReminders] = await Promise.all([
      this.prisma.invoice.count({
        where: {
          companyId,
          status: 'sent',
          dueDate: { lt: today },
          type: 'INV',
        },
      }),
      this.prisma.invoice.aggregate({
        where: {
          companyId,
          status: 'sent',
          dueDate: { lt: today },
          type: 'INV',
        },
        _sum: { total: true },
      }),
      this.prisma.emailSend.count({
        where: {
          companyId,
          templateType: { startsWith: 'reminder_' },
          createdAt: {
            gte: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
          },
        },
      }),
    ]);

    return {
      overdueCount,
      totalOverdueAmount: totalOverdueAmount._sum.total?.toString() || '0',
      recentReminders,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // TIER 37: Mahnung multi-level flow extensions
  // ─────────────────────────────────────────────────────────────────────
  //
  // The pre-existing Tier 12 reminder code path records the send in
  // EmailSend (templateType = "reminder_first|second|final"). That was fine
  // for "did the email go out" but doesn't carry the dunning-specific
  // fields the user now wants to see:
  //
  //   - Mahngebühr + Verzugszins at THIS level (stamped at send-time)
  //   - NeueFrist + daysOverdue snapshot (so the row is self-describing
  //     even if the invoice changes later)
  //   - Soft-cancel stamp (cancelledAt) — fires from admin-cancel or from
  //     payment.service on full settlement of the invoice
  //
  // All of these live in the new `Mahnung` model (see the migration
  // 20260704000001_mahnung). The methods below wrap the model.

  /**
   * Per-company fee config for the late-interest calculation. Lives in
   * Company.bankInfo JSON because adding three scalar columns for a
   * feature tier we just shipped would be premature — config rarely
   * changes (most companies stick with the BGB defaults) and the JSON
   * keeps the schema clean.
   *
   * Default values per §288 BGB:
   *   - verzugszinsPct: 9.0 % per annum over Basiszinssatz for B2B
   *   - mahngebuehr first:  0.00 € (a friendly Zahlungserinnerung)
   *   - mahngebuehr second: 2.50 €
   *   - mahngebuehr final:  5.00 €
   *
   * The Verzugszins is computed as:
   *   principal × (pct / 100) × (days / 365)
   * rounded to two decimals on the Mahnung row and the PDF.
   */
  async getFeeConfig(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { bankInfo: true },
    });
    const cfg = (company?.bankInfo as any)?.mahnungConfig || {};
    return {
      verzugszinsPct: typeof cfg.verzugszinsPct === 'number' ? cfg.verzugszinsPct : 9.0,
      mahngebuehr: {
        first: typeof cfg.mahngebuehr?.first === 'number' ? cfg.mahngebuehr.first : 0,
        second: typeof cfg.mahngebuehr?.second === 'number' ? cfg.mahngebuehr.second : 2.5,
        final: typeof cfg.mahngebuehr?.final === 'number' ? cfg.mahngebuehr.final : 5.0,
      },
      isDefault: !cfg || Object.keys(cfg).length === 0,
    };
  }

  /**
   * Update the per-company fee config. Persists into the bankInfo
   * JSON column under `mahnungConfig`. Validation: numbers only,
   * non-negative. clamped: verzugszinsPct ∈ [0, 50], mahngebuehr per
   * level ∈ [0, 1000].
   */
  async setFeeConfig(
    companyId: string,
    data: {
      verzugszinsPct?: number;
      mahngebuehr?: {
        first?: number;
        second?: number;
        final?: number;
      };
    },
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { bankInfo: true },
    });
    const bank = (company?.bankInfo as any) || {};
    const cur = (bank.mahnungConfig as any) || {};
    const clamp = (v: unknown, min: number, max: number) => {
      const n = Number(v);
      if (Number.isNaN(n)) return undefined;
      return Math.min(max, Math.max(min, n));
    };
    const next = {
      verzugszinsPct:
        data.verzugszinsPct !== undefined
          ? clamp(data.verzugszinsPct, 0, 50) ?? cur.verzugszinsPct
          : cur.verzugszinsPct,
      mahngebuehr: {
        first:
          data.mahngebuehr?.first !== undefined
            ? clamp(data.mahngebuehr.first, 0, 1000) ?? cur.mahngebuehr?.first
            : cur.mahngebuehr?.first,
        second:
          data.mahngebuehr?.second !== undefined
            ? clamp(data.mahngebuehr.second, 0, 1000) ?? cur.mahngebuehr?.second
            : cur.mahngebuehr?.second,
        final:
          data.mahngebuehr?.final !== undefined
            ? clamp(data.mahngebuehr.final, 0, 1000) ?? cur.mahngebuehr?.final
            : cur.mahngebuehr?.final,
      },
    };
    const mergedBank = { ...bank, mahnungConfig: next };
    await this.prisma.company.update({
      where: { id: companyId },
      data: { bankInfo: mergedBank },
    });
    return { ok: true, config: { ...next, isDefault: false } };
  }

  /**
   * Compute Verzugszins + Mahngebühr for a Mahnung at send-time.
   *
   * The Verzugszins formula (annualised) is:
   *   principal × pct/100 × days/365
   * We round to two decimals (toFixed(2)) because the PDF line
   * item is shown as a currency value. The unrounded value would
   *   look the same to the customer but leak 0.001 € of noise into
   *   the UStVA reconciliation later, so we round here AND recompute
   *   the totalDue with the rounded Mahngebühr + Verzugszins so the
   *   sum adds up on the PDF.
   *
   * `principal` is the open invoice amount (gross), not net —
   * Verzugszins is on the gross because that's what the customer
   * owed on the dueDate. Net-based would be wrong by the VAT share.
   */
  async computeFees(
    companyId: string,
    principalGross: number,
    daysOverdue: number,
    level: 'first' | 'second' | 'final',
  ) {
    const cfg = await this.getFeeConfig(companyId);
    const mahngebuehr = cfg.mahngebuehr[level] || 0;
    const verzugszinsRaw =
      principalGross * ((cfg.verzugszinsPct as number) / 100) * (daysOverdue / 365);
    const verzugszins = Math.round(verzugszinsRaw * 100) / 100;
    const mahngebuehrRounded = Math.round(mahngebuehr * 100) / 100;
    const totalDue =
      Math.round((principalGross + mahngebuehrRounded + verzugszins) * 100) / 100;
    return {
      mahngebuehr: mahngebuehrRounded,
      verzugszins,
      verzugszinsPct: cfg.verzugszinsPct,
      totalDue,
    };
  }

  /**
   * Record a Mahnung row + return its id. Idempotent on
   * (invoiceId, level, sentAt-bucket of today) — if an active
   * Mahnung for the same invoice + level already exists for
   * today, we re-use it (return its id, don't insert a second).
   * This is the same idempotency rule the auto-reminder cron uses
   * on the EmailSend side, but anchored at the dunning-layer
   * model that the UI actually reads.
   */
  async recordMahnung(
    companyId: string,
    invoiceId: string,
    level: 'first' | 'second' | 'final',
    payload: {
      daysOverdue: number;
      neueFrist: Date;
      mahngebuehr: number;
      verzugszins: number;
      totalDue: number;
      recipientEmail: string;
      recipientName: string;
      sentById?: string | null;
      emailSendId?: string | null;
    },
  ): Promise<{ id: string; created: boolean }> {
    const today = new Date();
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setDate(end.getDate() + 1);

    const existing = await this.prisma.mahnung.findFirst({
      where: {
        companyId,
        invoiceId,
        level,
        sentAt: { gte: start, lt: end },
        cancelledAt: null,
      },
    });
    if (existing) {
      // Refuse to double-charge — the cron / manual send will
      // already have updated fees on the in-flight row. Just
      // return the existing id.
      return { id: existing.id, created: false };
    }
    const row = await this.prisma.mahnung.create({
      data: {
        companyId,
        invoiceId,
        level,
        daysOverdue: payload.daysOverdue,
        neueFrist: payload.neueFrist,
        mahngebuehr: payload.mahngebuehr,
        verzugszins: payload.verzugszins,
        totalDue: payload.totalDue,
        recipientEmail: payload.recipientEmail,
        recipientName: payload.recipientName,
        sentById: payload.sentById ?? null,
        emailSendId: payload.emailSendId ?? null,
      },
    });
    return { id: row.id, created: true };
  }

  /**
   * List Mahnungen. Optional filters:
   *   - invoiceId: show only Mahnungen for one invoice (UI tab)
   *   - status: 'open' (no cancelledAt) | 'cancelled' | 'all'
   *
   * Sorted by sentAt DESC so the dashboard widget shows the
   * newest letter first.
   */
  async listMahnungen(
    companyId: string,
    opts: { invoiceId?: string; status?: 'open' | 'cancelled' | 'all' } = {},
  ) {
    const where: any = { companyId }
    if (opts.invoiceId) where.invoiceId = opts.invoiceId
    if (opts.status === 'open') where.cancelledAt = null
    if (opts.status === 'cancelled') where.cancelledAt = { not: null }
    // 'all' → no extra filter
    const rows = await this.prisma.mahnung.findMany({
      where,
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
            issueDate: true,
            dueDate: true,
            customerId: true,
            total: true,
            // Tier 40: copy the cost-center stamps onto the
            // list response so the Mahnhistorie UI can show
            // a "Kostenstelle" column alongside invoice
            // number + customer.
            costCenter: true,
            costObject: true,
            customer: {
              select: { name: true, customerNumber: true, contact: true },
            },
          },
        },
      },
      orderBy: { sentAt: 'desc' },
    })
    return rows.map((r) => ({
      id: r.id,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoice.invoiceNumber,
      customerName: r.invoice.customer.name,
      customerNumber: (r.invoice.customer as any).customerNumber,
      issueDate: r.invoice.issueDate,
      dueDate: r.invoice.dueDate,
      invoiceTotal: Number(r.invoice.total),
      // Tier 40: pass through cost-center stamps from the
      // source Invoice. Both nullable — the frontend
      // shows "—" when empty, matching the dashboard's
      // Kostenstelle column UX.
      costCenter: r.invoice.costCenter ?? null,
      costObject: r.invoice.costObject ?? null,
      level: r.level,
      daysOverdue: r.daysOverdue,
      neueFrist: r.neueFrist,
      mahngebuehr: Number(r.mahngebuehr),
      verzugszins: Number(r.verzugszins),
      totalDue: Number(r.totalDue),
      recipientEmail: r.recipientEmail,
      recipientName: r.recipientName,
      sentAt: r.sentAt,
      sentById: r.sentById,
      cancelledAt: r.cancelledAt,
      cancelledById: r.cancelledById,
      cancelReason: r.cancelReason,
    }))
  }

  /**
   * Admin-initiated soft-cancel of a sent Mahnung. Idempotent —
   * cancelling a row that is already cancelled is a no-op (returns
   * 200 with the existing cancel stamp). Use case: a Mahnung went
   * out in error, or the customer paid before the letter arrived
   * and the admin wants the trail to reflect that.
   */
  async cancelMahnung(
    companyId: string,
    mahnungId: string,
    opts: {
      reason?: string;
      userId?: string;
    } = {},
  ) {
    const row = await this.prisma.mahnung.findFirst({
      where: { id: mahnungId, companyId },
    });
    if (!row) {
      throw new Error('Mahnung not found');
    }
    if (row.cancelledAt) {
      return { ok: true, alreadyCancelled: true };
    }
    await this.prisma.mahnung.update({
      where: { id: mahnungId },
      data: {
        cancelledAt: new Date(),
        cancelledById: opts.userId ?? null,
        cancelReason: opts.reason ?? null,
      },
    });
    return { ok: true, alreadyCancelled: false };
  }

  /**
   * Bulk-cancel every open Mahnung for an invoice. Called from
   * PaymentService when a payment brings the invoice to 'paid' —
   * any outstanding dunning letters are void (the customer paid,
   * the letter is moot). Returns the count of rows touched.
   */
  async cancelOpenMahnungenForInvoice(
    companyId: string,
    invoiceId: string,
    opts: { reason?: string; userId?: string } = {},
  ): Promise<{ cancelled: number }> {
    const res = await this.prisma.mahnung.updateMany({
      where: {
        companyId,
        invoiceId,
        cancelledAt: null,
      },
      data: {
        cancelledAt: new Date(),
        cancelledById: opts.userId ?? null,
        cancelReason: opts.reason ?? 'invoice paid',
      },
    });
    return { cancelled: res.count };
  }
}