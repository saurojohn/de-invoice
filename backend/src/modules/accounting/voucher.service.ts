import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountService } from './account.service';

interface CreateVoucherDto {
  companyId: string;
  date: Date;
  description?: string;
  referenceType?: string;
  lines: {
    accountId: string;
    description?: string;
    debit?: number;
    credit?: number;
    vatRate?: number;
    vatAmount?: number;
  }[];
}

@Injectable()
export class VoucherService {
  constructor(
    private prisma: PrismaService,
    private accountService: AccountService,
  ) {}

  async create(dto: CreateVoucherDto) {
    // Validate debits = credits
    const totalDebit = dto.lines.reduce((sum, l) => sum + (l.debit || 0), 0);
    const totalCredit = dto.lines.reduce((sum, l) => sum + (l.credit || 0), 0);
    
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new BadRequestException('Soll und Haben müssen ausgeglichen sein');
    }

    // Generate voucher number
    const voucherNumber = await this.generateVoucherNumber(dto.companyId, dto.date);

    return this.prisma.voucher.create({
      data: {
        companyId: dto.companyId,
        voucherNumber,
        date: dto.date,
        description: dto.description,
        referenceType: dto.referenceType,
        status: 'posted',
        lines: {
          create: dto.lines.map((line, idx) => ({
            accountId: line.accountId,
            description: line.description,
            debit: line.debit || 0,
            credit: line.credit || 0,
            vatRate: line.vatRate,
            vatAmount: line.vatAmount,
            sortOrder: idx,
          })),
        },
      },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  async findAll(companyId: string, filters?: { startDate?: Date; endDate?: Date; status?: string }) {
    const where: any = { companyId };
    if (filters?.startDate || filters?.endDate) {
      where.date = {};
      if (filters.startDate) where.date.gte = filters.startDate;
      if (filters.endDate) where.date.lte = filters.endDate;
    }
    if (filters?.status) {
      where.status = filters.status;
    }

    return this.prisma.voucher.findMany({
      where,
      include: {
        lines: {
          include: { account: true },
        },
      },
      orderBy: [{ date: 'desc' }, { voucherNumber: 'desc' }],
    });
  }

  async findOne(id: string, companyId: string) {
    const voucher = await this.prisma.voucher.findFirst({
      where: { id, companyId },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!voucher) {
      throw new NotFoundException('Buchungsbeleg nicht gefunden');
    }
    return voucher;
  }

  async void(id: string, companyId: string) {
    await this.findOne(id, companyId);
    return this.prisma.voucher.update({
      where: { id },
      data: { status: 'voided' },
    });
  }

  async generateFromInvoice(invoiceId: string, companyId: string) {
    // Check if voucher already exists for this invoice
    const existingVoucher = await this.prisma.voucher.findFirst({
      where: { companyId, invoiceRef: { id: invoiceId } },
    });
    if (existingVoucher) {
      return existingVoucher;
    }

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: {
        items: true,
        customer: true,
      },
    });
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden');
    }

    const lines: CreateVoucherDto['lines'] = [];
    const total = parseFloat(invoice.total.toString());
    const totalVat = parseFloat(invoice.totalVat.toString());
    const subtotal = total - totalVat;

    if (invoice.reverseCharge || invoice.euTransaction) {
      // EU cross-border: no VAT entry (reverse charge)
      // Debit: Receivables
      const receivablesAccount = await this.accountService.getOrCreateAccount(
        companyId, '1400', 'Forderungen aus Lieferungen und Leistungen', 'asset'
      );
      lines.push({
        accountId: receivablesAccount.id,
        description: `Forderungen aus Rechnung ${invoice.invoiceNumber}`,
        debit: total,
      });

      // Credit: Sales Revenue
      const salesAccount = await this.accountService.getOrCreateAccount(
        companyId, '4200', 'Umsatzerlöse 19%', 'revenue'
      );
      lines.push({
        accountId: salesAccount.id,
        description: `Umsatzerlöse Rechnung ${invoice.invoiceNumber}`,
        credit: total,
      });
    } else {
      // Domestic: with VAT
      // Debit: Receivables (total including VAT)
      const receivablesAccount = await this.accountService.getOrCreateAccount(
        companyId, '1400', 'Forderungen aus Lieferungen und Leistungen', 'asset'
      );
      lines.push({
        accountId: receivablesAccount.id,
        description: `Forderungen aus Rechnung ${invoice.invoiceNumber}`,
        debit: total,
      });

      // Credit: Sales Revenue (net amount)
      const salesAccount = await this.accountService.getOrCreateAccount(
        companyId, '4200', 'Umsatzerlöse 19%', 'revenue'
      );
      lines.push({
        accountId: salesAccount.id,
        description: `Umsatzerlöse Rechnung ${invoice.invoiceNumber}`,
        credit: subtotal,
      });

      // Credit: VAT Liability
      const vatAccount = await this.accountService.getOrCreateAccount(
        companyId, '2200', 'Umsatzsteuer', 'liability'
      );
      lines.push({
        accountId: vatAccount.id,
        description: `Umsatzsteuer Rechnung ${invoice.invoiceNumber}`,
        credit: totalVat,
      });
    }

    return this.prisma.voucher.create({
      data: {
        companyId,
        voucherNumber: await this.generateVoucherNumber(companyId, invoice.issueDate),
        date: invoice.issueDate,
        description: `Verkauf Rechnung ${invoice.invoiceNumber}`,
        referenceType: 'invoice',
        status: 'posted',
        invoiceRef: { connect: { id: invoiceId } },
        lines: {
          create: lines.map((line, idx) => ({
            accountId: line.accountId,
            description: line.description,
            debit: line.debit || 0,
            credit: line.credit || 0,
            sortOrder: idx,
          })),
        },
      },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  private async generateVoucherNumber(companyId: string, date: Date): Promise<string> {
    const year = date.getFullYear();
    const prefix = `BK-${year}-`;

    // Find highest sequence for this year
    const lastVoucher = await this.prisma.voucher.findFirst({
      where: {
        companyId,
        voucherNumber: { startsWith: prefix },
      },
      orderBy: { voucherNumber: 'desc' },
    });

    let nextNum = 1;
    if (lastVoucher) {
      const lastNum = parseInt(lastVoucher.voucherNumber.replace(prefix, ''), 10);
      nextNum = lastNum + 1;
    }

    return `${prefix}${nextNum.toString().padStart(4, '0')}`;
  }
}