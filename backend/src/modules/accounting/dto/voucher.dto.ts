/**
 * Tier 212 — request DTO for the createVoucher endpoint.
 *
 * Replaces `@Body() body: any` with a class-validator
 * decorated DTO so the global ValidationPipe can
 * reject unknown fields and coerce types before the
 * service layer runs.
 *
 * Note: the service's `CreateVoucherDto` interface
 * expects `date: Date`, but the HTTP body always
 * carries ISO strings. The controller converts with
 * `new Date(dto.date)` before calling the service —
 * the DTO is the *HTTP* layer type, the service
 * type is the *internal* type.
 */
import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsIn,
  IsDateString,
  ValidateNested,
  MinLength,
  MaxLength,
  Min,
  Max,
  ArrayMinSize,
} from "class-validator"
import { Type } from "class-transformer"

// VoucherLine.debit / credit / vatAmount are Decimal(12,4). Tier 377: without
// an upper bound a larger amount passed validation and failed in Postgres
// ("numeric field overflow") — POST /accounting/vouchers with debit 1e12
// answered 500 (measured).
const DECIMAL_12_4_MAX = 99999999.9999

/**
 * One voucher line (Soll/Haben position).
 */
export class CreateVoucherLineDto {
  // Tier 256: accountId is optional at the
  // HTTP layer so the Tier 26 Sachkonten
  // auto-inference spec can POST a line with
  // accountId=null + a description (e.g.
  // "Adobe Creative Cloud monthly") and have
  // the service infer the SKR03 account from
  // the description text. The previous
  // IsString-non-null assertion caused the
  // voucher POST to 400 with "lines.1.accountId
  // must be a string".
  @IsString() @IsOptional()
  accountId?: string | null

  @IsString() @IsOptional() @MaxLength(500)
  description?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(DECIMAL_12_4_MAX)
  debit?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(DECIMAL_12_4_MAX)
  credit?: number

  /**
   * VAT rate as a fraction (0.19 = 19%). DECIMAL(5,4)
   * so max is 9.9999.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(9.9999)
  vatRate?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(DECIMAL_12_4_MAX)
  vatAmount?: number

  @IsString() @IsOptional() @MaxLength(20)
  costCenter?: string

  @IsString() @IsOptional() @MaxLength(20)
  costObject?: string
}

/**
 * POST /accounting/vouchers
 * Create a new voucher. The voucher must have at
 * least 2 lines (one Soll, one Haben) — service-side
 * validation enforces this. The DTO enforces
 * ArrayMinSize(2) here for a clean 400.
 */
export class CreateVoucherDto {
  @IsString()
  companyId!: string

  @IsDateString({}, { message: "date is required (ISO date)" })
  date!: string

  @IsString() @IsOptional() @MinLength(1) @MaxLength(500)
  description?: string

  @IsString() @IsOptional() @MaxLength(50)
  referenceType?: string

  @IsString() @IsOptional() @IsIn(['draft', 'posted'])
  status?: 'draft' | 'posted'

  @IsString() @IsOptional() @MaxLength(50)
  createdById?: string

  // Tier 253: optional voucher number.
  // The service auto-generates a default
  // voucherNumber if not provided, but the e2e
  // tests (Tier 49, 50, 51) need to set their
  // own prefix-matched numbers so cleanup
  // queries (`WHERE voucherNumber LIKE 'Tier<N>%'`)
  // can be scoped. Without this, the
  // class-validator whitelist rejects the
  // request with "property voucherNumber
  // should not exist" (3 of the 23 e2e
  // failures caught in Tier 252 final
  // validation).
  @IsString() @IsOptional() @MinLength(1) @MaxLength(50)
  voucherNumber?: string

  @IsArray()
  @ArrayMinSize(2, { message: "Voucher muss mindestens 2 Positionen haben" })
  @ValidateNested({ each: true })
  @Type(() => CreateVoucherLineDto)
  lines!: CreateVoucherLineDto[]
}

/**
 * Tier 377 — POST /accounting/vouchers/:id/correct.
 *
 * The body was an inline type. Measured before: date "abc", a line amount of
 * 1e12, "zehn" as an amount and vatRate 19 all answered 500; negative debit /
 * credit was accepted (201) although creating a voucher requires >= 0. Lines
 * use the same line DTO as POST /accounting/vouchers. Callers: voucher detail
 * page, e2e 70/71, Playwright voucher-correct. "at least 2 lines", "every line
 * needs an account" and "Soll = Haben" stay in the controller/service, whose
 * messages the specs assert.
 */
export class CorrectVoucherDto {
  @IsOptional()
  @IsDateString({}, { message: "date muss ein gültiges Datum sein" })
  date?: string

  @IsString() @IsOptional() @MaxLength(500)
  description?: string

  @IsString() @IsOptional() @MaxLength(2000)
  reason?: string

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVoucherLineDto)
  lines!: CreateVoucherLineDto[]
}

/** Tier 377 — POST /accounting/vouchers/:id/reversal. */
export class ReverseVoucherDto {
  @IsString() @IsOptional() @MaxLength(2000)
  reason?: string
}

/**
 * Tier 377 — PUT /accounting/vouchers/:id/status. Only "voided" does anything
 * (it creates the Storno); any other value used to answer 200 and change
 * nothing. No caller in the frontend or the specs.
 */
export class UpdateVoucherStatusDto {
  @IsIn(["voided"], { message: 'status: nur "voided" wird unterstützt (erzeugt einen Storno)' })
  status!: "voided"
}
