import { IsString, IsEmail, IsOptional, IsIn } from 'class-validator';

export class SendReminderDto {
  @IsString()
  invoiceId!: string;

  @IsString()
  companyId!: string;

  @IsEmail()
  recipientEmail!: string;

  @IsString()
  recipientName!: string;

  @IsString()
  subject!: string;

  @IsString()
  body!: string;

  @IsIn(['first', 'second', 'final'])
  level!: 'first' | 'second' | 'final';

  @IsOptional()
  @IsString()
  createdById?: string;
}

export class GetReminderEmailDto {
  @IsString()
  invoiceId!: string;

  @IsString()
  companyId!: string;

  @IsIn(['first', 'second', 'final'])
  level!: 'first' | 'second' | 'final';
}