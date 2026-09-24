import { RECHTSFORMEN } from '../rechtsform';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsInt,
  IsIn,
  Min,
  Max,
  ValidateNested,
  IsObject,
  ValidateIf,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

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

  // Free-text name of the default printer the user wants to
  // use for invoice printing. The browser JS sandbox can't
  // actually force the OS print dialog to pre-select this
  // printer (window.print() doesn't accept a printer arg,
  // and chrome.printing requires enterprise kiosk mode), so
  // this field is INFORMATIONAL — the user's OS print
  // dialog still shows the system default printer. The
  // value is displayed in the settings page so the user
  // can confirm what they typed, and shown as a hint
  // in the toast that fires after window.print() returns.
  // Free-text (max 200 chars) so it accepts both macOS
  // printer names ("Brother HL-L2350DW series") and
  // Windows share names ("\\\\PRINTSERVER\\Rechnungsdrucker").
  @IsString()
  @IsOptional()
  @MaxLength(200)
  defaultPrinter?: string;
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

  // Misc. Impressum / footer info — anything that doesn't fit a
  // dedicated field. Typical uses:
  //   - WEEE/LUCID registration number (mandatory for e-commerce)
  //   - Kleinunternehmer §19 UStG disclaimer
  //   - Verpackungsregister / dual-system registration
  //   - Industry-specific chamber memberships (IHK, Handwerkskammer)
  // Free-text, multi-line, displayed verbatim in the PDF footer.
  @IsString()
  @IsOptional()
  @MaxLength(500)
  otherInfo?: string;

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

  // Tier 176: default VAT treatment. Used to pre-fill the
  // invoice create form's USt-Behandlung radio. NULL = "ask
  // every time" (the conservative default — never silently
  // mis-classify an invoice as §12 standard when the
  // Mandant issues only §13b reverse-charge). See
  // migration 20260812230000_company_default_vat_mode for
  // the allowed values and the rationale for nullable.
  @IsString()
  @IsIn(['standard', 'reverseCharge', 'igL', 'kleinunternehmer'])
  @IsOptional()
  defaultVatMode?: string;

  // Tier 441: the legal form (company/rechtsform.ts); null clears it.
  @IsString()
  @IsIn(RECHTSFORMEN as unknown as string[], { message: `rechtsform muss eine von ${RECHTSFORMEN.join(', ')} sein` })
  @IsOptional()
  rechtsform?: string | null;
}
