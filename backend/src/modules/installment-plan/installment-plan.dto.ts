import { IsInt, IsNumber, IsOptional, IsString, Max, Min, IsDateString } from 'class-validator'

/**
 * Tier 51: Create a new Ratenplan on an existing
 * Invoice. The service splits `totalAmount` into
 * `installmentCount` equal-sized Raten; the first
 * is due on `firstDueDate` and subsequent Raten
 * land at firstDueDate + N*intervalDays.
 */
export class CreateInstallmentPlanDto {
  @IsString()
  invoiceId!: string

  @IsInt()
  @Min(2) @Max(120)
  installmentCount!: number

  @IsNumber()
  @Min(0.01)
  totalAmount!: number

  @IsDateString()
  firstDueDate!: string

  @IsOptional() @IsInt() @Min(1) @Max(365)
  intervalDays?: number

  @IsOptional() @IsString()
  notes?: string
}

/**
 * Tier 51: Mark a single Installment as paid
 * (full or partial). `amount` is what the bank
 * import told us came in for this Rate; the
 * service bumps `paidAmount` and re-derives
 * `status` + the parent Plan's `status`.
 */
export class PayInstallmentDto {
  @IsNumber() @Min(0.01)
  amount!: number

  @IsOptional() @IsDateString()
  paidAt?: string
}
