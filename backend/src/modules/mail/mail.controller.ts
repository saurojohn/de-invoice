import {
  Controller,
  Get,
  Put,
  Post,
  Query,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../../prisma/prisma.service';

interface MailConfigDto {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  fromEmail: string;
  enabled: boolean;
}

@Controller('mail')
export class MailController {
  constructor(
    private mailService: MailService,
    private prisma: PrismaService,
  ) {}

  @Get('config')
  async getConfig(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const cfg = await this.prisma.mailConfig.findUnique({ where: { companyId } });
    if (!cfg) {
      // Return env fallback as initial values for the UI form (without password)
      return {
        configured: false,
        smtpHost: process.env.SMTP_HOST || '',
        smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
        smtpSecure: process.env.SMTP_SECURE === 'true',
        smtpUser: process.env.SMTP_USER || '',
        smtpPassword: '',
        fromName: process.env.SMTP_FROM_NAME || '',
        fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
        enabled: true,
        source: 'env',
      };
    }
    return {
      configured: true,
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpSecure: cfg.smtpSecure,
      smtpUser: cfg.smtpUser,
      // Never return the password to the client (it would be plaintext over the wire)
      smtpPassword: '',
      fromName: cfg.fromName,
      fromEmail: cfg.fromEmail,
      enabled: cfg.enabled,
      source: 'database',
      updatedAt: cfg.updatedAt,
    };
  }

  @Put('config')
  async saveConfig(
    @Query('companyId') companyId: string,
    @Body() dto: Partial<MailConfigDto>,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!dto.smtpHost || !dto.smtpUser) {
      throw new BadRequestException('SMTP-Host und SMTP-Benutzer sind erforderlich');
    }

    const data = {
      smtpHost: dto.smtpHost,
      smtpPort: dto.smtpPort ?? 587,
      smtpSecure: dto.smtpSecure ?? false,
      smtpUser: dto.smtpUser,
      // If password is empty and a config exists, keep the old password
      smtpPassword: dto.smtpPassword && dto.smtpPassword.length > 0
        ? dto.smtpPassword
        : (await this.prisma.mailConfig.findUnique({ where: { companyId } }))?.smtpPassword || '',
      fromName: dto.fromName || 'Ihre Firma',
      fromEmail: dto.fromEmail || dto.smtpUser,
      enabled: dto.enabled ?? true,
    };

    const cfg = await this.prisma.mailConfig.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });

    return {
      ok: true,
      configured: true,
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpUser: cfg.smtpUser,
      fromEmail: cfg.fromEmail,
    };
  }

  @Post('test')
  async testConnection(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const result = await this.mailService.testConnection(companyId);
    return result;
  }
}
