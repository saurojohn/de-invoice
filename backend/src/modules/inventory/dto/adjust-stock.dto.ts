/**
 * Tier 378 — PUT /inventory/:productId/adjust.
 *
 * The body was typed with `AdjustStockDto`, an interface in
 * inventory.service.ts, so nothing was validated: an empty body answered 500
 * (quantity undefined reached Prisma), and undeclared fields passed. Callers:
 * inventory page (adjust / purchase / initial stock: quantity, changeType,
 * notes | null, reference | null, referenceType), e2e 158.
 */
import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator'

export class AdjustStockDto {
  // Product.stockQuantity / ProductStockHistory.quantity are Decimal(12,4).
  @IsNumber({}, { message: 'Menge muss eine Zahl sein' })
  @Min(0, { message: 'Menge darf nicht negativ sein' })
  @Max(99999999.9999)
  quantity!: number

  @IsIn(['sale', 'purchase', 'adjustment', 'return', 'initial'])
  changeType!: 'sale' | 'purchase' | 'adjustment' | 'return' | 'initial'

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(200)
  reference?: string | null

  @IsOptional() @IsString() @MaxLength(50)
  referenceType?: string

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(2000)
  notes?: string | null
}
