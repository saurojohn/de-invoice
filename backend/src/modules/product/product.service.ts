import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProductService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string) {
    return this.prisma.product.findMany({
      where: { companyId, active: true },
      include: { category: true },
      orderBy: { name: 'asc' },
    });
  }

  async create(companyId: string, data: any) {
    return this.prisma.product.create({
      data: { ...data, companyId },
    });
  }

  async update(id: string, data: any) {
    return this.prisma.product.update({ where: { id }, data });
  }
}
