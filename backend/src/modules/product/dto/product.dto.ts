import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsIn,
  Min,
  MinLength,
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

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'Ungültiger MwSt-Satz' })
  @Min(0, { message: 'MwSt-Satz darf nicht negativ sein' })
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
