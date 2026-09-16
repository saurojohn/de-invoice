import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

/**
 * Tier 394 — bodies for POST /invoices/:id/send-email and
 * /invoices/bulk-send-email. They were inline types.
 *
 * `overrideTo` was already checked (InvoiceEmailService throws "Ungültige
 * Empfänger-E-Mail"), but the CC fields were only trimmed. Measured:
 *   - `extraCc` with 200 addresses → 201, and all 200 reached the mailer —
 *     every one of them receives the customer's invoice PDF, sent through the
 *     company's own SMTP account;
 *   - `ccEmail: "total-garbage-not-email"` → 201;
 *   - `ccEmail: "a@b.test\r\nBcc: victim@evil.test"` (raw CRLF) → 201;
 *   - `overrideSubject` with 20 000 characters → 201.
 *
 * The UI's CC box is a comma-separated field a person types, so ten extra
 * addresses is already generous.
 */
export const EXTRA_CC_MAX = 10

/** The recipient / content fields, shared by the single and the bulk send. */
export class InvoiceEmailFieldsDto {
  @IsOptional() @IsEmail({}, { message: 'overrideTo ist keine gültige E-Mail-Adresse' })
  overrideTo?: string

  @IsOptional() @IsEmail({}, { message: 'ccEmail ist keine gültige E-Mail-Adresse' })
  ccEmail?: string

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXTRA_CC_MAX, { message: `höchstens ${EXTRA_CC_MAX} CC-Adressen` })
  @IsEmail({}, { each: true, message: 'extraCc enthält eine ungültige E-Mail-Adresse' })
  extraCc?: string[]

  @IsOptional() @IsString() @MaxLength(300)
  overrideSubject?: string

  @IsOptional() @IsString() @MaxLength(20000)
  overrideBody?: string

  @IsOptional() @IsIn(['de', 'en', 'zh'], { message: 'language muss de, en oder zh sein' })
  language?: 'de' | 'en' | 'zh'

  @IsOptional() @IsString() @MaxLength(200)
  salutation?: string

  // HeaderAuthGuard (Tier 383) already requires this to be the caller.
  @IsOptional() @IsString() @MaxLength(64)
  createdById?: string
}

export class SendInvoiceEmailDto extends InvoiceEmailFieldsDto {}

export class BulkSendInvoiceEmailDto extends InvoiceEmailFieldsDto {
  // The count is checked in the handler so its German message
  // ("Maximal 100 Rechnungen pro Anfrage") stays the one the caller sees.
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(64, { each: true })
  invoiceIds?: string[]

  @IsOptional() @IsBoolean()
  dryRun?: boolean

  // Clamped to 1…10 in the handler; rejected here rather than silently clamped.
  @IsOptional() @IsInt() @Min(1) @Max(10, { message: 'concurrency muss zwischen 1 und 10 liegen' })
  concurrency?: number
}
