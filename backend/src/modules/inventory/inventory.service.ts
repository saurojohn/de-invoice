import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type StockChangeType = 'sale' | 'purchase' | 'adjustment' | 'return' | 'initial';

export interface AdjustStockDto {
  quantity: number;
  changeType: StockChangeType;
  reference?: string;
  referenceType?: string;
  notes?: string;
}

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  async getStock(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        sku: true,
        stockQuantity: true,
        lowStockThreshold: true,
        trackInventory: true,
        unit: true,
      },
    });
    return product;
  }

  async adjustStock(productId: string, dto: AdjustStockDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) {
      throw new Error('Product not found');
    }

    const previousQty = parseFloat(product.stockQuantity.toString());
    let newQty: number;

    switch (dto.changeType) {
      case 'sale':
        // Decrease stock on sale
        newQty = previousQty - dto.quantity;
        break;
      case 'purchase':
      case 'return':
        // Increase stock on purchase or return
        newQty = previousQty + dto.quantity;
        break;
      case 'adjustment':
      case 'initial':
        // Direct set or initial value
        newQty = dto.quantity;
        break;
      default:
        newQty = dto.quantity;
    }

    // Update product stock in transaction
    const [updatedProduct, history] = await this.prisma.$transaction([
      this.prisma.product.update({
        where: { id: productId },
        data: { stockQuantity: newQty },
      }),
      this.prisma.productStockHistory.create({
        data: {
          productId,
          changeType: dto.changeType,
          quantity: dto.quantity,
          previousQty,
          newQty,
          reference: dto.reference || null,
          referenceType: dto.referenceType || 'manual',
          notes: dto.notes || null,
        },
      }),
    ]);

    return {
      product: updatedProduct,
      history,
      previousQty,
      newQty,
      change: newQty - previousQty,
    };
  }

  async getLowStockProducts(companyId: string) {
    // Get all products where trackInventory is true and stock <= threshold
    const products = await this.prisma.product.findMany({
      where: {
        companyId,
        trackInventory: true,
        active: true,
        NOT: {
          lowStockThreshold: null,
        },
      },
      select: {
        id: true,
        name: true,
        sku: true,
        stockQuantity: true,
        lowStockThreshold: true,
        unit: true,
      },
    });

    // Filter to only those below threshold
    return products.filter((p) => {
      const stock = parseFloat(p.stockQuantity.toString());
      const threshold = parseFloat(p.lowStockThreshold!.toString());
      return stock <= threshold;
    });
  }

  async getStockHistory(productId: string, limit = 50) {
    return this.prisma.productStockHistory.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async checkStockForInvoice(productId: string, quantity: number): Promise<{ sufficient: boolean; available: number; required: number }> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true, trackInventory: true },
    });

    if (!product || !product.trackInventory) {
      return { sufficient: true, available: -1, required: quantity };
    }

    const available = parseFloat(product.stockQuantity.toString());
    return {
      sufficient: available >= quantity,
      available,
      required: quantity,
    };
  }

  async recordInvoiceItems(invoiceId: string, items: { productId: string; quantity: number }[]) {
    // Record stock deduction for each item with inventory tracking
    for (const item of items) {
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
        select: { trackInventory: true, stockQuantity: true },
      });

      if (product?.trackInventory) {
        const currentStock = parseFloat(product.stockQuantity.toString());
        const newStock = currentStock - item.quantity;

        await this.prisma.$transaction([
          this.prisma.product.update({
            where: { id: item.productId },
            data: { stockQuantity: newStock },
          }),
          this.prisma.productStockHistory.create({
            data: {
              productId: item.productId,
              changeType: 'sale',
              quantity: item.quantity,
              previousQty: currentStock,
              newQty: newStock,
              reference: invoiceId,
              referenceType: 'invoice',
              notes: `Automatische Bestandsreduzierung durch Rechnung ${invoiceId}`,
            },
          }),
        ]);
      }
    }
  }
}