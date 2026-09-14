import { Controller, Get, Post, Put, Delete, Body, Param, Query, BadRequestException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { KassenbuchService } from './kassenbuch.service';
import {
  UpdateCashBookEntryDto,
  CreateCashBookEntryDto,
  ReverseCashBookEntryDto,
  CloseCashBookDayDto,
  ReopenCashBookDayDto,
} from './dto/cashbook.dto';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('cashbook')
export class CashBookController {
  constructor(private readonly svc: KassenbuchService) {}

  // ========== Entries ==========

  @Get('entries')
  @Require('accounting.read')
  async list(
    @Query('companyId') companyId: string,
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.listEntries(companyId, {
      from: fromStr ? new Date(fromStr) : undefined,
      to: toStr ? new Date(toStr) : undefined,
      page: pageStr ? parseInt(pageStr, 10) : undefined,
      pageSize: pageSizeStr ? parseInt(pageSizeStr, 10) : undefined,
    });
  }

  @Get('balance')
  @Require('accounting.read')
  async balance(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.cashBalance(companyId);
  }

  @Get('day')
  @Require('accounting.read')
  async day(
    @Query('companyId') companyId: string,
    @Query('date') dateStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!dateStr) throw new BadRequestException('date is required');
    return this.svc.dayBalance(companyId, new Date(dateStr));
  }

  @Post('entries')
  @Require('accounting.create')
  async create(
    @Query('companyId') companyId: string,
    @Body() body: CreateCashBookEntryDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const { createdById, ...rest } = body;
    return this.svc.createEntry(companyId, createdById, {
      ...rest,
      businessDate: new Date(rest.businessDate),
    });
  }

  @Put('entries/:id')
  @Require('accounting.update')
  async update(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: UpdateCashBookEntryDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.updateEntry(companyId, id, body);
  }

  @Delete('entries/:id')
  @Require('accounting.delete')
  async remove(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.deleteEntry(companyId, id);
  }

  /**
   * Post a Storno (reversal) for an entry. The original
   * row stays in the book; a new entry with the same
   * amount is created so the balance nets to zero.
   * Required for correcting a closed day.
   */
  @Post('entries/:id/reverse')
  @Require('accounting.update')
  async reverse(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: ReverseCashBookEntryDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.reverseEntry(companyId, id, body.reason ?? '', body.createdById);
  }

  // ========== Tagesabschluss (Z-Bericht) ==========

  /**
   * Close a day. Captures the day's aggregates + a JSON
   * snapshot of every entry, so the close is auditable
   * even after later Storno entries.
   */
  @Post('close-day')
  @Require('accounting.update')
  async closeDay(
    @Query('companyId') companyId: string,
    @Body() body: CloseCashBookDayDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!body.date) throw new BadRequestException('date is required');
    if (typeof body.physicalCount !== 'number') {
      throw new BadRequestException('physicalCount is required (number)');
    }
    return this.svc.closeDay(companyId, new Date(body.date), body.physicalCount, body.closedById, body.differenzNote);
  }

  /**
   * Re-open a previously closed day by deleting the close
   * record. The entries themselves are not affected.
   * Logged explicitly because it touches the GoBD audit
   * chain.
   */
  @Post('reopen-day')
  @Require('accounting.update')
  async reopenDay(
    @Query('companyId') companyId: string,
    @Body() body: ReopenCashBookDayDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!body.date) throw new BadRequestException('date is required');
    return this.svc.reopenDay(companyId, new Date(body.date));
  }

  @Get('close')
  @Require('accounting.read')
  async getClose(
    @Query('companyId') companyId: string,
    @Query('date') dateStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!dateStr) throw new BadRequestException('date is required');
    return this.svc.getClose(companyId, new Date(dateStr));
  }

  @Get('closes')
  @Require('accounting.read')
  async listCloses(
    @Query('companyId') companyId: string,
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.listCloses(companyId, {
      from: fromStr ? new Date(fromStr) : undefined,
      to: toStr ? new Date(toStr) : undefined,
    });
  }

  // ========== Monthly summary ==========

  @Get('month')
  @Require('accounting.read')
  async month(
    @Query('companyId') companyId: string,
    @Query('year') yearStr: string,
    @Query('month') monthStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!yearStr || !monthStr) throw new BadRequestException('year and month are required');
    return this.svc.monthSummary(companyId, parseInt(yearStr, 10), parseInt(monthStr, 10));
  }

  /**
   * Export the Kassenbuch as a CSV file (German decimal
   * comma, semicolon separator, UTF-8 BOM so Excel
   * opens it correctly). Goes through @Res() because
   * we need to set the Content-Disposition inline rather
   * than letting Nest's default JSON serialiser handle
   * a string body.
   */
  @Get('export')
  @Require('accounting.read')
  async export(
    @Query('companyId') companyId: string,
    @Query('from') fromStr: string,
    @Query('to') toStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!fromStr || !toStr) throw new BadRequestException('from and to are required');
    const list = await this.svc.listEntries(companyId, {
      from: new Date(fromStr),
      to: new Date(toStr),
      pageSize: 100000,
    });
    const closes = await this.svc.listCloses(companyId, {
      from: new Date(fromStr),
      to: new Date(toStr),
    });
    const closeByDate = new Map(closes.map((c: any) => [c.businessDate.toISOString().split('T')[0], c]));

    const rows: string[][] = [
      ['Datum', 'Typ', 'Beschreibung', 'Gegenkonto', 'Beleg-Nr', 'Betrag EUR', 'MwSt %', 'Bemerkung', 'Z-Bericht'],
    ];
    for (const e of list.data) {
      const dateStr = e.businessDate.toISOString().split('T')[0];
      const close = closeByDate.get(dateStr);
      const amount = Number(e.amount).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const typeLabel = { einnahme: 'Einnahme', ausgabe: 'Ausgabe', umbuchung: 'Umbuchung', eroeffnung: 'Eröffnung' }[e.type] || e.type;
      rows.push([
        dateStr,
        typeLabel,
        e.description,
        e.counterparty || '',
        e.belegNumber || '',
        amount,
        e.vatRate ? `${(Number(e.vatRate) * 100).toFixed(0)}%` : '',
        e.notes || '',
        close ? `${close.endbestand} EUR (Differenz: ${close.differenz} EUR)` : 'offen',
      ]);
    }
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => /[",\n;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(';')).join('\r\n');
    const filename = `Kassenbuch_${fromStr}_${toStr}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(Buffer.from(csv, 'utf-8'));
  }

  // ========== Tier 194 — integrity signature ==========

  /**
   * (Re-)sign a Tagesabschluss. Re-derives the
   * integrity hash from the close row's current
   * state and writes it back. If the row has
   * been mutated after creation, the recomputed
   * hash diverges from the stored one and the
   * service throws a BadRequest — the operator
   * sees the mismatch and investigates.
   */
  @Post('close-day/:id/sign')
  @Require('accounting.update')
  async signClose(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!id) throw new BadRequestException('id is required');
    return this.svc.signClose(id, companyId);
  }

  /**
   * Verify a Tagesabschluss's stored hash matches
   * a re-derivation of the row state. Returns
   * {signed, verified, algorithm, storedHash,
   * recomputedHash, signatureTimestamp, verifiedAt}.
   * Never mutates the row.
   */
  @Get('close-day/:id/verify')
  @Require('accounting.read')
  async verifyClose(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!id) throw new BadRequestException('id is required');
    // The verify path needs the raw close row, not
    // the listCloses() shape. We add a service
    // helper rather than spinning up a fresh
    // PrismaClient here — the controller is a
    // request handler, not a data layer.
    return this.svc.verifyCloseById(id, companyId)
  }

  /**
   * Tier 194 — Kassenabschluss PDF (A4 portrait,
   * single page, German). Includes:
   *   - day summary (Anfangsbestand, Einnahmen,
   *     Ausgaben, Umbuchungen, Endbestand,
   *     Physical Count, Differenz)
   *   - all entry rows for the day
   *   - signature hash + algorithm
   *   - QR code with the hash (for Prüfer to
   *     scan-and-verify against the system)
   *   - signature timestamp + user who closed
   *
   * The PDF is plain text (no PKCS#7 signature
   * embedded) — the integrity check is done
   * out-of-band via the hash on the row. A future
   * tier could add eIDAS signing on top.
   */
  @Get('kassenabschluss.pdf')
  @Require('accounting.read')
  async kassenabschlussPdf(
    @Query('companyId') companyId: string,
    @Query('date') dateStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    if (!dateStr) throw new BadRequestException('date is required')
    const close = await this.svc.listCloses(companyId, {
      from: new Date(dateStr),
      to: new Date(dateStr),
    })
    if (close.length === 0) {
      throw new BadRequestException('Kein Tagesabschluss für dieses Datum gefunden')
    }
    const c = close[0]
    const verification = this.svc.verifyClose(c)
    const PDFDocument = (await import('pdfkit')).default
    const QRCode = (await import('qrcode')).default
    const company = await this.svc.getCompanyHeader(companyId)
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    res.setHeader('Content-Type', 'application/pdf')
    const dateSlug = dateStr.slice(0, 10)
    res.setHeader(
      'Content-Disposition',
      `inline; filename="Kassenabschluss-${dateSlug}.pdf"`,
    )
    doc.pipe(res)
    doc.fontSize(18).text('Kassenabschluss (Z-Bericht)', { align: 'center' })
    doc.moveDown(0.3)
    doc
      .fontSize(10)
      .fillColor('#666')
      .text(`Tag: ${dateSlug}`, { align: 'center' })
    if (company?.name) {
      doc.text(company.name, { align: 'center' })
    }
    if (company?.taxId) {
      doc.text(`Steuernummer: ${company.taxId}`, { align: 'center' })
    }
    doc.moveDown(0.8)
    doc.fillColor('#000')
    const fmtEUR = (n: any) =>
      Number(n).toLocaleString('de-DE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    const row = (label: string, value: string) => {
      doc.fontSize(11).text(label, { continued: true })
      doc.fontSize(11).text(value, { align: 'right' })
    }
    row('Anfangsbestand:', `${fmtEUR(c.anfangsbestand)} EUR`)
    row('Σ Einnahmen:', `+ ${fmtEUR(c.einnahmenSum)} EUR`)
    row('Σ Ausgaben:', `− ${fmtEUR(c.ausgabenSum)} EUR`)
    row('Σ Umbuchungen:', `${fmtEUR(c.umbuchungenSum)} EUR`)
    doc.moveDown(0.2)
    doc
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .strokeColor('#888')
      .stroke()
    doc.moveDown(0.2)
    doc.fontSize(12).text('Endbestand (rechnerisch):', { continued: true })
    doc.fontSize(12).text(`${fmtEUR(c.endbestand)} EUR`, { align: 'right' })
    row('Kassensturz (gezählt):', `${fmtEUR(c.physicalCount)} EUR`)
    const diff = Number(c.differenz)
    doc.fontSize(11).text('Differenz:', { continued: true })
    doc
      .fontSize(11)
      .fillColor(Math.abs(diff) > 0.001 ? '#b91c1c' : '#15803d')
      .text(
        `${diff > 0 ? '+' : ''}${fmtEUR(c.differenz)} EUR`,
        { align: 'right' },
      )
    doc.fillColor('#000')
    if (c.differenzNote) {
      doc.moveDown(0.3)
      doc.fontSize(9).fillColor('#444').text(`Differenzbegründung: ${c.differenzNote}`)
      doc.fillColor('#000')
    }
    doc.moveDown(0.6)
    doc.fontSize(13).text('Buchungen des Tages', { underline: true })
    doc.moveDown(0.3)
    const entries: any[] = (c.entriesSnapshot as any)?.entries ?? []
    if (entries.length === 0) {
      doc.fontSize(10).fillColor('#888').text('(keine Buchungen)')
      doc.fillColor('#000')
    } else {
      doc.fontSize(9)
      const colX = { type: 110, desc: 175, amount: 460 }
      doc.font('Helvetica-Bold')
      doc.text('Typ', colX.type, doc.y, { continued: true })
      doc.text('Beschreibung', colX.desc, doc.y, { continued: true })
      doc.text('Betrag', colX.amount, doc.y, { align: 'right' })
      doc.font('Helvetica')
      doc.moveDown(0.2)
      for (const e of entries) {
        const startY = doc.y
        const typeLabel =
          {
            einnahme: 'Einnahme',
            ausgabe: 'Ausgabe',
            umbuchung: 'Umbuchung',
            eroeffnung: 'Eröffnung',
          }[e.type as string] || e.type
        doc.text(typeLabel, colX.type, startY, { width: 60 })
        doc.text(String(e.description ?? ''), colX.desc, startY, { width: 280 })
        const sign = e.type === 'ausgabe' ? '−' : e.type === 'eroeffnung' ? '' : '+'
        doc.text(
          `${sign} ${fmtEUR(e.amount)} EUR`,
          colX.amount,
          startY,
          { align: 'right', width: 80 },
        )
        doc.moveDown(0.4)
      }
    }
    doc.moveDown(0.6)
    doc.fontSize(13).text('Integritäts-Signatur (Tier 194)', { underline: true })
    doc.moveDown(0.3)
    doc.fontSize(9)
    if (verification.signed) {
      doc.text(`Algorithmus: ${verification.algorithm ?? '—'}`)
      doc.text(`Hash: ${verification.storedHash ?? '—'}`)
      doc.text(
        `Signiert am: ${
          verification.signatureTimestamp
            ? new Date(verification.signatureTimestamp).toLocaleString('de-DE')
            : '—'
        }`,
      )
      doc.text(
        `Verifiziert: ${
          verification.verified
            ? 'OK — Hash stimmt mit dem gespeicherten Wert überein.'
            : 'FEHLGESCHLAGEN — Buchungen wurden seit dem letzten Signieren verändert!'
        }`,
      )
    } else {
      doc
        .fillColor('#b45309')
        .text('Dieser Tagesabschluss wurde noch nicht elektronisch signiert.')
      doc.fillColor('#000')
    }
    doc.moveDown(0.5)
    if (verification.signed && verification.storedHash) {
      try {
        const qrPayload = JSON.stringify({
          v: 1,
          alg: verification.algorithm,
          hash: verification.storedHash,
          companyId,
          businessDate: dateSlug,
        })
        const qrDataUrl = await QRCode.toDataURL(qrPayload, { margin: 1, width: 140 })
        const qrBuf = Buffer.from(
          qrDataUrl.replace(/^data:image\/png;base64,/, ''),
          'base64',
        )
        doc.image(qrBuf, 50, doc.y, { width: 90 })
        doc
          .fontSize(8)
          .fillColor('#666')
          .text('QR-Code für mobile Verifizierung', 150, doc.y + 25)
      } catch {
        // QR generation failure is non-fatal —
        // the text block above already carries
        // the hash.
      }
    }
    doc.moveDown(2)
    doc
      .fontSize(8)
      .fillColor('#666')
      .text(
        'Dieser Beleg dient als Tagesabschluss gemäß § 146 AO. Die elektronische Signatur ist eine Integritäts-Signatur (keine eIDAS-qualifizierte Signatur).',
        { align: 'center' },
      )
    doc.end()
  }
}
