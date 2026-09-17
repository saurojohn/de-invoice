import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { invoiceTaxBreakdown } from '../invoice/tax-breakdown';

/**
 * UStVA — Umsatzsteuervoranmeldung
 * German VAT advance return (§ 18 UStG)
 *
 * Structure follows the official UStVA form (Anlage UStVA 2026):
 * - Lines 20-23: Besteuerungsgrundlagen (taxable amounts) by VAT rate
 * - Lines 26-29: Steuerbefreiungen (exemptions: igL, etc.)
 * - Line 36: Reverse-charge (§ 13b UStG)
 * - Line 81: Differenzbetrag (final payable / refund)
 */
export interface UstvaData {
  companyId: string;
  year: number;
  quarter?: number;
  month?: number;
  periodLabel: string;

  // Lines 20-23: taxable sales by rate (Steuerpflichtige Umsätze)
  salesByRate: Array<{
    rate: number;
    label: string;       // "USt 19%", "USt 7%"
    net: number;         // Bemessungsgrundlage (Zeile 20-23)
    vat: number;         // Steuer (Zeile 20-23)
  }>;

  // Lines 26-29: tax-exempt sales (Steuerfreie Umsätze)
  igL: number;          // Zeile 41: innergemeinschaftliche Lieferungen
  export: number;       // Zeile 43: Ausfuhren (Drittland)
  otherExempt: number;  // Zeile 44: sonstige steuerfreie Umsätze

  // Line 36: reverse charge (§ 13b UStG)
  reverseCharge: number;  // igE (innergemeinschaftliche Erwerbe)

  // Line 50-66: input tax (Vorsteuer) by category
  vorsteuer: {
    from19: number;       // Zeile 56: Vorsteuer aus 19% Eingangsrechnungen
    from7: number;        // Zeile 57: Vorsteuer aus 7% Eingangsrechnungen
    fromIgE: number;      // Zeile 59: Vorsteuer aus igE
    fromReverseCharge: number;  // Zeile 60: §13b Steuerschuldnerschaft
    total: number;        // Summe Vorsteuer (Zeile 66)
  };

  // Line 81: final result
  umsatzsteuer: number;   // Summe Umsatzsteuer (lines 20-23 + 36)
  vorsteuerSum: number;   // Summe Vorsteuer
  differenzbetrag: number;// Verbleibender Betrag — Zahllast (positive) / Erstattung (negative)

  counts: {
    invoices: number;
    expenses: number;
  };
}

@Injectable()
export class UstvaService {
  constructor(private prisma: PrismaService) {}

  private getDateRange(year: number, quarter?: number, month?: number) {
    if (month) {
      return {
        start: new Date(year, month - 1, 1),
        end: new Date(year, month, 0, 23, 59, 59, 999),
      };
    }
    if (quarter) {
      const startMonth = (quarter - 1) * 3;
      return {
        start: new Date(year, startMonth, 1),
        end: new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
      };
    }
    return {
      start: new Date(year, 0, 1),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
    };
  }

