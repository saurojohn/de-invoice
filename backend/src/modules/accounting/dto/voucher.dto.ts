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

/**
 * One voucher line (Soll/Haben position).
 */
export class CreateVoucherLineDto {
  @IsString()
  accountId!: string

  @IsString() @IsOptional() @MaxLength(500)
  description?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  debit?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
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
