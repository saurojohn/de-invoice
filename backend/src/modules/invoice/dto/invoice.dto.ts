import { IsString, IsArray, ValidateNested, IsNumber, IsOptional, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export class InvoiceItemDto {
  @IsString()
  description!: string;
  
  @IsNumber()
  quantity!: number;
  
  @IsString()
  @IsOptional()
  unit?: string;
  
  @IsNumber()
  unitPrice!: number;
  
  @IsNumber()
  @IsOptional()
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

  @IsNumber()
  @IsOptional()
  discountPercent?: number;

  @IsNumber()
  @IsOptional()
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
  
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  @IsOptional()
  items?: InvoiceItemDto[];
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
  @IsNumber() @IsOptional() discountPercent?: number;
  @IsNumber() @IsOptional() discountAmount?: number;
  @IsNumber() @IsOptional() paymentTerms?: number;
  @IsString() @IsOptional() paymentMethod?: string;
  @IsString() @IsOptional() templateType?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  @IsOptional() items?: InvoiceItemDto[];
}

