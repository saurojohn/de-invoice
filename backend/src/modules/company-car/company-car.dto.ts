import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { COMPANY_CAR_METHODS } from './private-use'

/** Tier 502: POST /company-cars */
export class CreateCompanyCarDto {
  @IsString() @MaxLength(100)
  name!: string

  /** gross list price at first registration */
  @IsNumber() @Min(1000) @Max(9999999)
  listPrice!: number

  @IsIn(COMPANY_CAR_METHODS as unknown as string[])
  method!: string

  @IsDateString()
  fromDate!: string

  @IsOptional() @IsDateString()
  untilDate?: string | null
}

/** Tier 502: PUT /company-cars/:id — the end of private use (sold, given back). */
export class EndCompanyCarDto {
  @IsOptional() @IsDateString()
  untilDate?: string | null
}
