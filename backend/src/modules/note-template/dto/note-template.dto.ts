import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

/**
 * Tier 398 — bodies for the note-template routes. They were inline types.
 * Measured: label 50 000 chars, text 500 000 chars and sortOrder -5 were all
 * stored. A note template is a short block of text pasted onto an invoice.
 */
export const NOTE_LABEL_MAX = 200
export const NOTE_TEXT_MAX = 5000

export class CreateNoteTemplateDto {
  @IsString() @IsNotEmpty({ message: 'label is required' }) @MaxLength(NOTE_LABEL_MAX)
  label!: string

  @IsString() @IsNotEmpty({ message: 'text is required' }) @MaxLength(NOTE_TEXT_MAX)
  text!: string

  @IsOptional() @IsInt() @Min(0) @Max(9999)
  sortOrder?: number
}

export class UpdateNoteTemplateDto {
  @IsOptional() @IsString() @MaxLength(NOTE_LABEL_MAX)
  label?: string

  @IsOptional() @IsString() @MaxLength(NOTE_TEXT_MAX)
  text?: string

  @IsOptional() @IsInt() @Min(0) @Max(9999)
  sortOrder?: number
}

/** The preview substitutes these into the template — display values only. */
export class PreviewNoteTemplateDto {
  @IsOptional() @IsString() @MaxLength(200)
  customerName?: string

  @IsOptional() @IsString() @MaxLength(60)
  invoiceNumber?: string

  @IsOptional() @IsString() @MaxLength(40)
  dueDate?: string

  @IsOptional() @IsString() @MaxLength(40)
  total?: string

  @IsOptional() @IsString() @MaxLength(200)
  companyName?: string
}
