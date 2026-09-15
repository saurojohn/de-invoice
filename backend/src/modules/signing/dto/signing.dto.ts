/**
 * Tier 386 — request bodies for POST /signing/{sign,verify,user-sign}.
 * They were inline types. The PDF is base64 in JSON; the global JSON limit is
 * 10 MB, so the string is capped just under it.
 */
import { IsBase64, IsNotEmpty, IsString, MaxLength } from 'class-validator'

const PDF_MAX = 10 * 1024 * 1024

export class SignPdfDto {
  @IsString() @IsNotEmpty({ message: 'companyId ist erforderlich' })
  companyId!: string

  @IsString() @IsNotEmpty({ message: 'pdf (base64) ist erforderlich' })
  @MaxLength(PDF_MAX) @IsBase64(undefined, { message: 'pdf muss Base64 sein' })
  pdf!: string
}

export class VerifyPdfDto {
  @IsString() @IsNotEmpty({ message: 'pdf (base64) ist erforderlich' })
  @MaxLength(PDF_MAX) @IsBase64(undefined, { message: 'pdf muss Base64 sein' })
  pdf!: string
}

export class UserSignPdfDto {
  // Must be the caller (403 otherwise); still required, as before (e2e 168).
  @IsString() @IsNotEmpty({ message: 'userId ist erforderlich' })
  userId!: string

  @IsString() @IsNotEmpty({ message: 'pdf (base64) ist erforderlich' })
  @MaxLength(PDF_MAX) @IsBase64(undefined, { message: 'pdf muss Base64 sein' })
  pdf!: string
}
