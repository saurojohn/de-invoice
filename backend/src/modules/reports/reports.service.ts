import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface SalesReportParams {
  companyId: string;
  startDate: Date;
  endDate: Date;
}

export interface VatReportParams {
  companyId: string;
  year: number;
  quarter?: number;
  month?: number;
}

export interface CustomerReportParams {
  companyId: string;
  startDate: Date;
  endDate: Date;
}

export interface SalesReportResult {
  totalSales: number;
  totalVat: number;
  byCustomer: Array<{
    customerId: string;
    customerName: string;
    totalAmount: number;
    invoiceCount: number;
  }>;
  byMonth: Array<{
    month: string;
    totalAmount: number;
    invoiceCount: number;
  }>;
  yearOverYear: Array<{
    year: number;
    totalAmount: number;
    growthPercent: number | null;
  }>;
}

export interface VatReportResult {
  byRate: Array<{
    vatRate: number;
    netAmount: number;
    vatAmount: number;
    grossAmount: number;
    invoiceCount: number;
  }>;
  totalNet: number;
  totalVat: number;
  totalGross: number;
}

export interface CustomerReportResult {
  customers: Array<{
    customerId: string;
    customerName: string;
    totalInvoices: number;
    totalAmount: number;
    paidAmount: number;
    pendingAmount: number;
    overdueAmount: number;
    lastInvoiceDate: string | null;
  }>;
  summary: {
    totalCustomers: number;
    totalAmount: number;
    totalPaid: number;
    totalPending: number;
    totalOverdue: number;
  };
}

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async getSalesReport(params: SalesReportParams): Promise<SalesReportResult> {
    const { companyId, startDate, endDate } = params;

    // Get all invoices in date range with paid or sent status
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: {
          gte: startDate,
          lte: endDate,
        },
        status: { in: ['paid', 'sent', 'overdue'] },
      },
      include: {
        customer: { select: { id: true, name: true } },
        items: true,
      },
      orderBy: { issueDate: 'asc' },
    });

    // Calculate total sales
    const totalSales = invoices.reduce(
      (sum, inv) => sum + Number(inv.subtotal),
      0,
    );
    const totalVat = invoices.reduce(
      (sum, inv) => sum + Number(inv.totalVat),
      0,
    );

    // Group by customer
    const customerMap = new Map<
      string,
      { customerId: string; customerName: string; totalAmount: number; invoiceCount: number }
    >();
    for (const inv of invoices) {
      const existing = customerMap.get(inv.customerId);
      if (existing) {
        existing.totalAmount += Number(inv.total);
        existing.invoiceCount += 1;
      } else {
        customerMap.set(inv.customerId, {
          customerId: inv.customerId,
          customerName: inv.customer.name,
          totalAmount: Number(inv.total),
          invoiceCount: 1,
        });
      }
    }
    const byCustomer = Array.from(customerMap.values()).sort(
      (a, b) => b.totalAmount - a.totalAmount,
    );

    // Group by month
    const monthMap = new Map<
      string,
      { month: string; totalAmount: number; invoiceCount: number }
    >();
    for (const inv of invoices) {
      const monthKey = new Date(inv.issueDate).toISOString().slice(0, 7); // YYYY-MM
      const existing = monthMap.get(monthKey);
      if (existing) {
        existing.totalAmount += Number(inv.total);
        existing.invoiceCount += 1;
      } else {
        monthMap.set(monthKey, {
          month: monthKey,
          totalAmount: Number(inv.total),
          invoiceCount: 1,
        });
      }
    }
    const byMonth = Array.from(monthMap.values());

    // Year over year comparison
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();
    const yearOverYear = [];

    for (let year = startYear; year <= endYear; year++) {
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31);

      const yearInvoices = await this.prisma.invoice.aggregate({
        where: {
          companyId,
          issueDate: { gte: yearStart, lte: yearEnd },
          status: { in: ['paid', 'sent', 'overdue'] },
        },
        _sum: { total: true },
        _count: true,
      });

      const totalAmount = Number(yearInvoices._sum.total || 0);

      // Calculate growth compared to previous year
      let growthPercent: number | null = null;
      if (year > startYear) {
        const prevYearInvoices = await this.prisma.invoice.aggregate({
          where: {
            companyId,
            issueDate: {
              gte: new Date(year - 1, 0, 1),
              lte: new Date(year - 1, 11, 31),
            },
            status: { in: ['paid', 'sent', 'overdue'] },
          },
          _sum: { total: true },
        });
        const prevTotal = Number(prevYearInvoices._sum.total || 0);
        if (prevTotal > 0) {
          growthPercent = ((totalAmount - prevTotal) / prevTotal) * 100;
        }
      }

      yearOverYear.push({ year, totalAmount, growthPercent });
    }

    return {
      totalSales,
      totalVat,
      byCustomer,
      byMonth,
      yearOverYear,
    };
  }

  async getVatReport(params: VatReportParams): Promise<VatReportResult> {
    const { companyId, year, quarter, month } = params;

    // Calculate date range
    let startDate: Date;
    let endDate: Date;

    if (month) {
      startDate = new Date(year, month - 1, 1);
      endDate = new Date(year, month, 0); // Last day of month
    } else if (quarter) {
      const startMonth = (quarter - 1) * 3;
      startDate = new Date(year, startMonth, 1);
      endDate = new Date(year, startMonth + 3, 0);
    } else {
      startDate = new Date(year, 0, 1);
      endDate = new Date(year, 11, 31);
    }

    // Get all invoices in date range
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: startDate, lte: endDate },
        status: { in: ['paid', 'sent', 'overdue', 'draft'] },
      },
      include: { items: true },
    });

    // Group by VAT rate
    const rateMap = new Map<
      number,
      { vatRate: number; netAmount: number; vatAmount: number; grossAmount: number; invoiceCount: number }
    >();

    for (const inv of invoices) {
      for (const item of inv.items) {
        const rate = Number(item.vatRate);
        const existing = rateMap.get(rate);
        if (existing) {
          existing.netAmount += Number(item.netAmount);
          existing.vatAmount += Number(item.vatAmount);
          existing.grossAmount += Number(item.grossAmount);
        } else {
          rateMap.set(rate, {
            vatRate: rate,
            netAmount: Number(item.netAmount),
            vatAmount: Number(item.vatAmount),
            grossAmount: Number(item.grossAmount),
            invoiceCount: 1,
          });
        }
      }
    }

    const byRate = Array.from(rateMap.values()).sort((a, b) => b.vatRate - a.vatRate);

    const totalNet = byRate.reduce((sum, r) => sum + r.netAmount, 0);
    const totalVat = byRate.reduce((sum, r) => sum + r.vatAmount, 0);
    const totalGross = byRate.reduce((sum, r) => sum + r.grossAmount, 0);

    return {
      byRate,
      totalNet,
      totalVat,
      totalGross,
    };
  }

  async getCustomerReport(params: CustomerReportParams): Promise<CustomerReportResult> {
    const { companyId, startDate, endDate } = params;

    // Get all invoices in date range
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: startDate, lte: endDate },
      },
      include: {
        customer: { select: { id: true, name: true } },
        payments: true,
      },
      orderBy: { issueDate: 'desc' },
    });

    // Group by customer
    const customerMap = new Map<
      string,
      {
        customerId: string;
        customerName: string;
        totalInvoices: number;
        totalAmount: number;
        paidAmount: number;
        pendingAmount: number;
        overdueAmount: number;
        lastInvoiceDate: string | null;
      }
    >();

    for (const inv of invoices) {
      const existing = customerMap.get(inv.customerId);
      const totalAmount = Number(inv.total);
      const paidAmount = inv.payments.reduce((sum, p) => sum + Number(p.amount), 0);

      if (existing) {
        existing.totalInvoices += 1;
        existing.totalAmount += totalAmount;
        existing.paidAmount += paidAmount;

        if (inv.status === 'paid') {
          existing.paidAmount += totalAmount - existing.paidAmount;
        } else if (inv.status === 'overdue') {
          existing.overdueAmount += totalAmount - paidAmount;
        } else {
          existing.pendingAmount += totalAmount - paidAmount;
        }
      } else {
        let pendingAmount = 0;
        let overdueAmount = 0;

        if (inv.status === 'paid') {
          pendingAmount = 0;
        } else if (inv.status === 'overdue') {
          overdueAmount = totalAmount - paidAmount;
        } else {
          pendingAmount = totalAmount - paidAmount;
        }

        customerMap.set(inv.customerId, {
          customerId: inv.customerId,
          customerName: inv.customer.name,
          totalInvoices: 1,
          totalAmount,
          paidAmount,
          pendingAmount,
          overdueAmount,
          lastInvoiceDate: inv.issueDate.toISOString(),
        });
      }
    }

    const customers = Array.from(customerMap.values()).sort(
      (a, b) => b.totalAmount - a.totalAmount,
    );

    const summary = {
      totalCustomers: customers.length,
      totalAmount: customers.reduce((sum, c) => sum + c.totalAmount, 0),
      totalPaid: customers.reduce((sum, c) => sum + c.paidAmount, 0),
      totalPending: customers.reduce((sum, c) => sum + c.pendingAmount, 0),
      totalOverdue: customers.reduce((sum, c) => sum + c.overdueAmount, 0),
    };

    return { customers, summary };
  }
}