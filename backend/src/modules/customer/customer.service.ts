import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CustomerService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string) {
    return this.prisma.customer.findMany({
      where: { companyId },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, companyId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, companyId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async create(companyId: string, data: any) {
    return this.prisma.customer.create({
      data: { ...data, companyId },
    });
  }

  async update(id: string, companyId: string, data: any) {
    return this.prisma.customer.update({
      where: { id },
      data,
    });
  }
}
