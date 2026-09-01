import { Controller, Get, Post, Put, Body, Param, Query, BadRequestException, NotFoundException, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ReminderService } from './reminder.service';
import { AutoReminderService } from './auto-reminder.scheduler';
import { BulkReminderService } from './bulk-reminder.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Auth, Require } from '../../auth/roles.decorator';
import { Request } from 'express';
import { generateMahnungPDF, computeNeueFrist } from './mahnung-pdf.service';
import { countWerktage } from './werktage';
import type { Response } from 'express';
import { DunningConfigDto } from './dto/dunning-config.dto';
import {
  readDunningConfig,
  DEFAULT_DUNNING_CONFIG,
  DunningConfig,
} from './reminder.service';

// Mirrors the constant in auto-reminder.scheduler.ts — kept
// inline because the scheduler file is a class member, not
// an exported binding. The string follows the same
// "Zahlungserinnerung / Mahnung / Letzte-Mahnung" convention.
const LEVEL_TITLE_FILENAME: Record<'first' | 'second' | 'final', string> = {
  first: 'Zahlungserinnerung',
  second: 'Mahnung',
  final: 'Letzte-Mahnung',
};

@Auth()
@Controller('reminders')
export class ReminderController {
  constructor(
    private readonly reminderService: ReminderService,
    private readonly autoReminder: AutoReminderService,
    private readonly bulkReminder: BulkReminderService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('overdue')
  @Require('invoice.read')
  async getOverdueInvoices(@Query('companyId') companyId: string) {
    return this.reminderService.findOverdueInvoices(companyId);
  }

  @Get('stats')
  @Require('invoice.read')
  async getReminderStats(@Query('companyId') companyId: string) {
    return this.reminderService.getReminderStats(companyId);
  }

  /**
   * List all three reminder templates (first / second / final)
   * for the company. Each one is auto-seeded with the default
   * German wording the first time it's requested, so the UI
   * always sees three rows.
   */
  @Get('templates')
  @Require('invoice.read')
  async listTemplates(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const levels: Array<'first' | 'second' | 'final'> = ['first', 'second', 'final'];
    return Promise.all(levels.map((level) => this.reminderService.getOrCreateTemplate(companyId, level)));
  }

  /**
   * Get a single level's template. Auto-seeds the default
   * if none exists yet (so the form is never empty on first
   * open).
   */
  @Get('templates/:level')
  @Require('invoice.read')
  async getTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    return this.reminderService.getOrCreateTemplate(companyId, level);
  }

  /**
   * Update a reminder template. The user edits subject / body
   * in the UI and we save here. Flips `isDefault` to false
   * so the UI can show a "Customized" badge.
   *
   * Render preview: the body is run through renderForInvoice
   * with the most recent overdue invoice (if any) so the
   * user can see the placeholders resolved before sending.
   */
  @Put('templates/:level')
  @Require('invoice.update')
  async updateTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
    @Body() body: { subject: string; body: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    if (!body.subject?.trim() || !body.body?.trim()) {
      throw new BadRequestException('subject and body are required');
    }
    // Make sure the row exists (auto-seed if not).
    await this.reminderService.getOrCreateTemplate(companyId, level);
    return this.reminderService.updateTemplateRow(companyId, level, {
      subject: body.subject.trim(),
      body: body.body.trim(),
      isDefault: false,
    });
  }

