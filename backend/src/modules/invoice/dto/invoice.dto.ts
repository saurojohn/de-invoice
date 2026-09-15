import { IsString, IsArray, ValidateNested, IsNumber, IsOptional, IsDateString, IsBoolean, MaxLength, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class InvoiceItemDto {
  @IsString()
  description!: string;
  
  // Tier 372: bounded to what InvoiceItem.quantity (Decimal(12,4)) can hold.
  // Without this, an oversized value passed validation and failed in Postgres
  // with "numeric field overflow" — a 500 for a client error. The range is
  // symmetric on purpose: this only turns that 500 into a 400 and does not
  // decide whether negative lines are allowed.
  @IsNumber()
  @Min(-99999999.9999)
  @Max(99999999.9999)
  quantity!: number;

  @IsString()
  @IsOptional()
  unit?: string;
  
  // Tier 372: same column limit as quantity (Decimal(12,4)); symmetric, so a
  // negative adjustment line stays possible.
  @IsNumber()
  @Min(-99999999.9999)
  @Max(99999999.9999)
  unitPrice!: number;

  // Tier 372: a fraction, like every other VAT-rate DTO in the codebase
  // (expense, cashbook, product all use @Min(0) @Max(1)) and like the frontend
  // sends it (0.19). This had no bounds, so vatRate: 19 reached the
  // Decimal(5,4) column and failed with a numeric overflow → HTTP 500.
  @IsNumber()
  @IsOptional()
  @Min(0, { message: 'MwSt-Satz darf nicht negativ sein' })
  @Max(1, { message: 'MwSt-Satz ist ein Anteil (z. B. 0.19), höchstens 1' })
  vatRate?: number;

  @IsString()
  @IsOptional()
  productId?: string;

  // Produktnummer / SKU. Distinct from productId (FK to the
  // Product master) — this is the value the user wants to
  // PRINT on this line of the invoice. The product picker
  // auto-fills it from Product.sku, but the user can override
  // it (e.g. for a customer-specific part number on a manual
  // line). Optional: not every invoice has SKUs.
  @IsString()
  @IsOptional()
  productNumber?: string;
}

export class CreateInvoiceDto {
  @IsString()
  customerId!: string;
  
  @IsDateString()
  issueDate!: string;

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsDateString()
  @IsOptional()
  deliveryDate?: string;
  
  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  referenceInvoiceId?: string;
  
  @IsString()
  @IsOptional()
  currency?: string;
  
  @IsString()
  @IsOptional()
  language?: string;
  
  @IsString()
  @IsOptional()
  notes?: string;

  // Tier 372: discountPercent had no bounds while its sibling skontoPercent
  // below is @Min(0) @Max(100); the column is Decimal(5,2), so >999.99 was a
  // numeric overflow → 500. discountAmount is bounded to its Decimal(12,4)
  // column only.
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @IsNumber()
  @IsOptional()
  @Min(-99999999.9999)
  @Max(99999999.9999)
  discountAmount?: number;

  @IsNumber()
  @IsOptional()
  paymentTerms?: number;

  @IsString()
  @IsOptional()
  paymentMethod?: string;
  
  @IsString()
  @IsOptional()
  templateType?: string;

  // Tier 52: Skonto (cash discount for early payment).
  // Both fields are optional; if both are set the PDF
  // renders the standard "Zahlbar bis ... mit X% Skonto"
  // line. Values > 100 (percent) or > 365 (days) are
  // rejected — these are clearly mis-typed.
  @IsNumber() @IsOptional() @Max(100) @Min(0)
  skontoPercent?: number;
  @IsInt() @IsOptional() @Max(365) @Min(0)
  skontoDays?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  @IsOptional()
  items?: InvoiceItemDto[];

  // Tier 27: USt-Behandlung (reverse charge / IgE).
  //
  // These are the two §13b / §1a flags that the
  // Berater needs on the DATEV export. The UI
  // (frontend/src/app/dashboard/invoices/create/page.tsx)
  // presents them as a single "USt-Behandlung"
  // radio group, but on the wire they're two
  // booleans — the combinations are:
  //
  //   - both false        : Standard 19%/7% USt
  //   - reverseCharge=true: §13b UStG, Steuerschuld
  //                         des Leistungsempfängers.
  //                         The recipient self-assesses
  //                         VAT. We still issue a normal-
  //                         looking invoice, but the VAT
  //                         line is 0% and a footnote
  //                         cites §13b UStG. DATEV
  //                         USt-Schlüssel: 12/13.
  //   - euTransaction=true: §1a UStG, innergemein-
  //                         schaftliche Lieferung.
  //                         The recipient self-assesses
  //                         via their own IgE
  //                         Versteuerung. We issue a
  //                         net-only invoice. DATEV
  //                         USt-Schlüssel: 14/15.
  //   - both true is a contradiction (an
  //     invoice can't be BOTH §13b AND §1a) — the
  //     UI prevents this and the service layer
  //     rejects it on the way in.
  //
  // Why two booleans instead of an enum? The DB
  // column is already a Boolean (baseline
  // migration 20240101000000), and the existing
  // reverseCharge/euTransaction semantics on the
  // rest of the codebase (DATEV export, UStVA,
  // Elster) already use both booleans — adding an
  // enum would break the existing 50/58 e2e
  // assertions.
  @IsBoolean()
  @IsOptional()
  reverseCharge?: boolean;

  @IsBoolean()
  @IsOptional()
  euTransaction?: boolean;

  // Tier 39: DATEV Kostenstelle 1 + Kostenträger stamps.
  // Free-form strings, not FK-restricted. The user can
  // pick from /cost-centers in the UI but can also type
  // a one-off (DATEV importers commonly do this).
  @IsString() @MaxLength(20) @IsOptional() costCenter?: string;
  @IsString() @MaxLength(40) @IsOptional() costObject?: string;
}

export class UpdateInvoiceDto {
  // All fields optional — partial updates are the norm for an edit
  // form. The service enforces the same-day rule on issueDate: even
  // if a client tries to change it, the server compares the EXISTING
  // invoice's issueDate against today and rejects edits past that.
  // customerId and type are not editable here on purpose — switching
  // INV↔CN mid-flight breaks audit trails; issue a credit note instead.
  @IsString() @IsOptional() customerId?: string;
  @IsDateString() @IsOptional() issueDate?: string;
  @IsDateString() @IsOptional() dueDate?: string;
  @IsDateString() @IsOptional() deliveryDate?: string;
  @IsString() @IsOptional() type?: string;
  @IsString() @IsOptional() referenceInvoiceId?: string;
  @IsString() @IsOptional() currency?: string;
  @IsString() @IsOptional() language?: string;
  @IsString() @IsOptional() notes?: string;
  // Tier 372: same bounds as CreateInvoiceDto (see there).
  @IsNumber() @IsOptional() @Min(0) @Max(100) discountPercent?: number;
  @IsNumber() @IsOptional() @Min(-99999999.9999) @Max(99999999.9999) discountAmount?: number;
  @IsNumber() @IsOptional() paymentTerms?: number;
  @IsString() @IsOptional() paymentMethod?: string;
  @IsString() @IsOptional() templateType?: string;
  // Tier 52: Skonto (cash discount for early payment).
  // Both fields are optional; if both are set the PDF
  // renders the standard "Zahlbar bis ... mit X% Skonto"
  // line. Values > 100 (percent) or > 365 (days) are
  // rejected — these are clearly mis-typed.
  @IsNumber() @IsOptional() @Max(100) @Min(0)
  skontoPercent?: number;
  @IsInt() @IsOptional() @Max(365) @Min(0)
  skontoDays?: number;
  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  @IsOptional() items?: InvoiceItemDto[];

  // Tier 27: same USt-Behandlung flags as on
  // create. Edit-mode intentionally allows these
  // — the same-day edit window (GoBD) covers the
  // correction, and the audit trail stamps the
  // before/after values on every change. See
  // journal.service.ts and the e2e 03 test for
  // the Storno flow.
  @IsBoolean() @IsOptional() reverseCharge?: boolean;
  @IsBoolean() @IsOptional() euTransaction?: boolean;

  // Tier 39: DATEV Kostenstelle 1 + Kostenträger stamps.
  // Optional so existing flows (and any e2e that doesn't
  // care about cost centers) keep working unchanged.
  // Free-form strings, not FK-restricted — the user can
  // pick from /cost-centers but can also type a one-off
  // (DATEV imports often do this with ad-hoc codes).
  @IsString() @MaxLength(20) @IsOptional() costCenter?: string;
  @IsString() @MaxLength(40) @IsOptional() costObject?: string;

  // Tier 39 internalNotes — editable in update only,
  // NOT on create (internal notes are post-issue).
  @IsString() @IsOptional() internalNotes?: string;
}


/**
 * Tier 379 — PUT /invoices/:id/status.
 *
 * The handler read `@Body('status') status: string` and stored it verbatim:
 * `{"status":"lolwut"}` answered 200 and was persisted, `{}` answered 200 and
 * changed nothing (both measured). The values are the ones the only UI caller
 * offers — the status dropdown on the invoice detail page — and the ones the
 * backend itself writes (draft on create, sent / paid / cancelled). `partial`,
 * `voided` and `open` appear in a few comparisons but nothing ever writes them.
 */
export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const;

export class UpdateInvoiceStatusDto {
  @IsIn(INVOICE_STATUSES, {
    message: `status muss einer der Werte ${INVOICE_STATUSES.join(', ')} sein`,
  })
  status!: (typeof INVOICE_STATUSES)[number];
}
