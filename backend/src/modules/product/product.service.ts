import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProductService {
  constructor(private prisma: PrismaService) {}

  /**
   * Paginated list of active products. Supports `page`, `pageSize`, and
   * `search` (matches name / sku / category / description).
   */
  async findAll(
    companyId: string,
    opts: { page?: number; pageSize?: number; search?: string } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50))
    const skip = (page - 1) * pageSize
    const where: any = { companyId, active: true }
    if (opts.search && opts.search.trim()) {
      const q = opts.search.trim()
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ]
    }
    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: true },
        orderBy: { name: 'asc' },
        skip,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ])
    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    }
  }

  async create(companyId: string, data: any) {
    return this.prisma.product.create({
      data: { ...data, companyId },
    });
  }

  async update(id: string, data: any) {
    return this.prisma.product.update({ where: { id }, data });
  }

  async findOne(id: string) {
    return this.prisma.product.findUnique({
      where: { id },
      include: { stockHistory: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
  }
}