  async compute(companyId: string, year: number, quarter?: number, month?: number): Promise<UstvaData> {
    if (!year || year < 2010 || year > 2100) throw new BadRequestException('Ungültiges Jahr');
    if (quarter !== undefined && (quarter < 1 || quarter > 4)) throw new BadRequestException('Quartal 1-4');
    if (month !== undefined && (month < 1 || month > 12)) throw new BadRequestException('Monat 1-12');

    const { start, end } = this.getDateRange(year, quarter, month);

    // ── OUTPUT SIDE ───────────────────────────────────────────────
    // Sales invoices (excl. cancelled, finalized only — draft is not part of Voranmeldung)
    const salesInvoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: start, lte: end },
        status: { in: ['paid', 'sent', 'overdue'] }, // finalized
        type: { in: ['INV', 'PI'] },                  // standard sales only; CN subtracts
      },
      // Tier 118.5: pull `subtotal` + `eurSubtotal` so we
      // can convert line-level amounts to EUR for the
      // Voranmeldung (the Finanzamt form is EUR-denominated).
      // For EUR invoices the factor is 1.0; for non-EUR
      // it's `eurSubtotal / subtotal` (or 1.0 if the
      // column is null on legacy rows).
      include: { items: true, customer: true },
    });

    const creditNotes = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: start, lte: end },
        status: { in: ['paid', 'sent', 'overdue'] },
        type: 'CN',
      },
      include: { items: true, customer: true },
    });

    // Sales by rate — output VAT
    const salesByRateMap = new Map<number, { net: number; vat: number; label: string }>();
    let igL = 0;
    let exportThirdCountry = 0;
    let otherExempt = 0;
    let invoiceCount = salesInvoices.length;

    const addToRate = (rate: number, net: number, vat: number) => {
      const existing = salesByRateMap.get(rate) || {
        net: 0,
        vat: 0,
        label: this.rateLabel(rate),
      };
      existing.net += net;
      existing.vat += vat;
      salesByRateMap.set(rate, existing);
    };

    // Tier 118.5: per-invoice EUR conversion factor.
    // The factor is 1.0 for EUR invoices, otherwise
    // `eurSubtotal / subtotal`. The factor is the same
    // for all line items in the same invoice (the
    // ECB rate is a single number, not per-line). We
    // apply it to each line's netAmount / vatAmount
    // before bucketing into the UStVA Kennziffern.
    const eurFactor = (inv: { subtotal: any; eurSubtotal: any }) => {
      if (inv.eurSubtotal == null) return 1
      const f = Number(inv.eurSubtotal) / Number(inv.subtotal)
      return isFinite(f) && f > 0 ? f : 1
    }

    for (const inv of salesInvoices) {
      const customerCountry = (inv.customer as any)?.country || '';
      const customerVatId = (inv.customer as any)?.vatId || '';
      const isGermanVatId = customerVatId.startsWith('DE');
      const f = eurFactor(inv)

      // Tier 409: per rate and after the invoice discount. The stored line
      // amounts are before it — a 1 000 € invoice with 10 % off was reported
      // as net 1 000 / VAT 190 instead of 900 / 171.
      for (const bucket of invoiceTaxBreakdown(inv).byRate) {
        const rate = bucket.rate;
        const net = bucket.net * f;
        const vat = bucket.vat * f;

        if (rate > 0) {
          addToRate(rate, net, vat);
        } else {
          // Zero-rated — determine category
          if (this.isIntraEU(customerCountry, customerVatId, isGermanVatId)) {
            igL += Math.abs(net);
          } else if (customerCountry && !this.isEUCountry(customerCountry)) {
            exportThirdCountry += Math.abs(net);
          } else {
            otherExempt += Math.abs(net);
          }
        }
      }
    }

    // Credit notes — subtract from sales (CN items have negative net/vat)
    for (const cn of creditNotes) {
      const f = eurFactor(cn)
      // Tier 409: same breakdown; a credit note's buckets are negative.
      for (const bucket of invoiceTaxBreakdown(cn).byRate) {
        const rate = bucket.rate;
        const net = bucket.net * f;
        const vat = bucket.vat * f;
        if (rate > 0) {
          addToRate(rate, net, vat); // CN is already negative
        }
      }
    }

    // ── INPUT SIDE ────────────────────────────────────────────────
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: start, lte: end },
        status: { in: ['booked', 'deductible'] },
      },
      include: { supplier: true },
    });

    let vorsteuer19 = 0;
    let vorsteuer7 = 0;
    let vorsteuerIgE = 0;
    let vorsteuerReverseCharge = 0;
    let reverseCharge = 0;
    let expenseCount = expenses.length;

    for (const exp of expenses) {
      const rate = Number(exp.vatRate);
      const net = Number(exp.netAmount);
      const vat = Number(exp.vatAmount);

      if (exp.isReverseCharge || exp.isIntraEU) {
        // igE / §13b — buyer is tax-debtor
        if (exp.isIntraEU) {
          reverseCharge += Math.abs(net);
          vorsteuerIgE += Math.abs(vat);
        } else {
          reverseCharge += Math.abs(net);
          vorsteuerReverseCharge += Math.abs(vat);
        }
      } else if (rate === 0.19) {
        vorsteuer19 += Math.abs(vat);
      } else if (rate === 0.07) {
        vorsteuer7 += Math.abs(vat);
      } else {
        // 0% (e.g. Kleinunternehmer supplier) — not deductible
      }
    }

    const vorsteuerTotal = vorsteuer19 + vorsteuer7 + vorsteuerIgE + vorsteuerReverseCharge;

    // ── TOTALS ────────────────────────────────────────────────────
    let salesVat = 0;
    for (const r of salesByRateMap.values()) salesVat += r.vat;
    salesVat = Math.round(salesVat * 100) / 100;

    // Lines 20-23 + Line 36 (§13b) = total Umsatzsteuer
    const umsatzsteuer =
      Math.round((salesVat + (reverseCharge > 0 ? (reverseCharge * 0.19) : 0)) * 100) / 100;
    // Note: in real UStVA, §13b amount goes to line 36 with explicit rate
    // Here we apply 19% as the most common rate — refine with `exp.vatRate` when known

    const periodLabel = month
      ? `${year}-${String(month).padStart(2, '0')}`
      : quarter
        ? `${year} Q${quarter}`
        : `${year}`;

    return {
      companyId,
      year,
      quarter,
      month,
      periodLabel,
      salesByRate: Array.from(salesByRateMap.entries())
        .map(([rate, v]) => ({
          rate,
          label: v.label,
          net: Math.round(v.net * 100) / 100,
          vat: Math.round(v.vat * 100) / 100,
        }))
        .sort((a, b) => b.rate - a.rate),
      igL: Math.round(igL * 100) / 100,
      export: Math.round(exportThirdCountry * 100) / 100,
      otherExempt: Math.round(otherExempt * 100) / 100,
      reverseCharge: Math.round(reverseCharge * 100) / 100,
      vorsteuer: {
        from19: Math.round(vorsteuer19 * 100) / 100,
        from7: Math.round(vorsteuer7 * 100) / 100,
        fromIgE: Math.round(vorsteuerIgE * 100) / 100,
        fromReverseCharge: Math.round(vorsteuerReverseCharge * 100) / 100,
        total: Math.round(vorsteuerTotal * 100) / 100,
      },
      umsatzsteuer,
      vorsteuerSum: vorsteuerTotal,
      differenzbetrag: Math.round((umsatzsteuer - vorsteuerTotal) * 100) / 100,
      counts: {
        invoices: invoiceCount,
        expenses: expenseCount,
      },
    };
  }

  /**
   * Tier 177: render the UStVA as a PDF (A4 portrait).
   *
   * Phase 3 Berater-Walkthrough found that USER-GUIDE
   * Pfad 4.2 promised a "UStVA-PDF" download but no
   * such endpoint existed — the only UStVA export
   * was the ELSTER-XML via /ustva/filings/:id/elster-xml.
   * This tier closes that gap.
   *
   * The PDF is a single-page Berater-readable summary,
   * not a substitute for the ELSTER submission XML
   * (which is what the Finanzamt actually receives).
   * Layout matches the BWA PDF style (header + table
   * + summary) so the Berater has a consistent
   * look-and-feel across reports.
   */
  async renderPdf(
    companyId: string,
    year: number,
    month: number,
    res: Response,
  ): Promise<void> {
    const data = await this.compute(companyId, year, undefined, month)
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, legalName: true, taxId: true, vatId: true },
    })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="UStVA-${year}-${String(month).padStart(2, '0')}.pdf"`,
    )

    const PDFDocument = (await import('pdfkit')).default
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 50 })
    doc.pipe(res)

    // Header
    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .text('Umsatzsteuer-Voranmeldung', { align: 'left' })
    doc
      .fontSize(9)
      .font('Helvetica')
      .text(
        `${company?.legalName || company?.name || 'Unternehmen'}  |  ${data.periodLabel}  |  Steuernummer: ${company?.taxId || '—'}`,
      )
    doc.moveDown(0.5)

    // Section 1: Bemessungsgrundlagen (sales by VAT rate)
    doc.fontSize(11).font('Helvetica-Bold').text('1. Bemessungsgrundlagen')
    doc.moveDown(0.2)
    doc.fontSize(9).font('Helvetica-Bold')
    const headerY = doc.y
    doc.text('USt-Satz', 50, headerY, { width: 100 })
    doc.text('Bezeichnung', 150, headerY, { width: 200 })
    doc.text('Netto', 380, headerY, { width: 90, align: 'right' })
    doc.text('USt', 480, headerY, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    doc.moveTo(50, doc.y).lineTo(570, doc.y).stroke()

    doc.font('Helvetica')
    if (data.salesByRate.length === 0) {
      doc.text('Keine Umsätze im Zeitraum.', 50, doc.y + 4, { width: 500 })
      doc.moveDown(0.6)
    } else {
      for (const s of data.salesByRate) {
        const y = doc.y
        doc.text(`${(s.rate * 100).toFixed(0)}%`, 50, y, { width: 100 })
        doc.text(s.label, 150, y, { width: 220 })
        doc.text(this.fmtEur(s.net), 380, y, { width: 90, align: 'right' })
        doc.text(this.fmtEur(s.vat), 480, y, { width: 90, align: 'right' })
        doc.moveDown(0.3)
      }
    }

    // Section 2: Sonderfälle
    doc.moveDown(0.4)
    doc.fontSize(11).font('Helvetica-Bold').text('2. Sonderfälle')
    doc.moveDown(0.2)
    doc.fontSize(9).font('Helvetica')
    const sY = doc.y
    doc.text('igL (§1a UStG)', 50, sY, { width: 250 })
    doc.text(this.fmtEur(data.igL), 380, sY, { width: 90, align: 'right' })
    doc.text('—', 480, sY, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    const sY2 = doc.y
    doc.text('Ausfuhr (§4 Nr. 1a UStG)', 50, sY2, { width: 250 })
    doc.text(this.fmtEur(data.export), 380, sY2, { width: 90, align: 'right' })
    doc.text('—', 480, sY2, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    const sY3 = doc.y
    doc.text('Sonstige steuerfreie Umsätze', 50, sY3, { width: 250 })
    doc.text(this.fmtEur(data.otherExempt), 380, sY3, { width: 90, align: 'right' })
    doc.text('—', 480, sY3, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    const sY4 = doc.y
    doc.text('Reverse-Charge (§13b UStG) — BMG', 50, sY4, { width: 250 })
    doc.text(this.fmtEur(data.reverseCharge), 380, sY4, { width: 90, align: 'right' })
    doc.text('—', 480, sY4, { width: 90, align: 'right' })

    // Section 3: Vorsteuer (input tax deduction)
    doc.moveDown(0.5)
    doc.fontSize(11).font('Helvetica-Bold').text('3. Abziehbare Vorsteuer')
    doc.moveDown(0.2)
    doc.fontSize(9).font('Helvetica')
    const vY = doc.y
    doc.text('aus 19% Eingangsleistungen', 50, vY, { width: 350 })
    doc.text(this.fmtEur(data.vorsteuer.from19), 480, vY, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    const vY2 = doc.y
    doc.text('aus 7% Eingangsleistungen', 50, vY2, { width: 350 })
    doc.text(this.fmtEur(data.vorsteuer.from7), 480, vY2, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    const vY3 = doc.y
    doc.text('aus igL (§1a Abs. 4 UStG)', 50, vY3, { width: 350 })
    doc.text(this.fmtEur(data.vorsteuer.fromIgE), 480, vY3, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    const vY4 = doc.y
    doc.text('aus Reverse-Charge (§13b UStG)', 50, vY4, { width: 350 })
    doc.text(this.fmtEur(data.vorsteuer.fromReverseCharge), 480, vY4, { width: 90, align: 'right' })
    doc.moveDown(0.3)
    doc.moveTo(50, doc.y).lineTo(570, doc.y).stroke()
    doc.moveDown(0.2)
    const vTotalY = doc.y
    doc.font('Helvetica-Bold').text('Summe Vorsteuer', 50, vTotalY, { width: 350 })
    doc.text(this.fmtEur(data.vorsteuer.total), 480, vTotalY, { width: 90, align: 'right' })

    // Section 4: Zahllast
    doc.moveDown(0.6)
    doc.moveTo(50, doc.y).lineTo(570, doc.y).stroke()
    doc.moveDown(0.3)
    doc.fontSize(12).font('Helvetica-Bold')
    const zY = doc.y
    doc.text('Umsatzsteuer (Zeile 1 + Sonderfälle):', 50, zY, { width: 350 })
    doc.text(this.fmtEur(data.umsatzsteuer), 380, zY, { width: 90, align: 'right' })
    doc.moveDown(0.4)
    const zY2 = doc.y
    doc.text('abzüglich Vorsteuer:', 50, zY2, { width: 350 })
    doc.text(this.fmtEur(-data.vorsteuerSum), 380, zY2, { width: 90, align: 'right' })
    doc.moveDown(0.4)
    doc.moveTo(50, doc.y).lineTo(570, doc.y).stroke()
    doc.moveDown(0.3)
    doc.fontSize(14)
    const zY3 = doc.y
    doc.text('Zahllast / Erstattungsüberschuss:', 50, zY3, { width: 350 })
    const differenzSign = data.differenzbetrag >= 0 ? '+' : '−'
    doc.text(
      `${differenzSign} ${this.fmtEur(Math.abs(data.differenzbetrag))}`,
      380,
      zY3,
      { width: 90, align: 'right' },
    )

    // Footer: count + GoBD note
    doc.moveDown(1.5)
    doc.font('Helvetica').fontSize(8)
    doc.text(
      `Basiert auf ${data.counts.invoices} Rechnungen + ${data.counts.expenses} Belegen.`,
    )
    doc.text(
      'GoBD § 146 Abs. 1 AO: Dieser Ausdruck ist ein internes Berater-Dokument und ersetzt nicht die ELSTER-Übermittlung.',
    )

    doc.end()
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
    }).format(n)
  }

  private isEUCountry(country: string): boolean {
    const eu = [
      'DE', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'GR',
      'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
      'SI', 'ES', 'SE',
    ];
    return eu.includes(country.toUpperCase());
  }

  private isIntraEU(country: string, vatId: string, isGermanVatId: boolean): boolean {
    if (isGermanVatId) return false; // domestic sale
    if (!country) return false;
    return this.isEUCountry(country) && !!vatId; // EU + valid VAT ID
  }

  private rateLabel(rate: number): string {
    if (rate === 0.19) return 'USt 19%';
    if (rate === 0.07) return 'USt 7%';
    if (rate === 0.05) return 'USt 5%'; // some food items
    return `USt ${(rate * 100).toFixed(0)}%`;
  }

  /**
   * Tier 161: Monatsvergleich USt-Voranmeldung.
   *
   * Returns the last `months` months of UStVA aggregates
   * (one row per calendar month) for the dashboard widget.
   * Each row contains the 19% / 7% taxable amounts, the
   * output VAT for each rate, and the Zahllast (= umsatzsteuer
   * − vorsteuerSum, i.e. the differenzbetrag).
   *
   * Sorted by (year DESC, month DESC) so the most recent
   * month is first — the dashboard renders the table
   * top-down and the operator wants to see "the current
   * month" at the top.
   *
   * Implementation: serial loop calling compute() per
   * month. The compute() call is already rate-limited
   * (60/min on the GET endpoint). For 6 months the
   * total latency is ~6× a single compute (~1-2 s) which
   * is fine for a dashboard widget. If we ever need to
   * speed this up we can build a single query that
   * groups by month directly, but the abstraction of
   * "same logic as a single-month compute" is worth the
   * latency for now.
   */
  async computeHistory(companyId: string, months: number = 6): Promise<Array<{
    year: number
    month: number
    periodLabel: string
    taxableAmount19: number
    taxableAmount7: number
    vat19: number
    vat7: number
    zahllast: number
    invoiceCount: number
    expenseCount: number
  }>> {
    if (months < 1 || months > 24) throw new BadRequestException('months 1-24')

    const now = new Date()
    const rows: Array<{
      year: number
      month: number
      periodLabel: string
      taxableAmount19: number
      taxableAmount7: number
      vat19: number
      vat7: number
      zahllast: number
      invoiceCount: number
      expenseCount: number
    }> = []

    for (let i = 0; i < months; i++) {
      // Walk backwards from the current month.
      // Use Date math instead of mutating `now` to avoid
      // rolling the anchor forward on each iteration
      // (e.g. on Feb 28 / 30 / 31 edge cases).
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const y = d.getFullYear()
      const m = d.getMonth() + 1

      const data = await this.compute(companyId, y, undefined, m)

      const rate19 = data.salesByRate.find((r) => Math.abs(r.rate - 0.19) < 1e-6)
      const rate7 = data.salesByRate.find((r) => Math.abs(r.rate - 0.07) < 1e-6)

      rows.push({
        year: y,
        month: m,
        periodLabel: data.periodLabel,
        taxableAmount19: rate19?.net ?? 0,
        taxableAmount7: rate7?.net ?? 0,
        vat19: rate19?.vat ?? 0,
        vat7: rate7?.vat ?? 0,
        zahllast: data.differenzbetrag,
        invoiceCount: data.counts.invoices,
        expenseCount: data.counts.expenses,
      })
    }

    // Already DESC from the loop, but be defensive
    // against caller assumptions — sort by (year DESC,
    // month DESC) so future refactors that change the
    // loop direction don't break the response shape.
    return rows.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year
      return b.month - a.month
    })
  }

  async saveFiling(companyId: string, data: UstvaData & { taxNumber?: string; notes?: string; status?: 'draft' | 'submitted' }) {
    const quarter = data.quarter ?? null;
    const month = data.month ?? null;

    const existing = await this.prisma.uStvaFiling.findFirst({
      where: { companyId, year: data.year, quarter, month },
    });

    const payload = {
      outputVat: data.umsatzsteuer,
      inputVat: data.vorsteuerSum,
      payableVat: data.differenzbetrag,
      intraEUSales: data.igL,
      intraEUPurchase: data.reverseCharge,
      taxNumber: data.taxNumber,
      notes: data.notes,
      status: data.status ?? 'draft',
      submittedAt: data.status === 'submitted' ? new Date() : null,
    };

    if (existing) {
      return this.prisma.uStvaFiling.update({ where: { id: existing.id }, data: payload });
    }

    return this.prisma.uStvaFiling.create({
      data: {
        companyId,
        year: data.year,
        quarter,
        month,
        periodLabel: data.periodLabel,
        ...payload,
      },
    });
  }

  async listFilings(companyId: string) {
    return this.prisma.uStvaFiling.findMany({
      where: { companyId },
      orderBy: [{ year: 'desc' }, { quarter: 'asc' }, { month: 'asc' }],
    });
  }

  async getFiling(companyId: string, filingId: string) {
    return this.prisma.uStvaFiling.findFirst({ where: { id: filingId, companyId } });
  }

  async listExpenses(companyId: string, year?: number, quarter?: number, month?: number) {
    const where: Prisma.ExpenseWhereInput = { companyId };
    if (year) {
      const { start, end } = this.getDateRange(year, quarter, month);
      where.invoiceDate = { gte: start, lte: end };
    }
    return this.prisma.expense.findMany({
      where,
      include: { supplier: true },
      orderBy: { invoiceDate: 'desc' },
    });
  }

  async createExpense(companyId: string, data: {
    supplierId?: string;
    invoiceNumber?: string;
    description: string;
    invoiceDate: Date;
    netAmount: number;
    vatRate: number;
    vatAmount: number;
    grossAmount: number;
    category?: string;
    isIntraEU?: boolean;
    isReverseCharge?: boolean;
    notes?: string;
  }) {
    // Tier 390: the supplier must be this company's — the same check
    // ExpenseService.create makes. Measured: company B's expense with company
    // A's supplierId → 201, and the response (and B's expense list) carried A's
    // supplier record. The UStVA page's empty select sends "" — that was a
    // foreign-key 500; it means "no supplier".
    const supplierId = data.supplierId?.trim() || null;
    if (supplierId) {
      const sup = await this.prisma.supplier.findFirst({ where: { id: supplierId, companyId } });
      if (!sup) throw new BadRequestException('Lieferant nicht gefunden');
    }
    return this.prisma.expense.create({
      data: {
        companyId,
        supplierId,
        invoiceNumber: data.invoiceNumber,
        description: data.description,
        invoiceDate: data.invoiceDate,
        netAmount: data.netAmount,
        vatRate: data.vatRate,
        vatAmount: data.vatAmount,
        grossAmount: data.grossAmount,
        category: data.category,
        isIntraEU: data.isIntraEU ?? false,
        isReverseCharge: data.isReverseCharge ?? false,
        notes: data.notes,
      },
      include: { supplier: true },
    });
  }

  async deleteExpense(companyId: string, expenseId: string) {
    const exp = await this.prisma.expense.findFirst({ where: { id: expenseId, companyId } });
    if (!exp) throw new BadRequestException('Ausgabe nicht gefunden');
    await this.prisma.expense.delete({ where: { id: expenseId } });
  }
}
