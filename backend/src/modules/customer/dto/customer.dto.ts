import {
  IsString,
  IsOptional,
  IsEmail,
  IsIn,
  IsInt,
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
  vatId?: string;

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

  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  paymentTerms?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
