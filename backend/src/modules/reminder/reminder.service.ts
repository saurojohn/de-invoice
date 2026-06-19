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
}