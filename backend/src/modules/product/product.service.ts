import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

  async update(id: string, companyId: string, data: any) {
    // Verify the product belongs to the company before writing so a
    // bad URL doesn't accidentally cross-tenant.
    const existing = await this.prisma.product.findFirst({ where: { id, companyId } })
    if (!existing) throw new NotFoundException('Product not found')
    return this.prisma.product.update({ where: { id: existing.id }, data });
  }

  async findOne(id: string) {
    return this.prisma.product.findUnique({
      where: { id },
      include: { stockHistory: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
  }

  /**
   * Tenant-scoped variant of findOne — used by the controller so the
   * caller can't peek at a product that belongs to a different
   * company by guessing the UUID.
   */
  async findOneScoped(id: string, companyId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, companyId },
      include: { stockHistory: { orderBy: { createdAt: 'desc' }, take: 10 } },
    })
    if (!product) throw new NotFoundException('Product not found')
    return product
  }

  /**
   * Soft-delete by default. If the product is referenced by any
   * invoice line we throw so the caller can decide whether to
   * archive manually; if not, we hard-delete to free the SKU for
   * reuse.
   */
  async remove(id: string, companyId: string) {
    const product = await this.prisma.product.findFirst({ where: { id, companyId } })
    if (!product) throw new NotFoundException('Product not found')
    const usage = await this.prisma.invoiceItem.count({
      where: { productId: id },
    })
    if (usage > 0) {
      // Soft-delete: keep the row but hide it from pickers.
      await this.prisma.product.update({
        where: { id },
        data: { active: false },
      })
      return { ok: true, soft: true, usedInInvoices: usage }
    }
    await this.prisma.product.delete({ where: { id } })
    return { ok: true, soft: false }
  }
}
