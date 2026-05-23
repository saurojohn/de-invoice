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
}

export class CreateInvoiceDto {
  @IsString()
  customerId!: string;
  
  @IsDateString()
  issueDate!: string;
  
  @IsDateString()
  dueDate!: string;
  
  @IsString()
  @IsOptional()
  type?: string;
  
  @IsString()
  @IsOptional()
  currency?: string;
  
  @IsString()
  @IsOptional()
  language?: string;
  
  @IsString()
  @IsOptional()
  notes?: string;
  
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
