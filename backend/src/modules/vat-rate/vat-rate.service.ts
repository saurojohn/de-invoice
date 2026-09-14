import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateVatRateDto } from './dto/vat-rate.dto';

@Injectable()
export class VatRateService {
  constructor(private prisma: PrismaService) {}

  // Global rows (companyId NULL) plus the company's own — never another
  // company's (Tier 376).
  private visibleTo(companyId: string) {
    return { OR: [{ companyId: null }, { companyId }] };
  }

  async findAll(companyId: string, countryCode?: string) {
    return this.prisma.vatRate.findMany({
      where: { AND: [this.visibleTo(companyId), { countryCode }] },
      orderBy: { rate: 'desc' },
    });
  }

  async getCurrentRate(companyId: string, countryCode: string, date: Date = new Date()) {
    return this.prisma.vatRate.findFirst({
      where: {
        AND: [
          this.visibleTo(companyId),
          {
            countryCode,
            effectiveFrom: { lte: date },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
          },
        ],
      },
      orderBy: { rate: 'desc' },
    });
  }

  async create(data: CreateVatRateDto & { companyId: string }) {
    return this.prisma.vatRate.create({ data });
  }
}
