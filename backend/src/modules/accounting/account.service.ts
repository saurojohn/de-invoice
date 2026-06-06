import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface CreateAccountDto {
  companyId: string;
  accountNumber: string;
  name: string;
  type: string;
  category?: string;
  parentId?: string;
  isVatAccount?: boolean;
}

interface UpdateAccountDto {
  name?: string;
  type?: string;
  category?: string;
  parentId?: string;
  isVatAccount?: boolean;
  active?: boolean;
}

@Injectable()
export class AccountService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateAccountDto) {
    return this.prisma.account.create({
      data: dto,
    });
  }

  async findAll(companyId: string) {
    return this.prisma.account.findMany({
      where: { companyId },
      orderBy: { accountNumber: 'asc' },
    });
  }

  async findOne(id: string, companyId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, companyId },
    });
    if (!account) {
      throw new NotFoundException('Konto nicht gefunden');
    }
    return account;
  }

  async update(id: string, companyId: string, dto: UpdateAccountDto) {
    await this.findOne(id, companyId);
    return this.prisma.account.update({
      where: { id },
      data: dto,
    });
  }

  async seedDefaultAccounts(companyId: string) {
    const defaults = [
      { accountNumber: '1000', name: 'Kasse', type: 'asset', category: 'liquidity' },
      { accountNumber: '1200', name: 'Bank', type: 'asset', category: 'liquidity' },
      { accountNumber: '1400', name: 'Forderungen aus Lieferungen und Leistungen', type: 'asset', category: 'receivables' },
      { accountNumber: '1600', name: 'Vorsteuer', type: 'asset', category: 'vat', isVatAccount: true },
      { accountNumber: '1800', name: 'Sonstige Vermögensgegenstände', type: 'asset', category: 'other' },
      { accountNumber: '2000', name: 'Verbindlichkeiten aus Lieferungen und Leistungen', type: 'liability', category: 'payables' },
      { accountNumber: '2200', name: 'Umsatzsteuer', type: 'liability', category: 'vat', isVatAccount: true },
      { accountNumber: '2800', name: 'Erhaltene Anzahlungen', type: 'liability', category: 'prepayments' },
      { accountNumber: '4200', name: 'Umsatzerlöse 19%', type: 'revenue', category: 'sales' },
      { accountNumber: '4300', name: 'Umsatzerlöse 7%', type: 'revenue', category: 'sales' },
      { accountNumber: '6000', name: 'Aufwendungen für Waren', type: 'expense', category: 'cogs' },
      { accountNumber: '8000', name: 'Sonstige Erträge', type: 'revenue', category: 'other' },
    ];

    const results = [];
    for (const acc of defaults) {
      const existing = await this.prisma.account.findFirst({
        where: { companyId, accountNumber: acc.accountNumber },
      });
      if (!existing) {
        results.push(await this.prisma.account.create({
          data: { ...acc, companyId },
        }));
      }
    }
    return results;
  }

  async getOrCreateAccount(companyId: string, accountNumber: string, defaultName: string, defaultType: string) {
    let account = await this.prisma.account.findFirst({
      where: { companyId, accountNumber },
    });
    if (!account) {
      account = await this.prisma.account.create({
        data: {
          companyId,
          accountNumber,
          name: defaultName,
          type: defaultType,
        },
      });
    }
    return account;
  }
}