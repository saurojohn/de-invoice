import {
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
      // Smart SKU lookup: if the input looks like an exact SKU, match
      // that one product first. Same two-stage pattern as the customer
      // number lookup — an OR can't tell apart "exact SKU" from
      // "SKU contains substring", so we count first and only fall
      // through to substring if the exact SKU doesn't exist.
      const exactSku = q.trim()
      const looksLikeExactSku = exactSku.length > 0 && exactSku.length <= 64
      if (looksLikeExactSku) {
        const exactCount = await this.prisma.product.count({
          where: { companyId, active: true, sku: exactSku },
        })
        if (exactCount > 0) {
          where.sku = exactSku
        } else {
          where.OR = [
            { name: { contains: q, mode: 'insensitive' } },
            { sku: { contains: q, mode: 'insensitive' } },
            // `category` is a relation, not a string field — to
            // search the joined category name we have to nest
            // through the relation. The old `category: { contains: q }`
            // here was a real bug: Prisma rejects it with
            // "Unknown argument `contains`" and 500'd every search
            // that hit this branch. Fixed 2026-06-06.
            { category: { is: { name: { contains: q, mode: 'insensitive' } } } },
            { description: { contains: q, mode: 'insensitive' } },
          ]
        }
      } else {
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { category: { is: { name: { contains: q, mode: 'insensitive' } } } },
          { description: { contains: q, mode: 'insensitive' } },
        ]
      }
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
      data: {
        ...data,
        companyId,
        // Tier 28: denormalise categoryName so the
        // Postgres tsvector STORED column (search_tsv)
        // can include it without a relation join.
        // Generated columns can't span relations in
        // PG 16, so we maintain the copy on every
        // Product write from the service. The relation
        // (categoryId) stays — this is just a
        // search-friendly text mirror.
        categoryName: await this.resolveCategoryName(data.categoryId),
      },
    });
  }

  async update(id: string, companyId: string, data: any) {
    // Verify the product belongs to the company before writing so a
    // bad URL doesn't accidentally cross-tenant.
    const existing = await this.prisma.product.findFirst({ where: { id, companyId } })
    if (!existing) throw new NotFoundException('Product not found')
    // Tier 28: refresh the denormalised categoryName
    // if the category changed (or is being cleared).
    const categoryName = data.categoryId !== undefined
      ? await this.resolveCategoryName(data.categoryId)
      : existing.categoryName
    return this.prisma.product.update({
      where: { id: existing.id },
      data: { ...data, categoryName },
    });
  }

  /**
   * Resolve a Category relation id to its display
   * name. Returns "" if the id is null/undefined
   * or the category doesn't exist (the latter is
   * defensive — FK constraints should prevent it).
   */
  private async resolveCategoryName(categoryId: string | null | undefined): Promise<string> {
    if (!categoryId) return ''
    const cat = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: { name: true },
    })
    return cat?.name ?? ''
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

  /**
   * Bulk-import products from a CSV-like row array.
   * The customer import (customer.service.importBulk)
   * is the template for this — same pattern, same
   * row-major try/catch, same per-row error array
   * so the frontend can render a tabular preview.
   *
   * Skip rules:
   *   - Same SKU + same company → skipped (no
   *     duplicate SKUs per company).
   *   - Same name + same company → also skipped
   *     (the user might have meant to update but
   *     bulk import is create-only; surfacing a
   *     "would be a duplicate" skip is safer than
   *     silently merging).
   *
   * Validation:
   *   - name is required (row rejected if blank).
   *   - basePrice is required (a product without
   *     a price is useless on an invoice).
   *   - vatRate defaults to 0.19 (German standard)
   *     when missing or unparseable.
   *   - sku is optional but normalised to upper-case
   *     + trimmed so the unique index works.
   *
   * Side effects:
   *   - Each successful row creates a Product with
   *     active=true and the supplied fields.
   *   - No StockHistory row is written (stock
   *     starts at 0; the user can adjust later
   *     or run an inventory count).
   */
  async importBulk(
    companyId: string,
    rows: ImportProductRow[],
  ): Promise<ImportProductResult> {
    const result: ImportProductResult = {
      total: rows.length,
      imported: 0,
      skipped: 0,
      errors: [],
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {}
      const rowNum = i + 2 // +2: row 1 is the header
      try {
        const name = (row.name || '').trim()
        if (!name) {
          result.errors.push({ row: rowNum, error: 'Name fehlt', name })
          continue
        }
        const basePriceStr = String(row.basePrice ?? '').trim()
        if (!basePriceStr) {
          result.errors.push({ row: rowNum, error: 'BasePrice fehlt', name })
          continue
        }
        const basePrice = parseFloat(basePriceStr.replace(',', '.'))
        if (Number.isNaN(basePrice) || basePrice < 0) {
          result.errors.push({ row: rowNum, error: `Ungültiger Preis: ${basePriceStr}`, name })
          continue
        }
        const sku = (row.sku || '').trim().toUpperCase() || null

        // Skip-duplicate check (SKU first, then name)
        if (sku) {
          const existing = await this.prisma.product.findFirst({
            where: { companyId, sku, active: true },
          })
          if (existing) {
            result.skipped++
            continue
          }
        }
        const existingName = await this.prisma.product.findFirst({
          where: { companyId, name, active: true },
        })
        if (existingName) {
          result.skipped++
          continue
        }

        // Tier 410: only an unparseable value falls back to 19 % — `|| 0.19`
        // also turned a deliberate 0 (a tax-exempt product) into 19 %.
        const parsedVatRate = parseFloat(
          String(row.vatRate ?? '0.19').trim().replace(',', '.'),
        )
        const vatRate = Number.isFinite(parsedVatRate) ? parsedVatRate : 0.19

        await this.prisma.product.create({
          data: {
            companyId,
            name,
            sku,
            description: (row.description || '').trim() || null,
            type: (row.type || 'good').trim(),
            unit: (row.unit || 'piece').trim(),
            basePrice,
            vatRate,
            stockQuantity: 0,
            trackInventory: false,
            active: true,
          },
        })
        result.imported++
      } catch (e: any) {
        result.errors.push({
          row: rowNum,
          error: e?.message || 'Unbekannter Fehler',
          name: (row.name || '').trim(),
        })
      }
    }
    return result
  }
}

export interface ImportProductRow {
  name?: string
  sku?: string
  description?: string
  type?: string
  unit?: string
  basePrice?: string | number
  vatRate?: string | number
}

export interface ImportProductResult {
  total: number
  imported: number
  skipped: number
  errors: Array<{ row: number; error: string; name?: string }>
}
