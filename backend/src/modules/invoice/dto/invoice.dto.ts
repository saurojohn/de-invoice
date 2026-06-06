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
}

export class CreateInvoiceDto {
  @IsString()
  customerId!: string;
  
  @IsDateString()
  issueDate!: string;
  
  @IsDateString()
  @IsOptional()
  dueDate?: string;
  
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
  @IsString()
  @IsOptional()
  notes?: string;
  
  @IsDateString()
  @IsOptional()
  dueDate?: string;
}
