import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator'

/**
 * Tier 398 — bodies for the invoice-template routes (were local interfaces, so
 * the ValidationPipe could not see them). Measured: name 50 000 chars, an
 * arbitrary templateType ("bogus-type") and a 500 KB configJson were stored.
 *
 * configJson is a free-form render config (colours, fonts, footer text). Rather
 * than pin its schema here, the service bounds its serialised size — the same
 * approach as the error-capture context in Tier 392.
 */
export const TEMPLATE_TYPES = ['standard', 'simplified', 'compact', 'custom'] as const
export const TEMPLATE_NAME_MAX = 200

export class CreateInvoiceTemplateDto {
  @IsString() @IsNotEmpty({ message: 'companyId is required' })
  companyId!: string

  @IsString() @IsNotEmpty({ message: 'name ist erforderlich' }) @MaxLength(TEMPLATE_NAME_MAX)
  name!: string

  @IsOptional() @IsIn(TEMPLATE_TYPES, {
    message: `templateType muss einer von ${TEMPLATE_TYPES.join(', ')} sein`,
  })
  templateType?: string

  @IsObject({ message: 'configJson muss ein Objekt sein' })
  configJson!: Record<string, unknown>

  @IsOptional() @IsBoolean()
  isDefault?: boolean
}

export class UpdateInvoiceTemplateDto {
  @IsOptional() @IsString() @MaxLength(TEMPLATE_NAME_MAX)
  name?: string

  @IsOptional() @IsObject({ message: 'configJson muss ein Objekt sein' })
  configJson?: Record<string, unknown>

  @IsOptional() @IsBoolean()
  isDefault?: boolean
}
