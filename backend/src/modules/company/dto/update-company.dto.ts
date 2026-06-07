import {
  IsString,
  IsOptional,
  IsEmail,
  IsInt,
  Min,
  Max,
  ValidateNested,
  IsObject,
  ValidateIf,
  MaxLength,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CompanyAddressDto {
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

export class CompanyBankInfoDto {
  @IsString()
  @IsOptional()
  bankName?: string;

  @IsString()
  @IsOptional()
  iban?: string;

  @IsString()
  @IsOptional()
  bic?: string;
}

export class CompanyPreferencesDto {
  @IsString()
  @IsOptional()
  defaultCurrency?: string;

  @IsString()
  @IsOptional()
  defaultLanguage?: string;
}

export class UpdateCompanyDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  legalName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  taxId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  vatId?: string;

  // Company contact info shown on invoices/footer.
  // Email is optional; if provided, it must be a valid email.
  // Phone is optional free-text (German format: +49 30 12345678, etc.)
  @IsOptional()
  @ValidateIf((o) => o.email !== '' && o.email != null)
  @IsEmail({}, { message: 'Ungültige E-Mail-Adresse' })
  @MaxLength(200)
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  phone?: string;

  // Fax number (rarely used in modern invoices but required for
  // some B2B/government forms and for legal company records).
  // Free-text, German format expected: "+49 6181 12345-12".
  @IsString()
  @IsOptional()
  @MaxLength(50)
  fax?: string;

  // Company website URL. Free-text — we don't validate URL syntax
  // strictly because invoices often show bare domains
  // ("www.shleder.de") without the https:// scheme.
  @IsString()
  @IsOptional()
  @MaxLength(200)
  website?: string;

  // Handelsregister / company register entry, e.g.
  // "HRB 12345 Amtsgericht Offenbach am Main".
  // Required by §5 TMG (Telemediengesetz) for the Impressum on
  // most B2B invoices in Germany.
  @IsString()
  @IsOptional()
  @MaxLength(200)
  registerEntry?: string;

  // Geschäftsführer / managing director / sole proprietor.
  // Required by §5 TMG for the Impressum.
  @IsString()
  @IsOptional()
  @MaxLength(200)
  managingDirector?: string;

  @IsObject()
  @ValidateNested()
  @Type(() => CompanyAddressDto)
  @IsOptional()
  address?: CompanyAddressDto;

  @IsObject()
  @ValidateNested()
  @Type(() => CompanyBankInfoDto)
  @IsOptional()
  bankInfo?: CompanyBankInfoDto;

  @IsObject()
  @ValidateNested()
  @Type(() => CompanyPreferencesDto)
  @IsOptional()
  settings?: CompanyPreferencesDto;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  logoPath?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  invoicePrefix?: string;

  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  defaultPaymentDays?: number;
}
