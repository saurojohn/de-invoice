/**
 * Tier 210 — request DTOs for SupplierController.
 *
 * Replaces `@Body() data: any` with class-validator
 * decorated DTOs so the global ValidationPipe can
 * reject unknown fields and coerce types before the
 * service layer runs. The service still does a
 * `if (!data.name)` fallback for the case when the
 * pipe is bypassed (tests, internal calls, cron).
 */
import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsObject,
  MinLength,
  MaxLength,
  ValidateNested,
} from "class-validator"
import { Type } from "class-transformer"

/**
 * Address block. Most fields are optional because
 * suppliers are sometimes added from a one-line
 * purchase order with only a name + IBAN.
 */
export class AddressDto {
  @IsString() @IsOptional() @MaxLength(200)
  street?: string

  @IsString() @IsOptional() @MaxLength(20)
  postalCode?: string

  @IsString() @IsOptional() @MaxLength(100)
  city?: string

  @IsString() @IsOptional() @MaxLength(2)
  country?: string
}

/**
 * Contact block. Optional — sometimes the supplier
 * only has a generic mailbox.
 */
export class ContactDto {
  @IsString() @IsOptional() @MaxLength(100)
  contactName?: string

  @IsString() @IsOptional() @MaxLength(200)
  email?: string

  @IsString() @IsOptional() @MaxLength(50)
  phone?: string
}

/**
 * Bank info block. Optional — used for SEPA
 * Lastschrift / Überweisung. IBAN format is loosely
 * checked (length 15-32) to catch typos; the
 * formal check happens at payment time.
 */
export class BankInfoDto {
  @IsString() @IsOptional() @MaxLength(34) @MinLength(15)
  iban?: string

  @IsString() @IsOptional() @MaxLength(11)
  bic?: string

  @IsString() @IsOptional() @MaxLength(200)
  accountHolder?: string
}

/**
 * POST /suppliers
 * Create a new supplier.
 */
export class CreateSupplierDto {
  @IsString()
  @MinLength(1, { message: "Name ist erforderlich" })
  @MaxLength(200)
  name!: string

  @IsString() @IsOptional() @MaxLength(20)
  vatId?: string

  @IsObject() @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto

  @IsObject() @IsOptional()
  @ValidateNested()
  @Type(() => ContactDto)
  contact?: ContactDto

  @IsObject() @IsOptional()
  @ValidateNested()
  @Type(() => BankInfoDto)
  bankInfo?: BankInfoDto

  @IsInt() @IsOptional() @Min(0) @Max(365)
  paymentTerms?: number

  @IsObject() @IsOptional()
  metadata?: Record<string, unknown>
}

/**
 * PUT /suppliers/:id
 * Update an existing supplier. Every field is
 * optional — the service treats undefined as
 * "leave unchanged" for the PATCH-style update.
 */
export class UpdateSupplierDto {
  @IsString() @IsOptional() @MinLength(1) @MaxLength(200)
  name?: string

  @IsString() @IsOptional() @MaxLength(20)
  vatId?: string

  @IsObject() @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto

  @IsObject() @IsOptional()
  @ValidateNested()
  @Type(() => ContactDto)
  contact?: ContactDto

  @IsObject() @IsOptional()
  @ValidateNested()
  @Type(() => BankInfoDto)
  bankInfo?: BankInfoDto

  @IsInt() @IsOptional() @Min(0) @Max(365)
  paymentTerms?: number

  @IsObject() @IsOptional()
  metadata?: Record<string, unknown>
}
