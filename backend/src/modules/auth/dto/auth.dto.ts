import { IsOptional, IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;
  
  @IsString()
  @MinLength(6)
  password!: string;
}

export class RegisterDto {
  @IsEmail()
  email!: string;
  
  @IsString()
  @MinLength(6)
  password!: string;
  
  @IsString()
  companyName!: string;

  // Tier 821: the token of an invitation to register a company of one's own
  // (registration.ts) — needed while the registration is closed
  @IsOptional()
  @IsString()
  companyInvite?: string;

  // Tier 825: the setup link's token — the first registration of an empty
  // installation needs it when SETUP_TOKEN is set (registration.ts)
  @IsOptional()
  @IsString()
  setupToken?: string;
}
