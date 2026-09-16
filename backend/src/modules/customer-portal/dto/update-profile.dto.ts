import { Type } from 'class-transformer'
import { IsEmail, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator'
import { CUSTOMER_NAME_MAX, CUSTOMER_VAT_ID_MAX } from '../../customer/customer.service'

/**
 * Tier 398 — body of PATCH /customer-portal/profile.
 *
 * The actor here is the customer, over a portal token — the only externally
 * driven write in the app. The service checked that `name` is non-empty and
 * that the e-mail parses, but nothing was bounded. Measured with a real portal
 * token: name 100 000 chars, vatId 5 000, address.street 50 000 — all stored.
 * That name is printed on the customer's invoices and travels into the DATEV /
 * GoBD exports.
 *
 * The limits are the ones the internal routes use (Tier 397).
 */
const FIELD_MAX = 200

export class PortalContactDto {
  // null clears the field — @IsOptional() skips null, which the merge handles.
  @IsOptional() @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' }) @MaxLength(320)
  email?: string | null

  @IsOptional() @IsString() @MaxLength(60)
  phone?: string | null

  @IsOptional() @IsString() @MaxLength(FIELD_MAX)
  name?: string | null
}

export class PortalAddressDto {
  @IsOptional() @IsString() @MaxLength(FIELD_MAX)
  street?: string | null

  @IsOptional() @IsString() @MaxLength(20)
  postalCode?: string | null

  @IsOptional() @IsString() @MaxLength(FIELD_MAX)
  city?: string | null

  // ISO-ish country code or short name, as the portal form sends it.
  @IsOptional() @IsString() @MaxLength(60)
  country?: string | null
}

export class UpdatePortalProfileDto {
  @IsOptional() @IsString()
  @MaxLength(CUSTOMER_NAME_MAX, {
    message: `Name darf höchstens ${CUSTOMER_NAME_MAX} Zeichen lang sein`,
  })
  name?: string

  @IsOptional() @IsString() @MaxLength(CUSTOMER_VAT_ID_MAX)
  vatId?: string | null

  @IsOptional() @IsObject() @ValidateNested() @Type(() => PortalContactDto)
  contact?: PortalContactDto

  @IsOptional() @IsObject() @ValidateNested() @Type(() => PortalAddressDto)
  address?: PortalAddressDto
}
