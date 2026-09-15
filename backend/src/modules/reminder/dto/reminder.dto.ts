/**
 * Request bodies for the reminder / Mahnung routes.
 *
 * Tier 388: the handlers took inline types. Measured before:
 *   POST /reminders/send       level "bogus" → 201, Mahnung stored with level "bogus";
 *                              missing invoiceId → 500
 *   PUT  fees-config           null / "abc" / -5 → stored 0; 5000 → 1000; 99 % → 50 %;
 *                              "mahngebuehr":"x" → 200
 *   PUT  templates/:level      5000-char subject and a 200 000-char body stored;
 *                              subject 123 → 500
 *   POST mahnungen/:id/cancel  20 000-char reason stored
 *   POST /mahnungspausen       pausedUntil "abc" → 500, "2026-02-30" → stored,
 *                              20 000-char reason, customerId 123 → 500;
 *                              PATCH pausedUntil "abc" → 500
 * Callers: invoice detail page (send, pause), invoices list (bulk), mahnungen
 * pages (fees, templates, cancel), customer detail (pause), e2e 22/65/68/91/97/179,
 * Playwright bulk-mahnung, manual-mahnung-send, mahnung-templates,
 * mahnung-fees-preview, mahnungspause.
 */
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator'

export const REMINDER_LEVELS = ['first', 'second', 'final'] as const
const LEVEL_MESSAGE = 'level muss first, second oder final sein'

export class SendReminderDto {
  @IsString() @IsNotEmpty({ message: 'invoiceId ist erforderlich' }) @MaxLength(64)
  invoiceId!: string

  @IsString() @IsNotEmpty({ message: 'companyId ist erforderlich' })
  companyId!: string

  @IsIn(REMINDER_LEVELS, { message: LEVEL_MESSAGE })
  level!: 'first' | 'second' | 'final'

  // The modal sends its preview along; the letter itself is rendered from the
  // company's template and goes to the customer's stored address, exactly as
  // the bulk send and the cron do.
  @IsOptional() @IsEmail({}, { message: 'recipientEmail ist keine E-Mail-Adresse' }) @MaxLength(320)
  recipientEmail?: string

  @IsOptional() @IsString() @MaxLength(300)
  recipientName?: string

  @IsOptional() @IsString() @MaxLength(500)
  subject?: string

  @IsOptional() @IsString() @MaxLength(20000)
  body?: string

  @IsOptional() @IsString()
  createdById?: string
}

export class BulkSendReminderDto {
  @IsString() @IsNotEmpty({ message: 'companyId is required' })
  companyId!: string

  @IsArray({ message: 'invoiceIds must be a non-empty array' })
  @ArrayMinSize(1, { message: 'invoiceIds must be a non-empty array' })
  // The service sends at most 100 (Tier 32 SMTP cap); more is refused, not cut.
  @ArrayMaxSize(100, { message: 'höchstens 100 Rechnungen pro Mahnlauf' })
  @IsString({ each: true }) @MaxLength(64, { each: true })
  invoiceIds!: string[]

  @IsIn(REMINDER_LEVELS, { message: 'level must be first, second, or final' })
  level!: 'first' | 'second' | 'final'

  @IsOptional() @IsString()
  createdById?: string
}

// @IsOptional would also skip null, and the service turns null into 0 — only
// an absent field keeps the stored value.
const unlessAbsent = () => ValidateIf((_, v) => v !== undefined)

export class ReminderFeesDto {
  @unlessAbsent() @IsNumber({}, { message: 'Mahngebühr muss eine Zahl sein' }) @Min(0) @Max(1000)
  first?: number

  @unlessAbsent() @IsNumber({}, { message: 'Mahngebühr muss eine Zahl sein' }) @Min(0) @Max(1000)
  second?: number

  @unlessAbsent() @IsNumber({}, { message: 'Mahngebühr muss eine Zahl sein' }) @Min(0) @Max(1000)
  final?: number
}

export class FeeConfigDto {
  // § 288 BGB: 5 or 9 points over the base rate; 50 is the handler's own ceiling.
  @unlessAbsent() @IsNumber({}, { message: 'verzugszinsPct muss eine Zahl sein' })
  @Min(0, { message: 'verzugszinsPct darf nicht negativ sein' })
  @Max(50, { message: 'verzugszinsPct darf höchstens 50 sein' })
  verzugszinsPct?: number

  @unlessAbsent() @ValidateNested() @Type(() => ReminderFeesDto)
  mahngebuehr?: ReminderFeesDto
}

export class ReminderTemplateDto {
  @IsString() @MaxLength(300, { message: 'Betreff darf höchstens 300 Zeichen lang sein' })
  subject!: string

  @IsString() @MaxLength(20000, { message: 'Text darf höchstens 20000 Zeichen lang sein' })
  body!: string
}

export class CancelMahnungDto {
  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string
}

// The pages send `new Date(input).toISOString()`; e2e 91 sends plain dates.
const strictDate = { strict: true } as const

export class CreateMahnungspauseDto {
  @IsOptional() @IsString()
  createdById?: string

  @IsOptional() @IsString() @MaxLength(64)
  customerId?: string | null

  @IsOptional() @IsString() @MaxLength(64)
  invoiceId?: string | null

  @IsString() @MaxLength(1000)
  reason!: string

  @IsOptional() @IsDateString(strictDate, { message: 'pausedFrom ist kein gültiges Datum' })
  pausedFrom?: string

  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsDateString(strictDate, { message: 'pausedUntil ist kein gültiges Datum' })
  pausedUntil?: string | null
}

export class UpdateMahnungspauseDto {
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsDateString(strictDate, { message: 'pausedUntil ist kein gültiges Datum' })
  pausedUntil?: string | null

  @IsOptional() @IsString() @MaxLength(1000)
  reason?: string
}

export class GetReminderEmailDto {
  @IsString()
  invoiceId!: string

  @IsString()
  companyId!: string

  @IsIn(REMINDER_LEVELS)
  level!: 'first' | 'second' | 'final'
}