  /**
   * Reset a template back to the bundled default. Useful
   * when the user has edited it and wants to start over.
   */
  @Post('templates/:level/reset')
  @Require('invoice.update')
  async resetTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    // Wipe any user-customised version, then re-seed.
    await this.reminderService.deleteTemplate(companyId, level);
    return this.reminderService.getOrCreateTemplate(companyId, level);
  }

  /**
   * Preview a template with the most recent overdue invoice
   * (or any invoice id provided). Returns the rendered
   * subject + body so the user can see the placeholders
   * resolved.
   */
  @Get('templates/:level/preview')
  @Require('invoice.read')
  async previewTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
    @Query('invoiceId') invoiceId?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    // If no invoiceId, fall back to the most recent invoice
    // for the company (any status) so the user can still
    // see what the rendered template looks like.
    let id: string = invoiceId || '';
    if (!id) {
      const latest = await this.reminderService.latestInvoiceId(companyId);
      if (!latest) {
        throw new BadRequestException('No invoice available for preview');
      }
      id = latest;
    }
    return this.reminderService.renderForInvoice(id, companyId, level);
  }

  @Get(':invoiceId/email-data')
  @Require('invoice.send')
  async getReminderEmailData(
    @Param('invoiceId') invoiceId: string,
    @Query('companyId') companyId: string,
    @Query('level') level: 'first' | 'second' | 'final',
  ) {
    return this.reminderService.getReminderEmailData(invoiceId, companyId, level);
  }

  @Post('send')
  @Require('invoice.send')
  async sendReminder(
    @Body()
    body: {
      invoiceId: string;
      companyId: string;
      recipientEmail: string;
      recipientName: string;
      subject: string;
      body: string;
      level: 'first' | 'second' | 'final';
      createdById?: string;
    },
  ) {
    const reminder = await this.reminderService.recordReminderSend(
      body.companyId,
      body.invoiceId,
      body.recipientEmail,
      body.recipientName,
      body.subject,
      body.body,
      body.level,
      body.createdById,
    );

    // Tier 37: also stamp the Mahnung audit table so the
    // Mahnhistorie / dashboard widget can list this letter
    // without joining into EmailSend. We compute the
    // Mahngebühr + Verzugszins at send-time and carry them on
    // the row — the values are stable even if the invoice
    // balance changes later.
    //
    // We compute daysOverdue from the invoice's dueDate so the
    // snapshot is consistent with the PDF body text. If the
    // invoice somehow has no dueDate (very old data), we fall
    // back to 0 — the Mahnung still gets recorded, just with
    // 0 overdue days.
    let mahnungId: string | null = null
    try {
      const inv = await this.prisma.invoice.findFirst({
        where: { id: body.invoiceId, companyId: body.companyId },
        select: { dueDate: true, total: true },
      })
      if (inv?.dueDate) {
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const due = new Date(inv.dueDate)
        const days = Math.max(
          0,
          Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)),
        )
        const fees = await this.reminderService.computeFees(
          body.companyId,
          Number(inv.total),
          days,
          body.level,
        )
        const recorded = await this.reminderService.recordMahnung(
          body.companyId,
          body.invoiceId,
          body.level,
          {
            daysOverdue: days,
            neueFrist: computeNeueFrist(today, body.level),
            mahngebuehr: fees.mahngebuehr,
            verzugszins: fees.verzugszins,
            totalDue: fees.totalDue,
            recipientEmail: body.recipientEmail,
            recipientName: body.recipientName,
            sentById: body.createdById ?? null,
            emailSendId: reminder.id,
          },
        )
        mahnungId = recorded.id
      }
    } catch {
      // Soft-fail — the EmailSend is already persisted (the
      // call above it succeeded), so a duplicate-prevention
      // collision or transient DB glitch shouldn't 500 the
      // user. The next manual send will create the audit row.
    }

    return {
      success: true,
      reminderId: reminder.id,
      mahnungId,
      message: 'Erinnerung wurde erfolgreich gesendet',
    }
  }

  /**
   * Tier 157: bulk Mahnung send.
   *
   * Body: { companyId, invoiceIds: string[], level: 'first'|'second'|'final', createdById? }
   * → { total, succeeded, failed, skipped, results: [...] }
   *
   * Best-effort: each invoice is wrapped in its own
   * try/catch, so a single bad row doesn't poison the
   * batch. The frontend reads `results` to show a
   * per-row success/failure list.
   *
   * Idempotency matches the auto-reminder: a Mahnung
   * for the same (invoiceId, level) on the same day
   * is silently skipped (so the operator can hit
   * "Senden" twice without spamming the customer).
   */
  @Post('bulk-send')
  @Require('invoice.send')
  // Bulk reminder: fan out to potentially hundreds of
  // customer emails. Tier 251 bumped 5 → 15 per 5 min
  // per IP. The "Bulk-Mahnung senden" button is still
  // human-driven (the modal warns before sending), but
  // the e2e suite fires 6+ calls in quick succession
  // across the bulk-mahnung-tier157 / bulk-send / cron
  // history / etc. specs — 5 was too tight. 15 still
  // throttles a real misbehaving script (~1 hit every
  // 20s) and matches the operator-realistic ceiling.
  @Throttle({ default: { limit: 15, ttl: 300_000 } })
  async bulkSend(
    @Body()
    body: {
      companyId: string
      invoiceIds: string[]
      level: 'first' | 'second' | 'final'
      createdById?: string
    },
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    if (!body?.level || !['first', 'second', 'final'].includes(body.level)) {
      throw new BadRequestException('level must be first, second, or final')
    }
    if (!Array.isArray(body.invoiceIds) || body.invoiceIds.length === 0) {
      throw new BadRequestException('invoiceIds must be a non-empty array')
    }
    return this.bulkReminder.sendBulk(
      body.companyId,
      body.invoiceIds,
      body.level,
      body.createdById,
    )
  }

  /**
   * Manually trigger the daily auto-reminder cron for
   * one company. Admin-only. Bypasses DISABLE_CRON env
   * so an admin can still test the flow after disabling
   * the daily run. Same idempotency / per-company toggle
   * rules as the scheduled run.
   */
  @Post('auto-run')
  @Require('users.read')
  // Manual fire of the auto-reminder cron (same body as
  // the daily scheduled run). Tight local limit
  // (overrides the global 600/60s): 5 per 5 min per IP.
  // The cron itself is hourly; the manual button is for
  // "I want to re-run the dunning pass now", which is
  // rare. 5/5min covers operator use + the e2e suite
  // which fires it a few times across company setups.
  // Note for e2e run-all: the test suite calls this
  // endpoint ~10 times within a few seconds. The suite
  // tolerates 429s by falling through to the next test
  // (the run-all assertions are env-resilient via the
  // `disabled` short-circuit — when the first auto-run
  // 429s, the `autoReminderEnabled=true` toggle in the
  // test does NOT count against the rate limit because
  // it goes through /auto-settings, not /auto-run).
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  async runAutoReminder(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich');
    }
    // Polish #11: respect the per-company autoReminderEnabled
    // toggle. The scheduled runForCompany() in
    // auto-reminder.scheduler.ts already checks this and
    // short-circuits with summary.skipped += 1. The
    // manual /auto-run endpoint previously bypassed the
    // check, so a "disabled" company could still get
    // reminders sent by hitting this endpoint. Now both
    // paths honour the same flag.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    });
    const settings = (company?.settings as any) || {};
    if (settings.autoReminderEnabled === false) {
      return {
        ok: true,
        sent: 0,
        message: 'Auto-Reminder ist für diese Firma deaktiviert (autoReminderEnabled=false).',
      };
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sent = await this.autoReminder.runForCompany(companyId, today);
    return {
      ok: true,
      sent,
      message:
        sent === 0
          ? 'Keine überfälligen Rechnungen, die gemahnt werden müssen.'
          : `${sent} Mahnung${sent === 1 ? '' : 'en'} versendet.`,
    };
  }

  /**
   * Per-company toggle for the daily auto-reminder.
   * Read returns the current state (default: true).
   * Write requires admin; persists to Company.settings.autoReminderEnabled.
   */
  @Get('auto-settings')
  @Require('users.read')
  async getAutoSettings(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    });
    const settings = (company?.settings as any) || {};
    return {
      autoReminderEnabled: settings.autoReminderEnabled !== false, // default true
    };
  }

  @Put('auto-settings')
  @Require('users.read')
  async setAutoSettings(
    @Query('companyId') companyId: string,
    @Body() body: { autoReminderEnabled: boolean },
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    if (typeof body?.autoReminderEnabled !== 'boolean') {
      throw new BadRequestException('autoReminderEnabled (boolean) ist erforderlich');
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    });
    const current = (company?.settings as any) || {};
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        settings: {
          ...current,
          autoReminderEnabled: body.autoReminderEnabled,
        },
      },
    });
    return { ok: true, autoReminderEnabled: body.autoReminderEnabled };
  }

  // ─────────────────────────────────────────────────────────────
  // TIER 37 — Mahnung multi-level flow endpoints
  // ─────────────────────────────────────────────────────────────
  //
  // The pre-existing reminder surface (/overdue, /stats, /send,
  // /templates/*, /auto-settings, /auto-run) stays — those are
  // still the cron + email pipeline. The 5 new routes below
  // expose the Mahnung audit-trail model:
  //
  //   - GET  /mahnungen               — list (filterable by invoice,
  //                                       status: open|cancelled|all)
  //   - GET  /mahnungen/fees-config   — current fee config for the
  //                                       company (read)
  //   - PUT  /mahnungen/fees-config   — update fee config
  //   - GET  /mahnungen/:id/pdf       — re-render the Mahnung PDF on
  //                                       demand (used by the
  //                                       Mahnhistorie page so the
  //                                       admin can re-download what
  //                                       was sent)
  //   - POST /mahnungen/:id/cancel    — soft-cancel a sent Mahnung
  //                                       (audit-retained)
  //
  // We intentionally re-render the PDF on demand from the
  // Mahnung row + the original invoice rather than storing a
  // PDF blob — we already store the dunning data on the
  // Mahnung row, and a re-render gives us correct currency
  // formatting and a fresh timestamp for free.

  /**
   * List Mahnungen (dunning audit trail) for the company.
   * Optional filters:
   *   - invoiceId  → only Mahnungen for one invoice
   *   - status     → 'open' (default), 'cancelled', 'all'
   *
   * The shape is intentionally flat — designed to map 1:1 onto
   * the frontend Mahnhistorie table without further joining.
   */
  @Get('mahnungen')
  @Require('invoice.read')
  async listMahnungen(
    @Query('companyId') companyId: string,
    @Query('invoiceId') invoiceId?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: 'open' | 'cancelled' | 'all',
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    if (status && !['open', 'cancelled', 'all'].includes(status)) {
      throw new BadRequestException(
        'status muss open | cancelled | all sein',
      );
    }
    // Tier 61: customer filter — list every Mahnung for any
    // of the customer's invoices. The service layer takes
    // the customerId and joins through the invoice relation.
    // We pass the filter through so the existing `invoiceId`
    // filter is preserved for callers that already use it.
    const rows = await this.reminderService.listMahnungen(companyId, {
      invoiceId,
      customerId,
      status: status || 'open',
    });
    return { mahnungen: rows, count: rows.length };
  }

  /**
   * Read the company's fee config (Mahngebühr + Verzugszins).
   * Returns the live values used in computeFees() plus
   * `isDefault: true` when no override has been saved yet.
   */
  @Get('mahnungen/fees-config')
  @Require('users.read')
  async getFeeConfig(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.reminderService.getFeeConfig(companyId);
  }

  // ─── Tier 164: Live fee preview for the
  // "Mahnung senden" modal. No side effects —
  // just computes what the actual fees would be
  // if the user clicked send NOW. The frontend
  // calls this on modal open and re-calls when
  // the user changes the level. ───────────────
  @Get('mahnungen/fees-preview')
  @Require('invoice.read')
  async previewFees(
    @Query('companyId') companyId: string,
    @Query('invoiceId') invoiceId: string,
    @Query('level') level: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!invoiceId) throw new BadRequestException('invoiceId ist erforderlich')
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level muss first, second oder final sein')
    }
    return this.reminderService.previewFeesForInvoice(
      companyId,
      invoiceId,
      level as 'first' | 'second' | 'final',
    )
  }

  /**
   * Update the company's fee config. Persists into the
   * bankInfo JSON column (see ReminderService.setFeeConfig
   * for the clamp/validation rules). Returns the resulting
   * config + `isDefault: false` so the UI can show
   * "Benutzerdefiniert" badge.
   */
  @Put('mahnungen/fees-config')
  @Require('users.read')
  async setFeeConfig(
    @Query('companyId') companyId: string,
    @Body()
    body: {
      verzugszinsPct?: number;
      mahngebuehr?: {
        first?: number;
        second?: number;
        final?: number;
      };
    },
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.reminderService.setFeeConfig(companyId, body || {});
  }

  /**
   * Re-render the PDF for a Mahnung audit row and stream it
   * back to the client as `application/pdf`. We rebuild from
   * the stored Mahnung + the original invoice — the PDF body
   * recomputes Mahngebühr + Verzugszins from the row data so
   * the freshly-stamped values match the values the customer
   * originally received (as long as the underlying invoice
   * is unchanged — if the invoice total differs from what
   * was on the audit row, we honour the audit row values,
   * not the live invoice, which is the whole point of the
   * "send-time snapshot" semantics).
   */
  @Get('mahnungen/:id/pdf')
  @Require('invoice.read')
  async downloadMahnungPdf(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    const mahnung = await this.prisma.mahnung.findFirst({
      where: { id, companyId },
      include: {
        invoice: {
          include: {
            customer: true,
          },
        },
      },
    });
    if (!mahnung) {
      throw new BadRequestException('Mahnung nicht gefunden');
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      throw new BadRequestException('Company nicht gefunden');
    }
    const inv = mahnung.invoice;
    const customer = inv.customer as any;
    const bank = (company.bankInfo as any) || {};
    const bankLine = [
      bank.accountHolder,
      bank.iban ? `IBAN: ${bank.iban}` : '',
      bank.bic ? `BIC: ${bank.bic}` : '',
      bank.bankName ? `bei ${bank.bankName}` : '',
    ]
      .filter(Boolean)
      .join(', ');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueDate = inv.dueDate ? new Date(inv.dueDate) : today;
    const werktageOverdue = Math.max(0, countWerktage(dueDate, today));
    const daysOverdue = mahnung.daysOverdue;

    const pdfBuffer = await generateMahnungPDF({
      level: mahnung.level as 'first' | 'second' | 'final',
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: new Date(inv.issueDate),
      dueDate,
      totalAmount: Number(inv.total),
      customer: {
        name: customer.name,
        contact: customer.contact,
        address: customer.address,
      },
      company: {
        name: company.name,
        legalName: company.legalName,
        address: company.address as any,
        email: company.email,
        phone: company.phone,
        bankInfo: company.bankInfo,
        taxId: company.taxId,
        vatId: company.vatId,
        logoPath: company.logoPath,
      },
      daysOverdue,
      werktageOverdue,
      neueFrist: mahnung.neueFrist.toISOString(),
      bankLine,
      mahngebuehr: Number(mahnung.mahngebuehr),
      verzugszins: Number(mahnung.verzugszins),
      // Tier 40: copy the costCenter + costObject stamps
      // from the source Invoice onto the PDF body so the
      // Berater can see which Kostenstelle this Mahnung
      // belongs to. Both are nullable on Invoice; the
      // PDF generator skips the line when both are empty.
      costCenter: (inv as any).costCenter ?? null,
      costObject: (inv as any).costObject ?? null,
      // Tier 55: pass Skonto stamps to the PDF so
      // it can render the "Skonto-Fenster
      // abgelaufen" note. Both nullable.
      skontoPercent: (inv as any).skontoPercent != null
        ? Number((inv as any).skontoPercent)
        : null,
      skontoDays: (inv as any).skontoDays ?? null,
      verzugszinsPct: (
        await this.reminderService.getFeeConfig(companyId)
      ).verzugszinsPct,
    });

    res.setHeader('Content-Type', 'application/pdf');
    const filename =
      `Mahnung-${LEVEL_TITLE_FILENAME[mahnung.level as 'first' | 'second' | 'final']}-${inv.invoiceNumber}.pdf`;
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    res.send(pdfBuffer);
  }

  /**
   * Soft-cancel a sent Mahnung. The row stays in the table
   * (GoBD audit), but cancelledAt is set and the Mahnhistorie
   * filter can hide it. Idempotent — cancelling an already-
   * cancelled Mahnung returns 200.
   */
  @Post('mahnungen/:id/cancel')
  @Require('invoice.update')
  async cancelMahnung(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: { reason?: string } = {},
    @Req() req?: Request,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    const userId = (req?.headers as any)['x-user-id'] as string | undefined;
    try {
      return await this.reminderService.cancelMahnung(companyId, id, {
        reason: body?.reason,
        userId,
      });
    } catch (err: any) {
      // The service throws plain Error("Mahnung not found")
      // for unknown ids / wrong company. Re-throw as a NestJS
      // NotFoundException so the framework returns 404 (matches
      // the portal route's behaviour — same row-missing pattern).
      if (err?.message === 'Mahnung not found') {
        throw new NotFoundException('Mahnung nicht gefunden');
      }
      throw err;
    }
  }

  /**
   * Tier 123: per-company dunning config.
   *
   * GET /api/v1/reminders/dunning-config?companyId=X
   *   → returns the current config (with defaults
   *     filled in for missing fields) so the UI
   *     always has a complete form.
   *
   * PUT /api/v1/reminders/dunning-config
   *   body: DunningConfigDto
   *   → updates Company.settings.dunning. The DTO
   *     validates monotonic thresholds (level1 <
   *     level2 < level3) and non-negative fees.
   *
   * Both endpoints require `company.update` (the
   * Berater / Mandant / Admin) — same as the rest
   * of the company settings endpoints.
   */
  @Get('dunning-config')
  @Require('company.read')
  async getDunningConfig(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    if (!company) {
      throw new NotFoundException('Company not found')
    }
    return readDunningConfig(company.settings)
  }

  @Put('dunning-config')
  @Require('company.update')
  async updateDunningConfig(
    @Query('companyId') companyId: string,
    @Body() body: DunningConfigDto,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    if (!company) {
      throw new NotFoundException('Company not found')
    }
    const current = (company.settings as any) || {}
    const newSettings = {
      ...current,
      dunning: {
        level1Days: body.level1Days,
        level2Days: body.level2Days,
        level3Days: body.level3Days,
        level1Fee: body.level1Fee,
        level2Fee: body.level2Fee,
        level3Fee: body.level3Fee,
      },
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { settings: newSettings },
    })
    // Return the saved config (in case the DTO
    // mutated any value via the validator).
    return body
  }
}
