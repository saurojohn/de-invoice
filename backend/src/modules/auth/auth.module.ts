import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailModule } from '../mail/mail.module';
// Tier 368: AuditService signs the auth audit rows (login_success,
// login_failed, password_reset_*), which used to be written unsigned via
// prisma.auditLog.create and so sat outside the hash chain.
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [MailModule, AuditModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
