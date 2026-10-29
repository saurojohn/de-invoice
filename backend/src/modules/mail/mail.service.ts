import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isSealed, openSecret, sealSecret, secretEncryptionAvailable } from '../../common/secret-crypto';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { businessLetterFooter } from '../../common/business-letter';

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
  /**
   * Tier 728c: a letter of the company to a customer — the company's details
   * are appended as a signature (§ 35a GmbHG / § 37a HGB apply to business
   * e-mails as to paper): full name, address, contact, seat, register,
   * directors, tax numbers, bank. Not for system mails (password, invites).
   */
  companySignature?: boolean;
  /**
   * Tier 736: a mail of the installation itself — the e-mail confirmation,
   * the password reset, the operator's error notices. It goes out through
   * the installation's server even before the company's address is
   * confirmed. Everything a company sends (invoices, reminders, statements,
   * invitations, portal links, its own notices) is not `system`.
   */
  system?: boolean;
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
  /** Tier 736: the company's own server, or the installation's (env) */
  source: 'company' | 'installation';
}

/** Tier 736: why the installation's server does not send for a company yet */
export const UNCONFIRMED_MAIL_MESSAGE =
  'Die E-Mail-Adresse Ihres Kontos ist noch nicht bestätigt. Bis dahin versendet de-invoice keine E-Mails ' +
  'für Ihre Firma über den Mailserver der Installation. Bitte klicken Sie auf den Link in der Bestätigungs-E-Mail ' +
  '(auf der Übersicht können Sie ihn erneut anfordern) oder richten Sie unter Einstellungen → E-Mail einen eigenen SMTP-Server ein.';

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);

  /**
   * Tier 630: SMTP passwords stored before this tier (or while the
   * installation had no key) are sealed once the key is there.
   */
  async onModuleInit() {
    if (!secretEncryptionAvailable()) return;
    try {
      const plain = (await this.prisma.mailConfig.findMany({ select: { id: true, smtpPassword: true } }))
        .filter((c) => c.smtpPassword && !isSealed(c.smtpPassword));
      for (const c of plain) {
        await this.prisma.mailConfig.update({ where: { id: c.id }, data: { smtpPassword: sealSecret(c.smtpPassword) } });
      }
      if (plain.length) this.logger.log(`[mail] ${plain.length} SMTP-Passwort/-Passwörter verschlüsselt abgelegt`);
    } catch (e) {
      this.logger.warn(`[mail] SMTP-Passwörter konnten beim Start nicht verschlüsselt werden: ${(e as Error)?.message}`);
    }
  }
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
      // Tier 630: the password is stored sealed
      const password = cfg ? openSecret(cfg.smtpPassword) : null;
      if (cfg && cfg.smtpPassword && password === null) {
        this.logger.warn(`[mail] das SMTP-Passwort der Firma ${companyId} lässt sich nicht entschlüsseln (FINTS_PIN_ENC_KEY fehlt oder wurde geändert) — bitte neu eingeben`);
      }
      if (cfg && cfg.enabled && cfg.smtpHost && cfg.smtpUser && password) {
        return {
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          secure: cfg.smtpSecure,
          user: cfg.smtpUser,
          pass: password,
          fromName: cfg.fromName,
          fromEmail: cfg.fromEmail,
          enabled: cfg.enabled,
          source: 'company',
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
      source: 'installation',
    };
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async isConfiguredFor(companyId: string): Promise<boolean> {
    const cfg = await this.resolveConfig(companyId);
    return cfg !== null;
  }

  /**
   * Tier 736 — may the installation's mail server send for this company?
   * Only once an admin of the company has confirmed their e-mail address.
   *
   * Registration needs nothing but an address typed into a form, and the
   * company's mails go out through the operator's server under the
   * operator's reputation: invoices, reminders, invitations and portal links
   * to any address the account enters. Unconfirmed, that is a relay for
   * whoever signs up. A company with its own SMTP server (Einstellungen →
   * E-Mail) sends through it and is not asked.
   */
  async installationMailAllowed(companyId: string): Promise<boolean> {
    if (!companyId) return false;
    const confirmedAdmin = await this.prisma.userCompany.findFirst({
      where: { companyId, role: 'admin', user: { emailVerifiedAt: { not: null }, status: 'active' } },
      select: { userId: true },
    });
    return !!confirmedAdmin;
  }

  /**
   * Tier 736 — throws the 400 that names the confirmation when the company
   * would send through the installation's server and may not yet. Without
   * any server configured nothing leaves the machine (the NO-SMTP log), so
   * nothing is refused.
   */
  async assertMaySend(companyId: string): Promise<void> {
    const cfg = await this.resolveConfig(companyId);
    if (cfg?.source === 'installation' && !(await this.installationMailAllowed(companyId))) {
      throw new BadRequestException(UNCONFIRMED_MAIL_MESSAGE);
    }
  }

  async send(companyId: string, options: SendMailOptions): Promise<{ messageId: string }> {
    if (options.companySignature) options = { ...options, text: await this.withSignature(companyId, options.text) };
    const cfg = await this.resolveConfig(companyId);
    if (cfg?.source === 'installation' && !options.system && !(await this.installationMailAllowed(companyId))) {
      this.logger.warn(`[mail] not sent for company ${companyId || '-'}: no admin has confirmed their e-mail address (Tier 736) — To: ${options.to} | Subject: ${options.subject}`);
      throw new BadRequestException(UNCONFIRMED_MAIL_MESSAGE);
    }
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

  /** Tier 728c: the text with the company's details below a signature separator */
  async withSignature(companyId: string, text: string): Promise<string> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        name: true, legalName: true, rechtsform: true, settings: true, address: true, phone: true, fax: true, email: true, website: true,
        taxId: true, vatId: true, bankInfo: true, registerEntry: true, managingDirector: true, otherInfo: true,
      },
    });
    if (!company) return text;
    const lines = businessLetterFooter(company as any);
    return lines.length ? `${String(text ?? '').replace(/\s+$/, '')}\n\n-- \n${lines.join('\n')}\n` : text;
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

