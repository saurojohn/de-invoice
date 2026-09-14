import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'

/**
 * Tier 373: request DTOs for the recurring-invoice routes.
 *
 * Before this, recurring.controller.ts typed its bodies as TypeScript
 * intersections (`{ createdById?: string } & RecurringInput`). Nest's
 * ValidationPipe can only validate classes, so those bodies were not checked at
 * all — `vatRate: 19` reached a Decimal(5,4) column and failed with a numeric
 * overflow (HTTP 500), exactly like the invoice DTO before Tier 372.
 *
 * The global pipe runs with `whitelist + forbidNonWhitelisted`, so a field any
 * caller sends that is NOT declared here would start failing with 400. Every
 * field below was taken from the callers, not invented:
 *   - frontend/src/app/dashboard/recurring-invoices/page.tsx (create, update,
 *     pause, un-pause, clone; items come from openEdit or the from-invoice
 *     prefill, both already normalised to the item shape below)
 *   - backend/e2e 35, 90, 153 and Playwright recurring-stats, -pause, -clone
 * Bounds only guard the database (Decimal / Int columns) or restate a rule the
 * code already has; they do not introduce new business rules.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
// normalizeDates() appends 'T00:00:00.000Z' to startDate / endDate, so a full
// ISO timestamp here would become an Invalid Date (→ 500). Every caller sends
// YYYY-MM-DD; require it.
const DATE_ONLY_MSG = 'Datum im Format YYYY-MM-DD erwartet'
// RecurringInvoiceItem.quantity / unitPrice are Decimal(12,4). Symmetric on
// purpose — this only prevents the overflow, it does not rule on negatives.
const DEC_12_4 = 99999999.9999
const INTERVALS = ['monthly', 'quarterly', 'yearly', 'weekly'] // = VALID_INTERVALS

export class RecurringItemDto {
  @IsString()
  description!: string

  @IsOptional()
  @IsString()
  productNumber?: string | null

  @IsNumber()
  @Min(-DEC_12_4)
  @Max(DEC_12_4)
  quantity!: number

  @IsOptional()
  @IsString()
  unit?: string | null

  @IsNumber()
  @Min(-DEC_12_4)
  @Max(DEC_12_4)
  unitPrice!: number

  // A fraction, like the invoice / expense / cashbook / product DTOs (0.19).
  @IsNumber()
  @Min(0, { message: 'MwSt-Satz darf nicht negativ sein' })
  @Max(1, { message: 'MwSt-Satz ist ein Anteil (z. B. 0.19), höchstens 1' })
  vatRate!: number
}

export class CreateRecurringInvoiceDto {
  // Accepted and ignored: the company comes from ?companyId=. Two existing e2e
  // specs (35, 90) send it in the body, and rejecting a redundant field would
  // be a breaking change for no benefit.
  @IsOptional()
  @IsString()
  companyId?: string

  @IsOptional()
  @IsString()
  createdById?: string

  @IsString()
  name!: string

  @IsString()
  customerId!: string

  @IsIn(INTERVALS)
  interval!: 'monthly' | 'quarterly' | 'yearly' | 'weekly'

  // Min 1: an interval count of 0 would never advance nextRunAt.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  intervalCount?: number

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth?: number

  @Matches(DATE_ONLY, { message: DATE_ONLY_MSG })
  startDate!: string

  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_ONLY_MSG })
  endDate?: string | null

  // Not date-normalised: the pause modal sends a full ISO timestamp, or null.
  @IsOptional()
  @IsDateString()
  pausedUntil?: string | null

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string

  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string

  @IsOptional()
  @IsString()
  notes?: string | null

  @IsOptional()
  @IsIn(['draft', 'sent'])
  invoiceStatus?: 'draft' | 'sent'

  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecurringItemDto)
  items!: RecurringItemDto[]
}

/** PUT /recurring-invoices/:id — every field optional, plus isActive. */
export class UpdateRecurringInvoiceDto {
  @IsOptional() @IsString() companyId?: string
  // The edit form sends createdById on update too; the service ignores it.
  @IsOptional() @IsString() createdById?: string
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() customerId?: string
  @IsOptional() @IsIn(INTERVALS) interval?: 'monthly' | 'quarterly' | 'yearly' | 'weekly'
  @IsOptional() @IsInt() @Min(1) @Max(2147483647) intervalCount?: number
  @IsOptional() @IsInt() @Min(1) @Max(31) dayOfMonth?: number
  @IsOptional() @Matches(DATE_ONLY, { message: DATE_ONLY_MSG }) startDate?: string
  @IsOptional() @Matches(DATE_ONLY, { message: DATE_ONLY_MSG }) endDate?: string | null
  @IsOptional() @IsDateString() pausedUntil?: string | null
  @IsOptional() @IsString() @Length(3, 3) currency?: string
  @IsOptional() @IsString() @MaxLength(10) language?: string
  @IsOptional() @IsString() notes?: string | null
  @IsOptional() @IsIn(['draft', 'sent']) invoiceStatus?: 'draft' | 'sent'
  @IsOptional() @IsBoolean() sendEmail?: boolean
  @IsOptional() @IsBoolean() isActive?: boolean

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecurringItemDto)
  items?: RecurringItemDto[]
}

/** POST /recurring-invoices/:id/clone */
export class CloneRecurringInvoiceDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() customerId?: string
  // The controller appends 'T00:00:00.000Z', so this must be date-only too.
  @IsOptional() @Matches(DATE_ONLY, { message: DATE_ONLY_MSG }) startDate?: string
  @IsOptional() @IsString() createdById?: string
}
