import { Controller, Get, Put, Patch, Post, Body, Param, UseInterceptors, UploadedFile, BadRequestException, Req, UseGuards, Header } from '@nestjs/common';
import { CompanyService } from './company.service';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { Auth, Require } from '../../auth/roles.decorator';
import { HeaderAuthGuard } from '../../auth/header-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SKR03_DEFAULTS,
  resolveDatevAccounts,
  sanitizeDatevConfig,
  type DatevAccountMap,
} from '../reports/datev.service';
import * as fs from 'fs';
import * as path from 'path';
import { Request } from 'express';

@Controller('companies')
export class CompanyController {
  constructor(
    private companyService: CompanyService,
    private prisma: PrismaService,
  ) {}

  @Auth()
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.companyService.findById(id);
  }

  @Auth()
  @Require('company.update')
  @Put(':id')
  async update(@Param('id') id: string, @Body() data: UpdateCompanyDto) {
    return this.companyService.update(id, data);
  }

  /**
   * Per-company DATEV account map. Returned merged over
   * SKR03_DEFAULTS so the UI can show every field with
   * its current value (override or fallback). The frontend
   * uses this to pre-populate the settings form.
   *
   * The endpoint is @Auth()-protected (header auth, requires
   * the caller to be a member of the company). The
   * per-action permission is not enforced here because the
   * company module doesn't have a 'company.read' action in
   * the permission matrix (only 'company.update' — and we
   * don't want to require admin role just to read the
   * config). Accountants / viewers of the company should be
   * able to see what account map will be used.
   */
  @Auth()
  @Get(':id/datev-config')
  async getDatevConfig(@Param('id') id: string) {
    const company = await this.companyService.findById(id)
    const settings = (company as any)?.settings || {}
    const datevSettings = settings.datev || {}
    // sanitizeDatevConfig only recognises the 13
    // account fields. beraterNr / mandantenNr are
    // 5-digit strings, stored as-is, NOT through
    // sanitizeDatevConfig (which only iterates the
    // SKR03_DEFAULTS keys and would drop them).
    // So the "overrides" the UI sees for beraterNr /
    // mandantenNr come straight from settings.datev.
    const overrides: any = sanitizeDatevConfig(datevSettings)
    if (typeof datevSettings.beraterNr === 'string') {
      overrides.beraterNr = datevSettings.beraterNr
    }
    if (typeof datevSettings.mandantenNr === 'string') {
      overrides.mandantenNr = datevSettings.mandantenNr
    }
    // Tier 5: opening balances (EB-Werte) and per-year
    // Buchungslauf counter are stored alongside the
    // account map. Pass them through unchanged — the
    // sanitizeDatevConfig only touches the 4-5 digit
    // account numbers.
    const openingBalances = Array.isArray(datevSettings.openingBalances)
      ? datevSettings.openingBalances
      : []
    const laufNr = (datevSettings.laufNr && typeof datevSettings.laufNr === 'object')
      ? datevSettings.laufNr
      : {}
    // Return both the merged map (so the UI sees what will
    // actually be used) AND the raw overrides (so the UI
    // can blank out the form for fields the user has not
    // explicitly customised).
    return {
      config: resolveDatevAccounts(overrides),
      overrides,
      defaults: SKR03_DEFAULTS,
      openingBalances,
      laufNr,
    }
  }

  /**
   * Save the per-company DATEV account map. Each account
   * is validated to be a numeric 3-5 digit string; anything
   * else is silently dropped (so the form can be tolerant
   * of partially-filled states). Berater-Nr / Mandanten-Nr
   * are stored here too (5-digit each, zero-padded).
   *
   * Tier 5: also accepts `openingBalances` (array of
   * {konto, betrag, shVz, buchungstext}) and `laufNr`
   * (per-year counter map, e.g. {2026: 1}). These are
   * round-tripped verbatim — the client validates and
   * normalises.
   */
  @Auth()
  @Require('company.update')
  @Put(':id/datev-config')
  async saveDatevConfig(
    @Param('id') id: string,
    @Body() body: {
      accounts?: Partial<DatevAccountMap>;
      beraterNr?: string;
      mandantenNr?: string;
      openingBalances?: Array<{ konto: string; betrag: number; shVz: 'S' | 'H'; buchungstext: string }>;
      laufNr?: Record<number | string, number>;
    },
  ) {
    const company = await this.companyService.findById(id)
    const settings = (company as any)?.settings || {}
    const next = { ...settings }
    if (!next.datev) next.datev = {}
    if (body.accounts) {
      // REPLACE behavior for the 13 account fields:
      // the PUT body's `accounts` is the new full
      // state of the override map. The user clears
      // an individual override by sending "" or
      // omitting the key. sanitizeDatevConfig drops
      // anything malformed (e.g. "AB-CD" or "99").
      // Pre-existing openingBalances + laufNr are
      // preserved unless they appear in the body
      // (handled below).
      const sanitized = sanitizeDatevConfig(body.accounts)
      // Drop the 13 account fields from next.datev
      // so a sanitized result of {} (when ALL inputs
      // are invalid) leaves the map empty rather
      // than stale.
      for (const k of Object.keys(SKR03_DEFAULTS)) {
        delete (next.datev as any)[k]
      }
      Object.assign(next.datev, sanitized)
      if (typeof body.beraterNr === 'string' && /^\d{1,5}$/.test(body.beraterNr)) {
        next.datev.beraterNr = body.beraterNr.padStart(5, '0')
      } else if (typeof body.beraterNr === 'string') {
        delete next.datev.beraterNr
      }
      if (typeof body.mandantenNr === 'string' && /^\d{1,5}$/.test(body.mandantenNr)) {
        next.datev.mandantenNr = body.mandantenNr.padStart(5, '0')
      } else if (typeof body.mandantenNr === 'string') {
        delete next.datev.mandantenNr
      }
    }
    // Opening balances — validate each entry's
    // shape, drop anything malformed. The Berater
    // gets a clean list even when the form sends
    // partially-filled rows.
    if (Array.isArray(body.openingBalances)) {
      const cleaned = body.openingBalances
        .filter((e) => e && typeof e.konto === 'string' && /^\d{3,5}$/.test(e.konto))
        .filter((e) => e && (e.shVz === 'S' || e.shVz === 'H'))
        .filter((e) => e && typeof e.betrag === 'number' && !isNaN(e.betrag) && e.betrag > 0)
        .map((e) => ({
          konto: e.konto.padEnd(4, '0').substring(0, 5),
          betrag: Number(e.betrag.toFixed(4)),
          shVz: e.shVz,
          buchungstext: typeof e.buchungstext === 'string' ? e.buchungstext.substring(0, 60) : '',
        }))
      next.datev.openingBalances = cleaned
    }
    // Buchungslauf counter — a year→number map. Validate
    // the keys are 4-digit years and the values are
    // positive integers. Anything else is dropped.
    if (body.laufNr && typeof body.laufNr === 'object') {
      const cleaned: Record<string, number> = {}
      for (const [year, n] of Object.entries(body.laufNr)) {
        if (/^\d{4}$/.test(year) && Number.isInteger(n) && (n as number) >= 1) {
          cleaned[year] = n as number
        }
      }
      next.datev.laufNr = cleaned
    }
    await this.companyService.update(id, { settings: next } as any)
    return {
      ok: true,
      config: resolveDatevAccounts(next.datev),
      overrides: next.datev,
      openingBalances: next.datev.openingBalances || [],
      laufNr: next.datev.laufNr || {},
    }
  }

  /**
   * Tier 94: Feature flags for the per-company
   * auto-posting + report opt-in toggles. Both
   * flags live on Company.settings (JSONB) and
   * default to OFF/ON respectively:
   *
   *   - autoBookAfa: default = true. The
   *     AfaAutoBookerScheduler (tier 91) reads
   *     this on every company to decide whether
   *     to book the previous month. Set to false
   *     to opt out (the user does the AfA booking
   *     manually).
   *
   *   - anlageV: default = false. The Berater
   *     packager (tier 85) reads this to decide
   *     whether to include 03_Anlage-V.pdf in
   *     the year-end ZIP. Set to true to force
   *     inclusion (for landlords without
   *     building assets in the Anlagenverzeichnis).
   *
   *   - anlageG (tier 100): default = false. The
   *     Berater packager (tier 85) reads this to
   *     decide whether to include the Anlage G
   *     PDF in the year-end ZIP. Set to true to
   *     force inclusion (for gewerbliche
   *     Mandanten that the heuristic would miss,
   *     e.g. early Gründerjahre with 0 invoices).
   *
   * The endpoint is exposed via PATCH (not PUT)
   * because the flags are independent — the
   * client can send either or all three.
   */
  @Auth()
  @Require('company.update')
  @Patch(':id/feature-flags')
  async updateFeatureFlags(
    @Param('id') id: string,
    @Body() body: { autoBookAfa?: boolean; anlageV?: boolean; anlageG?: boolean },
    @Req() req: any,
  ) {
    if (body.autoBookAfa !== undefined && typeof body.autoBookAfa !== 'boolean') {
      throw new BadRequestException('autoBookAfa muss ein Boolean sein')
    }
    if (body.anlageV !== undefined && typeof body.anlageV !== 'boolean') {
      throw new BadRequestException('anlageV muss ein Boolean sein')
    }
    if (body.anlageG !== undefined && typeof body.anlageG !== 'boolean') {
      throw new BadRequestException('anlageG muss ein Boolean sein')
    }
    const company = await this.companyService.findById(id)
    if (!company) {
      throw new BadRequestException('Firma nicht gefunden')
    }
    const settings = ((company as any)?.settings ?? {}) as Record<string, unknown>
    const prev = {
      autoBookAfa: settings.autoBookAfa !== false,
      anlageV: settings.anlageV === true,
      anlageG: settings.anlageG === true,
    }
    const next: Record<string, unknown> = { ...settings }
    if (body.autoBookAfa !== undefined) next.autoBookAfa = body.autoBookAfa
    if (body.anlageV !== undefined) next.anlageV = body.anlageV
    if (body.anlageG !== undefined) next.anlageG = body.anlageG

    await this.companyService.update(id, { settings: next } as any)

    // Audit log: who flipped the flag, when, and
    // what the previous value was. The Berater
    // can see "on 2026-07-24, Mavis turned off
    // autoBookAfa (was true)" in the audit
    // trail. The userId is in req.user via
    // HeaderAuthGuard.
    const userId = req?.user?.id || null
    try {
      await this.prisma.auditLog.create({
        data: {
          companyId: id,
          userId,
          action: 'company.feature_flags.updated',
          entityType: 'Company',
          entityId: id,
          oldData: prev as any,
          newData: {
            autoBookAfa: body.autoBookAfa,
            anlageV: body.anlageV,
            anlageG: body.anlageG,
          } as any,
          ipAddress: null,
          userAgent: 'de-invoice:CompanyController.updateFeatureFlags',
        },
      })
    } catch (err) {
      // Audit log failure should not block the
      // flag change — log + continue.
      console.warn(`feature-flags audit log write failed: ${(err as Error).message}`)
    }

    return {
      autoBookAfa: body.autoBookAfa !== undefined ? body.autoBookAfa : prev.autoBookAfa,
      anlageV: body.anlageV !== undefined ? body.anlageV : prev.anlageV,
      anlageG: body.anlageG !== undefined ? body.anlageG : prev.anlageG,
    }
  }

  /**
   * Tier 94: Read the current feature flags for
   * the company. Returns the effective value
   * (defaulting to true for autoBookAfa and
   * false for anlageV if the settings key is
   * missing) plus a "next auto-booker run" hint
   * for the UI. The hint is computed from the
   * same cron string (5 0 1 * *, Europe/Berlin)
   * the scheduler uses; the value is a future
   * ISO timestamp at the start of next month.
   */
  @Auth()
  @Get(':id/feature-flags')
  async getFeatureFlags(@Param('id') id: string) {
    const company = await this.companyService.findById(id)
    if (!company) {
      throw new BadRequestException('Firma nicht gefunden')
    }
    const settings = ((company as any)?.settings ?? {}) as Record<string, unknown>
    return {
      autoBookAfa: settings.autoBookAfa !== false,
      anlageV: settings.anlageV === true,
      anlageG: settings.anlageG === true,
      // The cron fires at 5 0 1 * * (00:05 on
      // the 1st of each month, Berlin time).
      // nextRunAt is the first-of-next-month
      // at 00:05 Berlin. v1 hint: the UI just
      // shows the month name. A precise ISO
      // timestamp would be a +5 LOC addition.
      nextAutoBookerRun: nextFirstOfMonthBerlin(),
    }
  }

  @Auth()
  @Post('upload-logo')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  }))
  async uploadLogo(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
    @Body('companyId') companyId: string,
  ) {
    if (!file) {
      throw new BadRequestException('Keine Datei hochgeladen');
    }
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich');
    }
    // Defence in depth: the upload must only update the
    // caller's own company. x-company-id is verified by
    // HeaderAuthGuard, so a token from company A can't
    // upload to company B. We re-check here so this single
    // endpoint can be read in isolation without the guard.
    const callerCompanyId = (req.headers['x-company-id'] as string) || '';
    if (callerCompanyId !== companyId) {
      throw new BadRequestException(
        'companyId stimmt nicht mit der aktiven Firma überein',
      );
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Ungültiger Dateityp. Erlaubt: JPG, PNG, GIF, WebP.',
      );
    }

    // Per-company filename. Previous version used a fixed
    // `logo${ext}` for every company — multi-tenant would
    // silently overwrite each other's logo (Company A's
    // PDF would render Company B's logo). The new naming
    // is `logo-<companyId8>-<timestamp>${ext}` — the
    // companyId prefix keeps the files self-documenting
    // on disk, and the timestamp lets us keep multiple
    // versions of the same company without conflict.
    const ext = path.extname(file.originalname) || '.png';
    const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
    const filename = `logo-${companyId.slice(0, 8)}-${Date.now()}${safeExt}`;
    // Anchor the upload dir to the source file location, not
    // process.cwd(). The backend is started with
    //   cd backend && npx ts-node src/main.ts
    // so CWD = de-invoice/backend/, and the previous
    //   path.join(process.cwd(), 'frontend', 'public', 'images')
    // landed at backend/frontend/public/images/ — a directory the
    // mkdirSync happily created in the wrong place. The frontend
    // then tried to serve from frontend/public/images/ (the real
    // public dir) and got 404, so the logo "saved" but never
    // rendered. Going up 4 levels from this file's directory
    // reaches the project root, regardless of where the node
    // process was launched.
    const uploadDir = path.resolve(
      __dirname,
      '..', '..', '..', '..',
      'frontend', 'public', 'images',
    );

    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Clean up the previous logo file (if any) for this
    // company. Otherwise a company that uploads logo.png,
    // then logo.jpg, ends up with both on disk forever
    // (and the public/ dir fills up over time).
    const company = await this.companyService.findById(companyId);
    if (company?.logoPath) {
      const oldPath = path.join(uploadDir, company.logoPath);
      // Only delete if it's inside uploadDir (defence
      // against a tampered logoPath like "../../etc/passwd").
      if (oldPath.startsWith(uploadDir) && fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // Best-effort. If the file is locked or already
          // deleted, we just leave the new one alongside
          // it — a stray file is better than failing the
          // upload.
        }
      }
    }

    // Save new file
    const filepath = path.join(uploadDir, filename);
    fs.writeFileSync(filepath, file.buffer);

    // Also persist the logoPath on the company record. Without
    // this, the user had to ALSO click the main "Speichern" button
    // on the company form to commit logoPath to the DB. The file
    // would land on disk, the preview would show, but on reload
    // the GET would return logoPath='' and the logo would vanish.
    // Doing the update here makes upload a one-step operation.
    await this.companyService.update(companyId, { logoPath: filename });

    return { filename, logoPath: filename };
  }

  /**
   * Remove the company's logo. Deletes the file on disk
   * (if it belongs to the per-company upload pattern) AND
   * sets logoPath=null in the DB. The frontend's removeLogo()
   * button now wires to this endpoint — previously the
   * button just cleared the local state and the logo
   * would reappear after the next GET.
   */
  @Auth()
  @Post('remove-logo')
  async removeLogo(@Req() req: Request) {
    const companyId = (req.headers['x-company-id'] as string) || '';
    if (!companyId) {
      throw new BadRequestException('x-company-id Header fehlt');
    }
    const company = await this.companyService.findById(companyId);
    if (!company) {
      throw new BadRequestException('Firma nicht gefunden');
    }
    if (company.logoPath) {
      const uploadDir = path.resolve(
        __dirname,
        '..', '..', '..', '..',
        'frontend', 'public', 'images',
      );
      const oldPath = path.join(uploadDir, company.logoPath);
      if (oldPath.startsWith(uploadDir) && fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // Same best-effort as in upload — don't fail the
          // remove just because we couldn't delete the file.
        }
      }
    }
    await this.companyService.update(companyId, { logoPath: null });
    return { ok: true, logoPath: null };
  }
}

/**
 * Tier 94: compute the next "1st of next month
 * at 00:05 Europe/Berlin" timestamp. v1 hint for
 * the UI to show "Nächster Auto-AfA-Lauf: 01.08.2026".
 *
 * v1 simplification: returns the 1st of NEXT
 * month in UTC. The actual cron runs at 5 0 1
 * * * in Berlin time, which is 23:05 UTC the
 * day before during CEST and 22:05 UTC the
 * day before during CET. The 1-day-early UTC
 * representation is close enough for the UI
 * display — the user just wants to know
 * "the auto-booker runs on the 1st of each
 * month".
 */
function nextFirstOfMonthBerlin(): string {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  // 1st of NEXT month. If we're in December,
  // next month = January of year+1.
  const nextYear = month === 11 ? year + 1 : year
  const nextMonth = (month + 1) % 12
  // 00:05 UTC on the 1st. (The actual cron
  // runs at 00:05 Berlin, which is 23:05 UTC
  // the prior day during CEST and 22:05 UTC
  // during CET. Returning 00:05 UTC on the
  // 1st is a 1-2 hour approximation — fine
  // for a UI hint.)
  const d = new Date(Date.UTC(nextYear, nextMonth, 1, 0, 5, 0, 0))
  return d.toISOString()
}
