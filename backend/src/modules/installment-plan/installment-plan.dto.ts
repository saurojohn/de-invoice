import { IsInt, IsNumber, IsOptional, IsString, Max, Min, IsDateString, IsNotEmpty, MaxLength, IsBoolean } from 'class-validator'

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

/**
 * Tier 383 — POST /installment-plans/from-invoice.
 *
 * The inline body skipped the bounds CreateInstallmentPlanDto above already
 * has. Measured before this change: installmentCount 2.5 → 201 with the plan
 * stored as 2 Raten but 3 installment rows of 476 € (1428 € for a 1190 €
 * invoice); installmentCount 5000 → 201 and 5000 rows; intervalDays -30 and
 * 0 → 201 (due dates backwards / all on one day); installmentCount "drei" and
 * firstDueDate "abc" → 500. Callers: invoice detail page (Ratenplan
 * suggestion — its form state may hold strings, which the pipe converts),
 * e2e 92. Same bounds as CreateInstallmentPlanDto.
 */
export class CreateInstallmentPlanFromInvoiceDto {
  @IsString() @IsNotEmpty()
  invoiceId!: string

  @IsInt({ message: 'installmentCount muss eine ganze Zahl sein' })
  @Min(2) @Max(120)
  installmentCount!: number

  @IsDateString({ strict: true }, { message: 'firstDueDate ist kein gültiges Datum' })
  firstDueDate!: string

  @IsOptional() @IsInt() @Min(1) @Max(365)
  intervalDays?: number

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string

  @IsOptional() @IsBoolean()
  autoPause?: boolean

  @IsOptional() @IsString() @MaxLength(500)
  pauseReason?: string

  @IsOptional() @IsString()
  createdById?: string
}
