/**
 * Tier 382 — request DTOs for the tax-form settings PUTs in
 * AccountingController (Anlage N, R, Kind, SO, AUS, GewSt).
 *
 * The bodies were inline types and the handlers "sanitised" by coercion.
 * Measured before this change — every one answered 200:
 *   N    lohnsteuer "zehn" → stored 0; lohnsteuer -500 → stored -500;
 *        werbungskosten {"130":"abc","x":{"nested":[1,2,3]},"<script>":"<b>"}
 *        stored verbatim; 20000 keys → Company.settings grew to 298 KB
 *   R    drv "zehn" and bav -5 → stored 0
 *   Kind name of 5000 chars and birthDate "2026-02-30" stored
 *   SO   acquisitionCost "zehn" → 0; salePrice -100 and saleDate "2031-13-01" stored
 *   AUS  country "XXXX" → silently "XX"; incomeType "bogus" → "other";
 *        grossAmount "abc" → 0; foreignTaxPaid -3 stored
 *   GewSt q1 -100 and q2 "zehn" → 0
 * These are tax figures that end up on Vordrucke — a typo turning silently
 * into 0 (or a negative Lohnsteuer) is worse than a 400.
 *
 * Callers: AnlageN/R/Kind/SO/AUS/GewSt sections (number inputs, "" → 0 on the
 * client, date inputs "" when empty, country upper-cased, max 2 chars),
 * e2e 127/129/130/132/135/136/138. `null` is rejected too: the client only
 * produces it from NaN, which the old code stored as 0.
 */
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
} from 'class-validator'

const AMOUNT_MAX = 999_999_999.99
const YEAR_MESSAGE = 'year ist ungültig'

/** A present value (not undefined) must be a finite number within 0..AMOUNT_MAX. */
function Amount(): PropertyDecorator {
  return (target, key) => {
    ValidateIf((_o, v) => v !== undefined)(target, key)
    IsNumber({ allowNaN: false, allowInfinity: false }, { message: `${String(key)} muss eine Zahl sein` })(target, key)
    Min(0, { message: `${String(key)} darf nicht negativ sein` })(target, key)
    Max(AMOUNT_MAX, { message: `${String(key)} ist zu groß` })(target, key)
  }
}

/** '' (an empty date input) or a real calendar date YYYY-MM-DD. */
function OptionalYmd(): PropertyDecorator {
  return (target, key) => {
    ValidateIf((_o, v) => v !== undefined && v !== '')(target, key)
    Matches(/^\d{4}-\d{2}-\d{2}$/, { message: `${String(key)} muss YYYY-MM-DD sein` })(target, key)
    IsDateString({ strict: true }, { message: `${String(key)} ist kein gültiges Datum` })(target, key)
  }
}

/**
 * { "<Kennziffer>": amount } as the sections send it (e.g. {"140": 1500}).
 * Keys are 1–4 digit Kennziffern, at most 30 of them, values amounts ≥ 0.
 */
function IsKennzifferAmounts(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isKennzifferAmounts',
      validator: {
        validate: (value: unknown) => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
          const entries = Object.entries(value as Record<string, unknown>)
          if (entries.length > 30) return false
          return entries.every(
            ([k, v]) =>
              /^\d{1,4}$/.test(k) &&
              typeof v === 'number' &&
              Number.isFinite(v) &&
              v >= 0 &&
              v <= AMOUNT_MAX,
          )
        },
        defaultMessage: (args) =>
          `${args?.property} muss ein Objekt { "Kennziffer": Betrag ≥ 0 } mit höchstens 30 Einträgen sein`,
      },
    },
    options,
  )
}

class YearDto {
  @IsInt({ message: YEAR_MESSAGE }) @Min(2000, { message: YEAR_MESSAGE }) @Max(2100, { message: YEAR_MESSAGE })
  year!: number
}

export class AnlageNSettingsDto extends YearDto {
  @Amount() bruttoArbeitslohn?: number
  @Amount() lohnsteuer?: number
  @Amount() soli?: number
  @Amount() kirchensteuer?: number
  @Amount() rentenversicherung?: number
  @Amount() arbeitslosenversicherung?: number
  @Amount() krankenversicherung?: number
  @Amount() pflegeversicherung?: number

  @IsOptional() @IsKennzifferAmounts() werbungskosten?: Record<string, number>
  @IsOptional() @IsKennzifferAmounts() sonderausgaben?: Record<string, number>
  @IsOptional() @IsKennzifferAmounts() aussergewoehnlicheBelastungen?: Record<string, number>
}

export class AnlageRSettingsDto extends YearDto {
  @Amount() drv?: number
  @Amount() bav?: number
  @Amount() riester?: number
  @Amount() ruerup?: number
  @Amount() privat?: number
  @Amount() sonstige?: number

  @IsOptional() @IsKennzifferAmounts() werbungskosten?: Record<string, number>
}

export class KindDto {
  @IsOptional() @IsString() @MaxLength(100)
  name?: string

  @OptionalYmd()
  birthDate?: string

  @IsOptional() @IsBoolean()
  kindergeldEligible?: boolean
}

export class AnlageKindSettingsDto extends YearDto {
  @IsArray({ message: 'kinder[] ist erforderlich (Array)' })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => KindDto)
  kinder!: KindDto[]
}

export class AnlageSoTransactionDto {
  @IsOptional() @IsIn(['wertpapier', 'sonstige'])
  type?: 'wertpapier' | 'sonstige'

  @IsOptional() @IsString() @MaxLength(500)
  description?: string

  @OptionalYmd() acquisitionDate?: string
  @Amount() acquisitionCost?: number
  @OptionalYmd() saleDate?: string
  @Amount() salePrice?: number
}

export class AnlageSoSettingsDto extends YearDto {
  @IsArray({ message: 'transactions[] ist erforderlich (Array)' })
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AnlageSoTransactionDto)
  transactions!: AnlageSoTransactionDto[]

  @Amount() wiederkehrendeBezuege?: number
  @Amount() werbungskosten?: number
}

export const ANLAGE_AUS_INCOME_TYPES = [
  'dividend', 'interest', 'rental', 'employment', 'business', 'selfEmployment', 'agriculture', 'other',
] as const

export class AnlageAusEntryDto {
  // Two letters as the section's input produces them (e.g. "US", "CH", and
  // "UK" in e2e 136 — not restricted to ISO 3166), or empty.
  @ValidateIf((_o, v) => v !== undefined && v !== '')
  @Matches(/^[A-Za-z]{2}$/, { message: 'country muss aus zwei Buchstaben bestehen' })
  country?: string

  @IsOptional() @IsString() @MaxLength(100)
  countryName?: string

  @IsOptional() @IsBoolean()
  hasDba?: boolean

  @IsOptional() @IsIn(ANLAGE_AUS_INCOME_TYPES)
  incomeType?: (typeof ANLAGE_AUS_INCOME_TYPES)[number]

  @Amount() grossAmount?: number
  @Amount() foreignTaxPaid?: number

  @IsOptional() @IsString() @MaxLength(500)
  description?: string
}

export class AnlageAusSettingsDto extends YearDto {
  @IsArray({ message: 'entries[] ist erforderlich (Array)' })
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnlageAusEntryDto)
  entries!: AnlageAusEntryDto[]
}

export class GewstSettingsDto extends YearDto {
  @Amount() q1?: number
  @Amount() q2?: number
  @Amount() q3?: number
  @Amount() q4?: number
}
