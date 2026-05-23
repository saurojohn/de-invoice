import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';

@Injectable()
export class InvoiceService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string, filters?: { status?: string; customerId?: string }) {
    return this.prisma.invoice.findMany({
      where: { companyId, ...filters },
      include: { customer: true, items: true, payments: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, companyId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, companyId },
      include: { customer: true, items: true, payments: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async create(companyId: string, dto: CreateInvoiceDto) {
    // 生成发票号
    const count = await this.prisma.invoice.count({ where: { companyId } });
    const invoiceNumber = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;

    return this.prisma.invoice.create({
      data: {
        companyId,
        customerId: dto.customerId,
        invoiceNumber,
        issueDate: new Date(dto.issueDate),
        dueDate: new Date(dto.dueDate),
        type: dto.type || 'INV',
        status: 'draft',
        currency: dto.currency || 'EUR',
        language: dto.language || 'de-DE',
        notes: dto.notes,
        items: {
          create: dto.items?.map((item, index) => ({
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unitPrice,
            vatRate: item.vatRate || 0.19,
            netAmount: item.quantity * item.unitPrice,
            vatAmount: item.quantity * item.unitPrice * (item.vatRate || 0.19),
            grossAmount: item.quantity * item.unitPrice * (1 + (item.vatRate || 0.19)),
            sortOrder: index,
          })),
        },
      },
      include: { items: true },
    });
  }

  async update(id: string, companyId: string, dto: UpdateInvoiceDto) {
    return this.prisma.invoice.update({
      where: { id },
      data: dto,
      include: { items: true },
    });
  }

  async updateStatus(id: string, companyId: string, status: string) {
    return this.prisma.invoice.update({
      where: { id },
      data: { status },
    });
  }
}
