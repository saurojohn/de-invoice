import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';

export interface SendMailOptions {
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }>;
}

interface ResolvedConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  enabled: boolean;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private transporterKey: string | null = null; // signature of current transporter
  private configured = false;

  constructor(private prisma: PrismaService) {}

  /**
   * Resolve SMTP config for a given company.
   * Priority: MailConfig row in DB → process.env fallback.
   */
  private async resolveConfig(companyId?: string): Promise<ResolvedConfig | null> {
    // 1) Per-company DB config
    if (companyId) {
      const cfg = await this.prisma.mailConfig.findUnique({ where: { companyId } });
      if (cfg && cfg.enabled && cfg.smtpHost && cfg.smtpUser && cfg.smtpPassword) {
        return {
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          secure: cfg.smtpSecure,
          user: cfg.smtpUser,
          pass: cfg.smtpPassword,
          fromName: cfg.fromName,
          fromEmail: cfg.fromEmail,
          enabled: cfg.enabled,
        };
      }
    }
    // 2) Env fallback
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    if (!host || !user || !pass) return null;
    return {
      host,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user,
      pass,
      fromName: process.env.SMTP_FROM_NAME || 'Ihre Firma',
      fromEmail: process.env.SMTP_FROM_EMAIL || user,
      enabled: true,
    };
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async isConfiguredFor(companyId: string): Promise<boolean> {
    const cfg = await this.resolveConfig(companyId);
    return cfg !== null;
  }

  async send(companyId: string, options: SendMailOptions): Promise<{ messageId: string }> {
    const cfg = await this.resolveConfig(companyId);
    if (!cfg) {
      this.logger.warn(
        `[NO-SMTP] companyId=${companyId} To: ${options.to}` +
        (options.cc?.length ? ` | CC: ${options.cc.join(', ')}` : '') +
        ` | Subject: ${options.subject}` +
        ` | Attachments: ${options.attachments?.map((a) => a.filename).join(', ') || 'none'}` +
        ` → Configure SMTP in Settings page to actually send.`,
      );
      return { messageId: `dev-${Date.now()}` };
    }

    // (Re)build transporter if config changed
    const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
    if (!this.transporter || this.transporterKey !== key) {
      this.transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
      });
      this.transporterKey = key;
      this.configured = true;
      this.logger.log(`SMTP transporter ready: ${key}`);
    }

    const from = `"${cfg.fromName}" <${cfg.fromEmail}>`;
    const info = await this.transporter.sendMail({
      from,
      to: options.to,
      cc: options.cc,
      subject: options.subject,
      text: options.text,
      html: options.html,
      attachments: options.attachments,
    });
    this.logger.log(`Email sent: ${info.messageId} → ${options.to}`);
    return { messageId: info.messageId };
  }

  async testConnection(companyId: string): Promise<{ ok: boolean; error?: string; from: string }> {
    const cfg = await this.resolveConfig(companyId);
    if (!cfg) return { ok: false, error: 'Keine SMTP-Konfiguration gefunden', from: '' };
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    try {
      await transporter.verify();
      return { ok: true, from: `${cfg.fromName} <${cfg.fromEmail}>` };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Verbindung fehlgeschlagen', from: `${cfg.fromName} <${cfg.fromEmail}>` };
    }
  }
}

