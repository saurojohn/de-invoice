import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsIn,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CreateProductDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Produktname ist erforderlich' })
  name!: string;

  // SKU is optional but uniqueness is enforced at the service layer
  // (per-company) so two different companies can use the same SKU.
  @IsString()
  @IsOptional()
  sku?: string;

  @IsString()
  @IsIn(['good', 'service'])
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  unit?: string;

  // Prices / VAT are stored as strings in the DB (Decimal). Coerce
  // numbers safely so a missing field becomes 0 rather than NaN.
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'Ungültiger Preis' })
  @Min(0, { message: 'Preis darf nicht negativ sein' })
  basePrice!: number;

  // German UIs typically display VAT as a percentage (e.g. "19 %"),
  // but the DB column is `Decimal(5,4)` storing the decimal (0.19).
  // Accept both forms: values > 1 are treated as percentages and
  // divided by 100; values in [0, 1] are treated as the decimal.
  // Without this, typing "19" in a German form yields a 500 numeric
  // overflow (precision 5, scale 4 → max ~9.9999).
  @Transform(({ value }) => {
    if (value === '' || value == null) return value
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return value
    return n > 1 ? n / 100 : n
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'Ungültiger MwSt-Satz' })
  @Min(0, { message: 'MwSt-Satz darf nicht negativ sein' })
  @Max(1, { message: 'MwSt-Satz darf höchstens 100 % sein' })
  @IsOptional()
  vatRate?: number;

  @IsString()
  @IsOptional()
  description?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  stockQuantity?: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  lowStockThreshold?: number;

  @IsBoolean()
  @IsOptional()
  trackInventory?: boolean;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

/**
 * Tier 212 — request DTO for ProductController.update.
 *
 * Replaces `@Body() data: any` with a class-validator
 * decorated DTO so the global ValidationPipe can
 * reject unknown fields and coerce types before the
 * service layer runs. Every field is optional —
 * the service treats undefined as "leave unchanged".
 */
export class UpdateProductDto {
  @IsString() @IsOptional() @MaxLength(50)
  sku?: string;

  @IsString() @IsOptional() @MinLength(1) @MaxLength(200)
  name?: string;

  @IsString() @IsOptional() @MaxLength(2000)
  description?: string;

  @IsString() @IsOptional() @IsIn(['good', 'service'])
  type?: string;

  @IsString() @IsOptional() @MaxLength(20)
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  basePrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  purchasePrice?: number;

  /**
   * VAT rate as a fraction (0.19 = 19%). DECIMAL(5,4)
   * so max is 9.9999.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(9.9999)
  vatRate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  stockQuantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lowStockThreshold?: number;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value === 'true' || value === '1'
    }
    return value
  })
  @IsBoolean()
  trackInventory?: boolean;

  @IsString() @IsOptional()
  categoryId?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value === 'true' || value === '1'
    }
    return value
  })
  @IsBoolean()
  active?: boolean;
}
