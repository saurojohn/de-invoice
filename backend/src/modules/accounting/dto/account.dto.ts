/**
 * Tier 211 — request DTOs for AccountController (chart
 * of accounts / Kontenplan).
 *
 * The `AccountService` previously typed its create/update
 * args as local TypeScript `interface`s. We replace those
 * with class-validator decorated DTOs so the global
 * ValidationPipe (whitelist + transform +
 * forbidNonWhitelisted) can reject unknown fields and
 * coerce types before the service runs.
 *
 * The service signature is unchanged — it imports the
 * same DTO class — so the typed contract between
 * controller and service is preserved.
 */
import {
  IsString,
  IsOptional,
  IsBoolean,
  MinLength,
  MaxLength,
} from "class-validator"
import { Transform } from "class-transformer"

/**
 * POST /accounts
 * Create a new account in the chart of accounts.
 *
 * Note: `companyId` is on the query string in the
 * controller — the service merges query.companyId
 * into the dto before calling Prisma. So the DTO
 * does NOT include companyId.
 */
export class CreateAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  accountNumber!: string

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  type!: string

  @IsString()
  @IsOptional()
  @MaxLength(50)
  category?: string

  @IsString()
  @IsOptional()
  parentId?: string

  /**
   * Coerce "true"/"false" / "1"/"0" strings to boolean.
   * Frontend may submit form-encoded strings for the
   * checkbox; we want the DB row to receive a real bool.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "string") {
      return value === "true" || value === "1"
    }
    return value
  })
  @IsBoolean()
  isVatAccount?: boolean
}

/**
 * PUT /accounts/:id
 * Update an existing account. All fields optional —
 * the service treats undefined as "leave unchanged".
 */
export class UpdateAccountDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(200)
  name?: string

  @IsString()
  @IsOptional()
  @MaxLength(50)
  type?: string

  @IsString()
  @IsOptional()
  @MaxLength(50)
  category?: string

  @IsString()
  @IsOptional()
  parentId?: string

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "string") {
      return value === "true" || value === "1"
    }
    return value
  })
  @IsBoolean()
  isVatAccount?: boolean

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === "string") {
      return value === "true" || value === "1"
    }
    return value
  })
  @IsBoolean()
  active?: boolean
}
