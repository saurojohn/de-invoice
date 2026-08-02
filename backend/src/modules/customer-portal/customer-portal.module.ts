/**
 * Tier 130: customer-portal module.
 *
 * Public-facing (no auth) endpoints that let a customer
 * log in with their email and see all their invoices.
 *
 * Dependencies:
 *   - PrismaService (via @Global PrismaModule, no import needed)
 *   - MailService (for the login-link email send)
 *   - invoice-pdf.service (for the PDF download)
 */
import { Module } from '@nestjs/common';
import { CustomerPortalController } from './customer-portal.controller';
import { CustomerPortalService } from './customer-portal.service';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [MailModule],
  controllers: [CustomerPortalController],
  providers: [CustomerPortalService],
  exports: [CustomerPortalService],
})
export class CustomerPortalModule {}
