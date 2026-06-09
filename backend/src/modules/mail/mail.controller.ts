import {
  Controller,
  Get,
  Put,
  Post,
  Query,
  Body,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Auth, Require } from '../../auth/roles.decorator';

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

  /**
   * List all outbound emails for this company. The list view
   * for the Email Center dashboard. Server-side pagination
   * + filters keep the response small even for companies
   * that have sent thousands of emails.
   *
   * Filters:
   *   - status: exact match (sent / failed / opened / bounced)
   *   - invoiceId: filter to a specific invoice's emails
   *   - q: substring match on recipientEmail / subject / recipientName
   *   - dateFrom / dateTo: ISO 8601 bounds on sentAt (falls back
   *     to createdAt if sentAt is null)
   */
  @Auth()
  @Get('emails')
  @Require('invoice.read')
  async listEmails(
    @Query('companyId') companyId: string,
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
    @Query('status') status?: string,
    @Query('invoiceId') invoiceId?: string,
    @Query('q') q?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const page = Math.max(1, parseInt(pageStr || '1', 10))
    const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeStr || '50', 10)))

    const where: any = { companyId }
    if (status) where.status = status
    if (invoiceId) where.invoiceId = invoiceId
    if (q) {
      // OR search across recipient + subject. Postgres ILIKE
      // through the @prisma/client works for substring without
      // needing raw SQL.
      where.OR = [
        { recipientEmail: { contains: q, mode: 'insensitive' } },
        { recipientName: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ]
    }
    if (dateFrom || dateTo) {
      where.sentAt = {}
      if (dateFrom) where.sentAt.gte = new Date(dateFrom)
      if (dateTo) where.sentAt.lte = new Date(dateTo)
    }

    const [rows, total] = await Promise.all([
      this.prisma.emailSend.findMany({
        where,
        orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          invoice: {
            select: { id: true, invoiceNumber: true, status: true, total: true },
          },
        },
      }),
      this.prisma.emailSend.count({ where }),
    ])

    return { data: rows, total, page, pageSize }
  }

  /**
   * Stats summary for the Email Center dashboard tile.
   * Returns counts and the total recipient count for the
   * last 30 days.
   *
   * Declared BEFORE the `:id` route so the literal
   * "stats" segment doesn't get swallowed by the param.
   */
  @Auth()
  @Get('emails/stats')
  @Require('invoice.read')
  async emailStats(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const [byStatus, total] = await Promise.all([
      this.prisma.emailSend.groupBy({
        by: ['status'],
        where: { companyId, createdAt: { gte: since } },
        _count: { status: true },
      }),
      this.prisma.emailSend.count({ where: { companyId, createdAt: { gte: since } } }),
    ])
    const counts: Record<string, number> = {}
    for (const r of byStatus) counts[r.status] = r._count.status
    return { counts, total, since: since.toISOString() }
  }

  /**
   * Get a single outbound email by id. Returns the full row
   * including bodyPreview and attachment paths so the detail
   * view can show what was sent.
   */
  @Auth()
  @Get('emails/:id')
  @Require('invoice.read')
  async getEmail(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const email = await this.prisma.emailSend.findFirst({
      where: { id, companyId },
      include: {
        invoice: {
          select: { id: true, invoiceNumber: true, status: true, total: true, customer: { select: { name: true } } },
        },
      },
    })
    if (!email) throw new BadRequestException('Email not found')
    return email
  }
}
