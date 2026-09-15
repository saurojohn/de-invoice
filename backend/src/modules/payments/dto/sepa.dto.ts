/**
 * Tier 380 — request DTOs for the SEPA routes.
 *
 * POST /payments/mandates, /payments/direct-debit/batches and /payments/batches
 * typed their bodies inline, and the services only regex-checked IBAN
 * prefixes and date shapes. Measured on a fresh stack before this change:
 *   mandates   dateOfSignature "2026-02-30" → 201, stored as 2026-03-02;
 *              IBAN "DE00", "DE12!!!@@@" and a wrong check digit → 201;
 *              mandateReference of 80 chars (SEPA max 35), debitorName of 300
 *              (max 70), BIC "not a bic!!" → 201; undeclared fields accepted
 *   dd batches collections ["x"] / numeric / null ids → 500;
 *              executionDate "2026-13-45" → 500; creditorIban "DE00" → 201 and
 *              "DE00" written into the pain.008 XML
 *   ct batches expenseIds [123] / [null] → 500
 * A bank rejects a pain.001/pain.008 file with an invalid IBAN, so the check
 * digits are validated here (ISO 13616 mod-97 via class-validator's IsIBAN),
 * not left to the bank. The XML generators already escape their values.
 *
 * Callers: payments page (credit transfer), direct-debit page (mandate,
 * batch), e2e 134/137/176/179, Playwright direct-debit. The services keep
 * their German checks (customer / invoices / mandates of this company, active
 * mandate, no mixed CORE+B2B, creditor identifier present).
 */
import { Type } from 'class-transformer'
import {
  ArrayMinSize,
  IsArray,
  IsBIC,
  IsDateString,
  IsIBAN,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator'

const YMD = /^\d{4}-\d{2}-\d{2}$/
const YMD_MESSAGE = 'muss ein gültiges Datum im Format YYYY-MM-DD sein'
// SEPA "Restricted Character Set" (EPC217-08) for references and ids.
const SEPA_ID = /^[A-Za-z0-9+?/:().,' -]+$/

export class CreateMandateDto {
  @IsString() @IsNotEmpty()
  companyId!: string

  @IsString() @IsNotEmpty({ message: 'customerId ist erforderlich' }) @MaxLength(64)
  customerId!: string

  // Mandate reference (MndtId): max 35 chars of the SEPA character set.
  @IsOptional() @IsString() @MaxLength(35) @Matches(SEPA_ID, { message: 'mandateReference enthält Zeichen außerhalb des SEPA-Zeichensatzes' })
  mandateReference?: string

  @Matches(YMD, { message: `dateOfSignature ${YMD_MESSAGE}` })
  @IsDateString({ strict: true }, { message: `dateOfSignature ${YMD_MESSAGE}` })
  dateOfSignature!: string

  @IsOptional() @IsIn(['CORE', 'B2B'], { message: "type muss 'CORE' oder 'B2B' sein" })
  type?: 'CORE' | 'B2B'

  @IsIBAN(undefined, { message: 'IBAN ist ungültig (Format oder Prüfziffer)' })
  iban!: string

  @IsOptional() @IsBIC({ message: 'BIC ist ungültig' })
  bic?: string

  // Debtor name (Dbtr/Nm): max 70 chars.
  @IsString() @IsNotEmpty({ message: 'debitorName ist erforderlich' }) @MaxLength(70)
  debitorName!: string

  @IsOptional() @IsString() @MaxLength(140)
  description?: string
}

export class DirectDebitCollectionDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  invoiceId!: string

  @IsString() @IsNotEmpty() @MaxLength(64)
  mandateId!: string
}

export class CreateDirectDebitBatchDto {
  @IsString() @IsNotEmpty()
  companyId!: string

  @IsArray({ message: 'collections[] ist erforderlich (nicht leer)' })
  @ArrayMinSize(1, { message: 'collections[] ist erforderlich (nicht leer)' })
  @ValidateNested({ each: true })
  @Type(() => DirectDebitCollectionDto)
  collections!: DirectDebitCollectionDto[]

  @Matches(YMD, { message: `executionDate ${YMD_MESSAGE}` })
  @IsDateString({ strict: true }, { message: `executionDate ${YMD_MESSAGE}` })
  executionDate!: string

  @IsOptional() @IsIn(['CORE', 'B2B'], { message: "type muss 'CORE' oder 'B2B' sein" })
  type?: 'CORE' | 'B2B'

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string

  @IsOptional() @IsIBAN(undefined, { message: 'Gläubiger-IBAN ist ungültig (Format oder Prüfziffer)' })
  creditorIban?: string

  @IsOptional() @IsBIC({ message: 'Gläubiger-BIC ist ungültig' })
  creditorBic?: string

  @IsOptional() @IsString() @MaxLength(70)
  creditorName?: string

  // Creditor identifier (CI): max 35 chars.
  @IsOptional() @IsString() @MaxLength(35) @Matches(SEPA_ID, { message: 'creditorIdentifier enthält Zeichen außerhalb des SEPA-Zeichensatzes' })
  creditorIdentifier?: string
}

export class CreateCreditTransferBatchDto {
  @IsString() @IsNotEmpty()
  companyId!: string

  @IsArray({ message: 'expenseIds[] ist erforderlich (nicht leer)' })
  @ArrayMinSize(1, { message: 'expenseIds[] ist erforderlich (nicht leer)' })
  @IsString({ each: true, message: 'expenseIds[] darf nur IDs enthalten' })
  @IsNotEmpty({ each: true, message: 'expenseIds[] darf nur IDs enthalten' })
  @MaxLength(64, { each: true })
  expenseIds!: string[]

  @Matches(YMD, { message: `executionDate ${YMD_MESSAGE}` })
  @IsDateString({ strict: true }, { message: `executionDate ${YMD_MESSAGE}` })
  executionDate!: string

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string

  @IsOptional() @IsIBAN(undefined, { message: 'Debtor-IBAN ist ungültig (Format oder Prüfziffer)' })
  debtorIban?: string

  @IsOptional() @IsBIC({ message: 'Debtor-BIC ist ungültig' })
  debtorBic?: string

  @IsOptional() @IsString() @MaxLength(70)
  debtorName?: string
}
