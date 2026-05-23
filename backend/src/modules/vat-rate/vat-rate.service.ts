import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class VatRateService {
  constructor(private prisma: PrismaService) {}

  async findAll(countryCode?: string) {
    return this.prisma.vatRate.findMany({
      where: { countryCode },
      orderBy: { rate: 'desc' },
    });
  }

  async getCurrentRate(countryCode: string, date: Date = new Date()) {
    return this.prisma.vatRate.findFirst({
      where: {
        countryCode,
        effectiveFrom: { lte: date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
      },
      orderBy: { rate: 'desc' },
    });
  }

  async create(data: any) {
    return this.prisma.vatRate.create({ data });
  }
}
