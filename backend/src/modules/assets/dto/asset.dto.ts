/**
 * Tier 377 — request DTOs for AssetsController.
 *
 * The controller typed its bodies with `AssetCreateDto` / `AssetUpdateDto` /
 * `AssetDisposeDto` — interfaces in assets.service.ts. The names look like
 * DTOs, but an interface does not exist at runtime, so ValidationPipe checked
 * nothing. Measured before: anschaffungsDatum "abc", anschaffungsKosten 1e14
 * (column Decimal(14,4)) and "hundert" answered 500 on create; PATCH with
 * anschaffungsDatum "abc" or restwert 1e14 → 500; dispose with verkauftAm
 * "abc" or verkaufsPreis 1e14 → 500; nutzungsdauerMonate 12.5 was accepted
 * for an Int column.
 *
 * Callers: assets page (create with ISO timestamp + notiz null, dispose), e2e
 * 109/160/177, Playwright assets-afa (bilanzKonto "0300", notiz null). The
 * service keeps its German checks (Anlagentyp, Bezeichnung, AK > 0, ND > 0,
 * Restwert <= AK, dispose date >= acquisition) — e2e 160 asserts them.
 */
import { IsDateString, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator'

// Asset.anschaffungsKosten / restwert / verkaufsPreis are Decimal(14,4).
const DECIMAL_14_4_MAX = 9999999999.9999

export class CreateAssetDto {
  @IsString() @MaxLength(50)
  type!: string

  @IsString() @MaxLength(500)
  bezeichnung!: string

  @IsDateString({}, { message: 'anschaffungsDatum muss ein gültiges Datum sein' })
  anschaffungsDatum!: string

  @IsNumber({}, { message: 'Anschaffungskosten müssen eine Zahl sein' })
  @Max(DECIMAL_14_4_MAX, { message: 'Anschaffungskosten dürfen höchstens 9999999999.9999 sein' })
  anschaffungsKosten!: number

  @IsInt({ message: 'Nutzungsdauer muss eine ganze Zahl von Monaten sein' })
  @Max(1200)
  nutzungsdauerMonate!: number

  @IsOptional()
  @IsNumber()
  @Max(DECIMAL_14_4_MAX)
  restwert?: number

  @IsOptional() @IsString() @MaxLength(20)
  afaMethode?: string

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(20)
  bilanzKonto?: string | null

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(2000)
  notiz?: string | null
}

export class UpdateAssetDto {
  @IsOptional() @IsString() @MaxLength(50)
  type?: string

  @IsOptional() @IsString() @MaxLength(500)
  bezeichnung?: string

  @IsOptional()
  @IsDateString({}, { message: 'anschaffungsDatum muss ein gültiges Datum sein' })
  anschaffungsDatum?: string

  @IsOptional()
  @IsNumber()
  @Max(DECIMAL_14_4_MAX)
  anschaffungsKosten?: number

  @IsOptional()
  @IsInt({ message: 'Nutzungsdauer muss eine ganze Zahl von Monaten sein' })
  @Max(1200)
  nutzungsdauerMonate?: number

  @IsOptional()
  @IsNumber()
  @Max(DECIMAL_14_4_MAX)
  restwert?: number

  @IsOptional() @IsString() @MaxLength(20)
  afaMethode?: string

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(20)
  bilanzKonto?: string | null

  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(2000)
  notiz?: string | null
}

export class DisposeAssetDto {
  @IsDateString({}, { message: 'verkauftAm muss ein gültiges Datum sein' })
  verkauftAm!: string

  @IsOptional()
  @IsNumber()
  @Min(0, { message: 'Verkaufspreis darf nicht negativ sein' })
  @Max(DECIMAL_14_4_MAX)
  verkaufsPreis?: number
}
