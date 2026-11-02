import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAccountDto, UpdateAccountDto } from './dto/account.dto';

@Injectable()
export class AccountService {
  constructor(private prisma: PrismaService) {}

  async create(companyId: string, dto: CreateAccountDto) {
    await this.assertOwnParent(companyId, dto.parentId);
    // Tier 778: a number the company already has was the unique index's P2002
    // — HTTP 500 "Resource already exists" and an error event for the operator.
    const taken = await this.prisma.account.findFirst({
      where: { companyId, accountNumber: dto.accountNumber },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException(`Das Konto ${dto.accountNumber} gibt es in dieser Firma schon.`);
    }
    return this.prisma.account.create({
      data: { ...dto, parentId: dto.parentId || null, companyId },
    });
  }

  /**
   * Tier 778: the parent account was taken as sent — an account of another
   * company was accepted, and the new account hung under it in that
   * company's chart of accounts. (parentId is a plain column, no foreign key:
   * nothing else checked it. An empty one is no parent.)
   */
  private async assertOwnParent(companyId: string, parentId: string | null | undefined) {
    if (!parentId) return;
    const parent = await this.prisma.account.findFirst({ where: { id: parentId, companyId }, select: { id: true } });
    if (!parent) {
      throw new BadRequestException('Das übergeordnete Konto gibt es in dieser Firma nicht.');
    }
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
    await this.assertOwnParent(companyId, dto.parentId);
    return this.prisma.account.update({
      where: { id },
      data: dto,
    });
  }

  async seedDefaultAccounts(companyId: string) {
    // Tier 467: SKR03 — the numbers DATEV reads. The list used an invented
    // numbering: a manual voucher on the seeded "4200 Umsatzerlöse 19%" and
    // "2200 Umsatzsteuer" reached DATEV as 4200 Raumkosten and 2200
    // Körperschaftsteuer (the export writes the account number as it is);
    // "1600 Vorsteuer" is Verbindlichkeiten L+L there, "2000" außerordentliche
    // Aufwendungen, "1800" Privatentnahmen. Revenue and purchases are the
    // accounts WITHOUT automatic tax (8200 / 3200): a voucher books the net
    // amount and its tax on 1776 / 1571 / 1576 / 1771 itself — on the
    // Automatikkonten 8400 / 3400 DATEV would compute the tax a second time.
    // Existing companies keep the rows they have (seeding only adds numbers
    // that are missing); correcting old vouchers is a decision (HANDOFF §9).
    const defaults = [
      { accountNumber: '1000', name: 'Kasse', type: 'asset', category: 'liquidity' },
      { accountNumber: '1200', name: 'Bank', type: 'asset', category: 'liquidity' },
      { accountNumber: '1400', name: 'Forderungen aus Lieferungen und Leistungen', type: 'asset', category: 'receivables' },
      { accountNumber: '1571', name: 'Abziehbare Vorsteuer 7 %', type: 'asset', category: 'vat', isVatAccount: true },
      { accountNumber: '1576', name: 'Abziehbare Vorsteuer 19 %', type: 'asset', category: 'vat', isVatAccount: true },
      { accountNumber: '1600', name: 'Verbindlichkeiten aus Lieferungen und Leistungen', type: 'liability', category: 'payables' },
      { accountNumber: '1710', name: 'Erhaltene Anzahlungen', type: 'liability', category: 'prepayments' },
      { accountNumber: '1771', name: 'Umsatzsteuer 7 %', type: 'liability', category: 'vat', isVatAccount: true },
      { accountNumber: '1776', name: 'Umsatzsteuer 19 %', type: 'liability', category: 'vat', isVatAccount: true },
      { accountNumber: '1800', name: 'Privatentnahmen allgemein', type: 'equity', category: 'private' },
      { accountNumber: '1890', name: 'Privateinlagen', type: 'equity', category: 'private' },
      { accountNumber: '2700', name: 'Sonstige Erträge', type: 'revenue', category: 'other' },
      { accountNumber: '3200', name: 'Wareneingang', type: 'expense', category: 'cogs' },
      { accountNumber: '4900', name: 'Sonstige betriebliche Aufwendungen', type: 'expense', category: 'operating' },
      // Tier 256: the Sachkonten inference (datev-sachkonto-inference.ts)
      // books e.g. Adobe on 4980.
      { accountNumber: '4980', name: 'Sonstiger Betriebsbedarf', type: 'expense', category: 'operating' },
      { accountNumber: '8200', name: 'Erlöse', type: 'revenue', category: 'sales' },
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