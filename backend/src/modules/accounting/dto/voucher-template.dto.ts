/**
 * Tier 210 — request DTOs for VoucherTemplateController.
 *
 * Replaces `@Body() body: any` with class-validator decorated
 * DTOs so the global ValidationPipe (whitelist + transform +
 * forbidNonWhitelisted in main.ts) can reject unknown fields
 * and coerce types before the service layer runs. The service
 * still receives a typed shape, but keeps a manual
 * `if (!data.name)` fallback for the days the pipe is
 * bypassed (tests, internal calls, cron).
 */
import { IsString, IsOptional, MinLength, MaxLength, IsNumber, IsDateString, Max } from "class-validator"

/**
 * POST /voucher-templates
 * Create a new voucher template.
 */
export class CreateVoucherTemplateDto {
  @IsString()
  @MinLength(1, { message: "Name ist erforderlich" })
  @MaxLength(200)
  name!: string

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string

  /**
   * descriptionPattern — optional placeholder pattern
   * resolved at apply time. e.g. "Miete {month}/{year}".
   * Stored alongside description; the service prefers
   * the pattern when present.
   */
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  descriptionPattern?: string

  /**
   * JSON-encoded array of template lines. The service
   * parses + validates each line (accountNumber + side
   * are required, amount is optional at template time).
   * We accept it as a string here so the controller
   * can reject malformed JSON before the service runs.
   */
  @IsString()
  @MinLength(1, { message: "linesJson ist erforderlich" })
  linesJson!: string
}

/**
 * PUT /voucher-templates/:id
 * Update an existing voucher template. Same shape as
 * create; the service treats undefined fields as
 * "leave unchanged" (so we use @IsOptional on all
 * fields except the title).
 */
export class UpdateVoucherTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  name?: string

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  descriptionPattern?: string

  @IsString()
  @IsOptional()
  linesJson?: string
}

/**
 * Tier 377 — POST /voucher-templates/:id/apply. The body was an inline type.
 * Measured before: amount "zehn", date "abc" and amount 1e12 all answered 201
 * with lines built from them (a null debit, a 1e12 debit that the voucher
 * create would later refuse). Callers: accounting page, e2e 14/77, Playwright
 * voucher-template-autopersist. amount <= 0 stays in the service
 * ("Betrag muss > 0 sein").
 */
export class ApplyVoucherTemplateDto {
  @IsNumber({}, { message: "Betrag muss eine Zahl sein" })
  @Max(99999999.9999, { message: "Betrag darf höchstens 99999999.9999 sein" })
  amount!: number

  @IsDateString({}, { message: "date muss ein gültiges Datum sein" })
  date!: string

  @IsString() @IsOptional() @MaxLength(200)
  counterparty?: string

  @IsString() @IsOptional() @MaxLength(500)
  description?: string
}
