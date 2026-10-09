import { StrictNumber } from '../../../common/strict-number'
import {
  IsString,
  IsOptional,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  IsObject,
  ValidateIf,
  MinLength,
  MaxLength,
  IsNotEmpty,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { IsLeitwegId } from '../../../common/leitweg-id';
import { CUSTOMER_NAME_MAX, CUSTOMER_VAT_ID_MAX } from '../customer.service';

import { StrictBoolean } from '../../../common/strict-boolean'
export class CustomerAddressDto {
  @IsString()
  @IsOptional()
  street?: string;

  @IsString()
  @IsOptional()
  postalCode?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  country?: string;

  /**
   * Tier 599: the Leitweg-ID of a public-sector customer — XRechnung's
   * BuyerReference (BT-10). The generator has read `address.leitwegId` since
   * Tier 115; this DTO refused the property, so it could only get there by
   * SQL. Grobadresse (2–12 digits), optional Feinadresse, two check digits.
   */
  @ValidateIf((o) => o.leitwegId !== undefined && o.leitwegId !== null && o.leitwegId !== '')
  @IsString()
  // Tier 634: the shape and the check digits (common/leitweg-id.ts)
  @IsLeitwegId()
  leitwegId?: string;
}

export class CustomerContactDto {
  // Email is optional. If the user enters a value, it must be a valid email.
  // An empty string is treated as "not provided" so users can create
  // customers without contact info.
  @IsOptional()
  @ValidateIf((o) => o.email !== '' && o.email != null)
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  email?: string;

  @IsString()
  @IsOptional()
  phone?: string;
}

export class CreateCustomerDto {
  // Trim whitespace before validation so a name like "   " is rejected.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Name ist erforderlich' })
  @MinLength(1, { message: 'Name ist erforderlich' })
  // Tier 397: was unbounded — a 100 000-character name was stored (measured).
  @MaxLength(CUSTOMER_NAME_MAX, {
    message: `Name darf höchstens ${CUSTOMER_NAME_MAX} Zeichen lang sein`,
  })
  name!: string;

  // Customer number (K-0001...). If omitted, the service auto-assigns
  // the next sequential number for this company. Importer-supplied
  // numbers are accepted and validated for per-company uniqueness.
  @IsString()
  @IsOptional()
  @MaxLength(20)
  customerNumber?: string;

  @IsString()
  @IsIn(['business', 'individual'])
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  @MaxLength(CUSTOMER_VAT_ID_MAX)
  vatId?: string;

  @StrictBoolean()

  @IsBoolean()
  @IsOptional()
  taxExempt?: boolean;

  @IsObject()
  @ValidateNested()
  @Type(() => CustomerAddressDto)
  @IsOptional()
  address?: CustomerAddressDto;

  @IsObject()
  @ValidateNested()
  @Type(() => CustomerContactDto)
  @IsOptional()
  contact?: CustomerContactDto;

  @StrictNumber() @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  paymentTerms?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  // Tier 426: the Kreditlimit (Tier 159) could be read and was used by the
  // credit-utilisation report, but no endpoint accepted it — the whitelist
  // rejected it with 400 and the form had no field, so no customer could
  // ever have one.
  @StrictNumber() @IsNumber() @Min(0) @IsOptional()
  creditLimit?: number

  // Tier 616: the hourly rate (net) a new time entry for this customer
  // starts with; null takes it away again
  @ValidateIf((_, v) => v !== null)
  @StrictNumber() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) @IsOptional()
  defaultHourlyRate?: number | null

  // Tier 626: this customer's own rounding of logged time — null: as the
  // company; 0: do not round
  @ValidateIf((_, v) => v !== null)
  @IsIn([0, 5, 6, 10, 15, 30, 60], { message: 'timeRoundingMinutes muss 0, 5, 6, 10, 15, 30 oder 60 sein — oder null' }) @IsOptional()
  timeRoundingMinutes?: number | null

  @ValidateIf((_, v) => v !== null)
  @IsIn(['up', 'nearest'], { message: 'timeRoundingMode muss up oder nearest sein — oder null' }) @IsOptional()
  timeRoundingMode?: string | null
}

/**
 * PUT /customers/:id
 * Update an existing customer. Same fields as
 * CreateCustomerDto but every one is optional —
 * the service treats undefined as "leave unchanged"
 * for the PATCH-style update.
 */
export class UpdateCustomerDto {
  @IsString() @IsOptional() @MinLength(1) @MaxLength(200)
  name?: string

  @IsString() @IsOptional() @MaxLength(20)
  customerNumber?: string

  @IsString() @IsIn(['business', 'individual']) @IsOptional()
  type?: string

  @IsString() @IsOptional() @MaxLength(20)
  vatId?: string

  @StrictBoolean() @IsBoolean() @IsOptional()
  taxExempt?: boolean

  @IsObject()
  @ValidateNested()
  @Type(() => CustomerAddressDto)
  @IsOptional()
  address?: CustomerAddressDto

  @IsObject()
  @ValidateNested()
  @Type(() => CustomerContactDto)
  @IsOptional()
  contact?: CustomerContactDto

  @StrictNumber() @IsInt() @Min(0) @Max(365) @IsOptional()
  paymentTerms?: number

  @IsArray() @IsString({ each: true }) @IsOptional()
  tags?: string[]

  @IsObject() @IsOptional()
  metadata?: Record<string, unknown>

  // Tier 426: the Kreditlimit (Tier 159) could be read and was used by the
  // credit-utilisation report, but no endpoint accepted it — the whitelist
  // rejected it with 400 and the form had no field, so no customer could
  // ever have one.
  @StrictNumber() @IsNumber() @Min(0) @IsOptional()
  creditLimit?: number

  // Tier 616: the hourly rate (net) a new time entry for this customer
  // starts with; null takes it away again
  @ValidateIf((_, v) => v !== null)
  @StrictNumber() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100000) @IsOptional()
  defaultHourlyRate?: number | null

  // Tier 626: this customer's own rounding of logged time — null: as the
  // company; 0: do not round
  @ValidateIf((_, v) => v !== null)
  @IsIn([0, 5, 6, 10, 15, 30, 60], { message: 'timeRoundingMinutes muss 0, 5, 6, 10, 15, 30 oder 60 sein — oder null' }) @IsOptional()
  timeRoundingMinutes?: number | null

  @ValidateIf((_, v) => v !== null)
  @IsIn(['up', 'nearest'], { message: 'timeRoundingMode muss up oder nearest sein — oder null' }) @IsOptional()
  timeRoundingMode?: string | null
}
