/**
 * Tier 573 — an incoming e-invoice becomes an expense.
 *
 * Before this tier an `.xml` upload was refused ("Dateityp nicht erlaubt") and
 * a ZUGFeRD PDF went through OCR like a scan — the structured invoice inside
 * it was ignored. Receiving e-invoices is mandatory since 01.01.2025
 * (§ 27 Abs. 38 UStG), and the structured part is the original that has to be
 * kept unchanged (GoBD; BMF 15.10.2024 Rz. 60 ff.).
 *
 * What an import does:
 *   - reads the XML (alone, or the one embedded in the PDF);
 *   - finds the supplier by VAT ID, then by name — or creates it;
 *   - creates the expense — one, with a VAT line per rate (Tier 581) — through
 *     ExpenseService.create, so every rule of a hand-entered expense holds
 *     (amounts add up, no future date, filed period closed, no duplicate);
 *   - stores the received file, byte for byte, as the expense's attachment.
 *
 * What it deliberately does not do: change an existing supplier's bank
 * details. An invoice with a different IBAN is the classic payment fraud —
 * that is reported, never applied.
 */
import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import * as crypto from 'crypto'
import { PrismaService } from '../../../prisma/prisma.service'
import { withKeyLock } from '../../../common/key-lock'
import { KoSITResult, KoSITValidatorUnavailableError, validateXRechnungWithKoSIT } from '../../../invoices/kosIT-validator.service'
import { assertNotFuture } from '../../../common/business-date'
import { assertPeriodOpen } from '../../reports/filed-period'
import { ibanProblem } from '../../../common/iban'
import { normalizeVatId, vatIdFormatProblem } from '../../../common/vat-id'
import { AttachmentsService } from '../../attachment/attachments.service'
import { SupplierService } from '../../supplier/supplier.service'
import { ExpenseService } from '../expense.service'
import { expenseAmountsError } from '../amounts'
import { findDuplicateExpense, duplicateExpenseMessage, duplicateExpenseConflict } from '../expense-duplicate'
import { EInvoiceFormatError, EInvoiceLine, ParsedEInvoice, parseEInvoiceXml } from './e-invoice-parser'
import { embeddedXmlFiles } from './pdf-embedded-xml'
import { XmlReadError, decodeXml } from './xml-reader'

export interface ReadEInvoice {
  /** the file is an XML invoice, or a PDF that carries one */
  source: 'xml' | 'pdf'
  /** name of the XML inside the PDF */
  embeddedFile: string | null
  invoice: ParsedEInvoice
}

/** An expense the import would create — one per invoice, with its VAT lines (Tier 581). */
export interface PlannedExpense {
  description: string
  netAmount: number
  vatAmount: number
  grossAmount: number
  /** as a fraction: 0.19 */
  vatRate: number
  taxCategory: string
  isReverseCharge: boolean
  isIntraEU: boolean
  /** Tier 581: the VAT lines, when the invoice has more than one rate */
  taxLines?: { vatRate: number; netAmount: number; vatAmount: number }[]
}

/**
 * Tier 738 — the official check of a received e-invoice against EN 16931
 * (KoSIT validator, scenarios-en16931.xml: schema and the CEN schematron).
 * `checked: false` where the validator is not installed.
 */
export interface En16931Check {
  checked: boolean
  valid: boolean | null
  acceptance: string | null
  errors: { rule?: string; message: string }[]
  warningCount: number
  /** when it was checked (ISO) */
  at: string
}

export interface ImportOptions {
  supplierId?: string
  confirmDuplicate?: boolean
  confirmRecipient?: boolean
  /** 1 EUR = x units of the invoice currency (as the ECB and the BMF quote it) */
  exchangeRate?: number
  paidAt?: string
  category?: string
  accountNumber?: string
}

const isPdf = (b: Buffer) => b.length > 4 && b.subarray(0, 5).toString('latin1') === '%PDF-'
/** markup from the first character on — after a byte order mark, in UTF-8 or UTF-16 */
const looksLikeXml = (b: Buffer) =>
  /^\s*</.test(b.subarray(0, 64).toString('latin1').replace(/^(\xEF\xBB\xBF|\xFF\xFE|\xFE\xFF)/, '').replace(/\0/g, ''))
const round2 = (n: number) => Math.round(n * 100) / 100
const eur = (n: number) => n.toFixed(2).replace('.', ',')
/** Tier 738: how long the EN 16931 verdict of a file is reused */
const CHECK_TTL_MS = 10 * 60_000
const squash = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '')

@Injectable()
export class EInvoiceImportService {
  private readonly logger = new Logger(EInvoiceImportService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly expenses: ExpenseService,
    private readonly suppliers: SupplierService,
    private readonly attachments: AttachmentsService,
  ) {}

  /**
   * The e-invoice in an uploaded file. `null` when the file is a PDF without
   * one (an ordinary PDF — the caller sends it to OCR). A file that claims to
   * be an invoice and is not readable is a 400.
   */
  async read(buffer: Buffer): Promise<ReadEInvoice | null> {
    if (isPdf(buffer)) {
      const files = await embeddedXmlFiles(buffer)
      let firstProblem: string | null = null
      for (const f of files) {
        try {
          return { source: 'pdf', embeddedFile: f.filename, invoice: parseEInvoiceXml(decodeXml(f.content)) }
        } catch (e) {
          if (!(e instanceof EInvoiceFormatError) && !(e instanceof XmlReadError)) throw e
          firstProblem = firstProblem ?? e.message
        }
      }
      // An attachment named like an invoice that cannot be read is worth saying;
      // any other embedded XML is just not an invoice.
      if (firstProblem && files.some((f) => /^(factur-x|xrechnung|zugferd-invoice)\.xml$/i.test(f.filename))) {
        throw new BadRequestException(`Die in der PDF eingebettete E-Rechnung ist nicht lesbar: ${firstProblem}`)
      }
      return null
    }
    if (!looksLikeXml(buffer)) {
      throw new BadRequestException('Die Datei ist weder eine XML-Datei noch eine PDF-Datei.')
    }
    try {
      return { source: 'xml', embeddedFile: null, invoice: parseEInvoiceXml(decodeXml(buffer)) }
    } catch (e) {
      if (e instanceof EInvoiceFormatError || e instanceof XmlReadError) throw new BadRequestException(e.message)
      throw e
    }
  }

  /** The XML of a read e-invoice: the file itself, or the one inside the PDF. */
  async xmlOf(buffer: Buffer, read: ReadEInvoice): Promise<string> {
    if (read.source === 'xml') return decodeXml(buffer)
    const embedded = (await embeddedXmlFiles(buffer)).find((f) => f.filename === read.embeddedFile)
    if (!embedded) throw new BadRequestException('Die in der PDF eingebettete E-Rechnung ist nicht mehr auffindbar.')
    return decodeXml(embedded.content)
  }

  /**
   * Tier 738 — is the received invoice an EN 16931 invoice? It was a button:
   * an invoice that broke the rules was booked without anyone seeing it.
   *
   * The validator is a Java process of several seconds (more on a small
   * server), so the preview does not wait for it: the dialog asks for it
   * beside the preview (POST e-invoice/validate → `runEn16931`), and the
   * import uses that verdict or runs the check itself (`checkEn16931`).
   * One run at a time; a file's verdict is kept ten minutes.
   */
  async runEn16931(buffer: Buffer, read: ReadEInvoice): Promise<{ check: En16931Check; raw: KoSITResult | null }> {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    const xml = await this.xmlOf(buffer, read)
    const run = this.checkQueue.then(async (): Promise<{ check: En16931Check; raw: KoSITResult | null }> => {
      try {
        const raw = await validateXRechnungWithKoSIT(xml, { scenarios: 'en16931', timeoutMs: 60_000 })
        return {
          raw,
          check: {
            checked: true,
            valid: raw.valid,
            acceptance: raw.acceptance,
            errors: raw.errors.slice(0, 50).map((e) => ({ rule: e.rule, message: e.message })),
            warningCount: raw.warnings.length,
            at: new Date().toISOString(),
          },
        }
      } catch (e) {
        if (!(e instanceof KoSITValidatorUnavailableError)) this.logger.warn(`EN 16931 check failed: ${(e as Error)?.message}`)
        return { raw: null, check: { checked: false, valid: null, acceptance: null, errors: [], warningCount: 0, at: new Date().toISOString() } }
      }
    })
    this.checkQueue = run.then(() => undefined, () => undefined)
    const result = await run
    if (result.check.checked) {
      this.checks.set(hash, { time: Date.now(), result: result.check })
      if (this.checks.size > 200) this.checks.delete(this.checks.keys().next().value as string)
    }
    return result
  }

  /** The verdict of this file from the last ten minutes, or null. */
  cachedEn16931(contentHash: string): En16931Check | null {
    const now = Date.now()
    for (const [k, v] of this.checks) if (now - v.time > CHECK_TTL_MS) this.checks.delete(k)
    return this.checks.get(contentHash)?.result ?? null
  }

  /** The verdict — kept, or checked now. */
  async checkEn16931(buffer: Buffer, read: ReadEInvoice, contentHash: string): Promise<En16931Check> {
    return this.cachedEn16931(contentHash) ?? (await this.runEn16931(buffer, read)).check
  }

  private checks = new Map<string, { time: number; result: En16931Check }>()
  private checkQueue: Promise<void> = Promise.resolve()

  /** What the import would do — nothing is written. */
  async preview(companyId: string, buffer: Buffer, opts: ImportOptions = {}) {
    const read = await this.read(buffer)
    if (!read) return { eInvoice: false as const }
    const plan = await this.plan(companyId, buffer, read, opts)
    return { eInvoice: true as const, source: read.source, embeddedFile: read.embeddedFile, invoice: read.invoice, ...plan }
  }

  /** Everything decided about an import, shared by preview and import. */
  private async plan(companyId: string, buffer: Buffer, read: ReadEInvoice, opts: ImportOptions, checkNow = false) {
    const inv = read.invoice
    const blocking = [...inv.errors]
    const warnings = [...inv.warnings]
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true, vatId: true } })
    if (!company) throw new NotFoundException('Firma nicht gefunden')

    // Whose invoice is it?
    const ownVat = normalizeVatId(company.vatId)
    const ownInvoice = !!ownVat && inv.seller.vatId === ownVat
    if (ownInvoice) {
      blocking.push('Der Rechnungssteller ist Ihre eigene Firma — das ist eine Ausgangsrechnung, keine Eingangsrechnung.')
    }
    let buyerMatches: boolean | null = null
    if (ownVat && inv.buyer.vatId) buyerMatches = inv.buyer.vatId === ownVat
    else if (inv.buyer.name && company.name) {
      const a = squash(inv.buyer.name)
      const b = squash(company.name)
      buyerMatches = !!a && !!b && (a.includes(b) || b.includes(a))
    }
    if (buyerMatches === false && !ownInvoice) {
      warnings.push(`Die Rechnung ist an „${inv.buyer.name ?? inv.buyer.vatId ?? '?'}“ gerichtet, nicht an ${company.name}.`)
    }

    // Currency: the books are in euro.
    let rate = 1
    const foreign = !!inv.currency && inv.currency !== 'EUR'
    if (foreign) {
      const given = Number(opts.exchangeRate)
      if (opts.exchangeRate !== undefined && Number.isFinite(given) && given > 0 && given < 1e6) {
        rate = given
        warnings.push(`Beträge in ${inv.currency}, umgerechnet mit 1 EUR = ${String(given).replace('.', ',')} ${inv.currency}.`)
      } else {
        blocking.push(`Die Rechnung lautet auf ${inv.currency}. Bitte den Umrechnungskurs angeben (1 EUR = … ${inv.currency}; § 16 Abs. 6 UStG).`)
      }
    }
    const toEur = (n: number) => round2(n / rate)

    // Supplier: the one chosen, else by VAT ID, else by name.
    let supplier: { id: string; name: string; bankInfo: unknown } | null = null
    let matchedBy: 'chosen' | 'vatId' | 'name' | null = null
    if (opts.supplierId) {
      supplier = await this.prisma.supplier.findFirst({ where: { id: opts.supplierId, companyId }, select: { id: true, name: true, bankInfo: true } })
      if (!supplier) throw new BadRequestException('Lieferant nicht gefunden')
      matchedBy = 'chosen'
    }
    if (!supplier && inv.seller.vatId) {
      const candidates = await this.prisma.supplier.findMany({
        where: { companyId, vatId: { not: null } },
        select: { id: true, name: true, bankInfo: true, vatId: true },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      })
      supplier = candidates.find((s) => normalizeVatId(s.vatId) === inv.seller.vatId) ?? null
      if (supplier) matchedBy = 'vatId'
    }
    if (!supplier) {
      for (const name of [inv.seller.name, inv.seller.tradingName]) {
        if (!name) continue
        supplier = await this.prisma.supplier.findFirst({
          where: { companyId, name: { equals: name, mode: 'insensitive' } },
          select: { id: true, name: true, bankInfo: true },
          orderBy: { createdAt: 'asc' },
        })
        if (supplier) {
          matchedBy = 'name'
          break
        }
      }
    }
    const knownIban = ((supplier?.bankInfo as { iban?: string } | null)?.iban || '').toUpperCase().replace(/\s+/g, '')
    const ibanDiffers = !!supplier && !!inv.payment.iban && !!knownIban && knownIban !== inv.payment.iban
    if (ibanDiffers) {
      warnings.unshift(
        `Achtung: Die Rechnung nennt die IBAN ${inv.payment.iban}, beim Lieferanten ${supplier!.name} ist ${knownIban} hinterlegt. ` +
          'Die hinterlegte Bankverbindung wird nicht geändert — eine geänderte IBAN bitte beim Lieferanten auf bekanntem Weg bestätigen lassen.',
      )
    }
    if (inv.payment.iban && ibanProblem(inv.payment.iban)) {
      warnings.push(`Die IBAN ${inv.payment.iban} in der Rechnung ist ungültig (Prüfziffer).`)
    }

    // Has it been imported or entered before?
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
    let duplicate: { expenseId: string; reason: 'file' | 'number'; message: string } | null = null
    const sameFile = await this.prisma.attachment.findFirst({
      where: { companyId, entityType: 'expense', contentHash, deletedAt: null },
      select: { entityId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    // Tier 738: the EN 16931 verdict — the preview takes a kept one (null
    // until the dialog's check has run), the import checks if there is none.
    // Shown by the dialog with the rules it names, written into the note.
    const en16931 = checkNow ? await this.checkEn16931(buffer, read, contentHash) : this.cachedEn16931(contentHash)
    if (sameFile && (await this.prisma.expense.findFirst({ where: { id: sameFile.entityId, companyId }, select: { id: true } }))) {
      duplicate = {
        expenseId: sameFile.entityId,
        reason: 'file',
        message: `Genau diese Datei wurde am ${sameFile.createdAt.toLocaleDateString('de-DE')} bereits eingelesen.`,
      }
    } else if (supplier) {
      const dup = await findDuplicateExpense(this.prisma, companyId, supplier.id, inv.number, inv.creditNote)
      if (dup) duplicate = { expenseId: dup.id, reason: 'number', message: duplicateExpenseMessage(dup) }
    }

    // Tier 581: ONE expense, with a VAT line per rate. (Until then: one
    // expense per rate.) Only what the recipient owes the tax for himself is
    // an expense of its own — § 13b (AE) and the intra-community acquisition
    // (K) are flags of the whole expense, and their invoice shows no tax.
    const planned: PlannedExpense[] = []
    const kinds = new Map<'normal' | 'AE' | 'K', Map<number, { net: number; vat: number }>>()
    for (const g of inv.taxGroups) {
      const kind = g.category === 'AE' || g.category === 'K' ? g.category : 'normal'
      const taxed = g.category === 'S' || g.category === 'L' || g.category === 'M'
      const rate = taxed ? g.rate : 0
      const rates = kinds.get(kind) ?? new Map<number, { net: number; vat: number }>()
      const m = rates.get(rate) ?? { net: 0, vat: 0 }
      m.net += g.taxableAmount
      m.vat += taxed ? g.taxAmount : 0
      rates.set(rate, m)
      kinds.set(kind, rates)
    }
    const several = kinds.size > 1
    for (const [kind, rates] of kinds) {
      const lines = [...rates.entries()]
        .map(([rate, m]) => ({ vatRate: Math.round(rate * 100) / 10000, netAmount: toEur(m.net), vatAmount: toEur(m.vat) }))
        .sort((x, y) => y.vatRate - x.vatRate)
      const net = round2(lines.reduce((sum, l) => sum + l.netAmount, 0))
      const vat = round2(lines.reduce((sum, l) => sum + l.vatAmount, 0))
      const own = inv.lines.filter((l) => !several || (l.taxCategory === 'AE' || l.taxCategory === 'K' ? l.taxCategory : 'normal') === kind)
      const label = kind === 'AE' ? '§ 13b' : kind === 'K' ? 'innergem. Erwerb' : 'mit Umsatzsteuer'
      planned.push({
        description: describe(inv, own, several ? label : null),
        netAmount: net,
        vatAmount: vat,
        grossAmount: round2(net + vat),
        vatRate: [...lines].sort((x, y) => y.netAmount - x.netAmount)[0].vatRate,
        taxCategory: kind === 'normal' ? 'S' : kind,
        isReverseCharge: kind === 'AE',
        isIntraEU: kind === 'K',
        ...(lines.length > 1 ? { taxLines: lines } : {}),
      })
    }
    // What ExpenseService.create would refuse is said here already, so that the
    // preview does not promise an import that then fails.
    if (inv.issueDate) {
      for (const check of [
        async () => assertNotFuture(inv.issueDate, 'Das Rechnungsdatum'),
        async () => assertPeriodOpen(this.prisma, companyId, [inv.issueDate!], 'das Erfassen einer Eingangsrechnung'),
      ]) {
        try {
          await check()
        } catch (e) {
          if (!(e instanceof HttpException)) throw e
          blocking.push(e.message)
        }
      }
    }
    if (!blocking.length && planned.length === 0) blocking.push('Die Rechnung enthält keine Beträge.')
    for (const p of planned) {
      for (const l of p.taxLines ?? [{ vatRate: p.vatRate, netAmount: p.netAmount, vatAmount: p.vatAmount }]) {
        const problem = expenseAmountsError({ net: l.netAmount, vat: l.vatAmount, gross: l.netAmount + l.vatAmount, rate: l.vatRate })
        if (problem && !blocking.includes(problem)) blocking.push(problem)
      }
    }

    return {
      supplier: supplier ? { id: supplier.id, name: supplier.name, matchedBy } : null,
      /** a supplier record will be created from the invoice */
      supplierWillBeCreated: !supplier,
      ibanDiffers,
      buyerMatches,
      duplicate,
      contentHash,
      en16931,
      expenses: planned,
      blocking,
      warnings,
      importable: blocking.length === 0,
    }
  }

  /** Create the supplier (when new), the expense(s) and keep the file. */
  async import(
    companyId: string,
    userId: string | undefined,
    file: { buffer: Buffer; originalName: string; mimeType: string },
    opts: ImportOptions = {},
  ) {
    // One import at a time per company: "has this invoice been entered?" and
    // "does this supplier exist?" are answered before the rows are written.
    // Measured without: the same file sent four times at once → booked twice.
    return withKeyLock(`e-invoice-import:${companyId}`, () => this.importLocked(companyId, userId, file, opts))
  }

  private async importLocked(
    companyId: string,
    userId: string | undefined,
    file: { buffer: Buffer; originalName: string; mimeType: string },
    opts: ImportOptions,
  ) {
    const read = await this.read(file.buffer)
    if (!read) throw new BadRequestException('Die PDF-Datei enthält keine E-Rechnung (keine eingebettete XML-Datei).')
    const inv = read.invoice
    const plan = await this.plan(companyId, file.buffer, read, opts, true)
    if (plan.blocking.length) throw new BadRequestException(plan.blocking.join(' '))
    if (plan.duplicate && !opts.confirmDuplicate) {
      throw duplicateExpenseConflict(plan.duplicate.message)
    }
    if (plan.buyerMatches === false && !opts.confirmRecipient) {
      throw new ConflictException(
        `Die Rechnung ist an „${inv.buyer.name ?? inv.buyer.vatId ?? '?'}“ gerichtet, nicht an Ihre Firma. Ist sie dennoch Ihre, mit „confirmRecipient“ bestätigen.`,
      )
    }

    let supplierId = plan.supplier?.id
    let supplierCreated = false
    if (!supplierId) {
      const validVat = inv.seller.vatId && !vatIdFormatProblem(inv.seller.vatId) ? inv.seller.vatId : null
      const validIban = inv.payment.iban && !ibanProblem(inv.payment.iban) ? inv.payment.iban : null
      const created = await this.suppliers.create(companyId, {
        name: inv.seller.name,
        ...(validVat ? { vatId: validVat } : {}),
        address: {
          street: inv.seller.street ?? '',
          postalCode: inv.seller.postalCode ?? '',
          city: inv.seller.city ?? '',
          country: inv.seller.country ?? '',
        },
        contact: { name: inv.seller.contactName, email: inv.seller.email, phone: inv.seller.phone },
        bankInfo: validIban ? { iban: validIban, bic: inv.payment.bic } : null,
        metadata: {
          source: 'e-invoice',
          taxNumber: inv.seller.taxNumber,
          ...(inv.seller.vatId && !validVat ? { vatIdAsReceived: inv.seller.vatId } : {}),
        },
      })
      supplierId = created.id
      supplierCreated = true
    }

    const notes = noteFor(inv, read, opts.exchangeRate, plan.en16931)
    const created: { id: string }[] = []
    try {
      for (const p of plan.expenses) {
        const expense = await this.expenses.create(companyId, {
          supplierId,
          invoiceNumber: inv.number,
          invoiceDate: inv.issueDate,
          description: p.description,
          netAmount: p.netAmount,
          vatAmount: p.vatAmount,
          grossAmount: p.grossAmount,
          vatRate: p.vatRate,
          ...(p.taxLines ? { taxLines: p.taxLines } : {}),
          creditNote: inv.creditNote,
          isReverseCharge: p.isReverseCharge,
          isIntraEU: p.isIntraEU,
          category: opts.category,
          accountNumber: opts.accountNumber,
          paidAt: opts.paidAt,
          notes,
          // The duplicate question was answered above; a § 13b part beside
          // the taxed part of the same invoice is no duplicate of it.
          confirmDuplicate: true,
        })
        created.push(expense)
      }
      // The received file, unchanged, on every expense it produced.
      const name = attachmentName(file.originalName, read.source, inv.number)
      const text = searchText(inv)
      for (const e of created) {
        await this.attachments.upload({
          companyId,
          entityType: 'expense',
          entityId: e.id,
          buffer: file.buffer,
          originalName: name,
          declaredMimeType: file.mimeType,
          size: file.buffer.length,
          uploadedById: userId,
          text,
          keptOriginal: true, // Tier 740
        })
      }
    } catch (e) {
      // All or nothing: an invoice half booked is worse than one not booked.
      for (const c of created) {
        const kept = await this.prisma.attachment.findMany({ where: { companyId, entityType: 'expense', entityId: c.id }, select: { id: true } }).catch(() => [])
        for (const a of kept) await this.attachments.removeUnbooked(companyId, a.id).catch(() => undefined)
        await this.prisma.expense.deleteMany({ where: { id: c.id, companyId } }).catch(() => undefined)
      }
      if (supplierCreated && supplierId) {
        await this.prisma.supplier.deleteMany({ where: { id: supplierId, companyId, expenses: { none: {} } } }).catch(() => undefined)
      }
      this.logger.warn(`e-invoice import rolled back: ${(e as Error)?.message}`)
      throw e
    }
    return {
      expenseIds: created.map((c) => c.id),
      supplierId,
      supplierCreated,
      invoiceNumber: inv.number,
      profile: inv.profile,
      en16931: plan.en16931,
      warnings: plan.warnings,
    }
  }

  /** The e-invoice kept with an expense, read again for display. */
  async forExpense(companyId: string, expenseId: string) {
    const expense = await this.prisma.expense.findFirst({ where: { id: expenseId, companyId }, select: { id: true } })
    if (!expense) throw new NotFoundException('Eingangsrechnung nicht gefunden')
    const files = await this.prisma.attachment.findMany({
      where: { companyId, entityType: 'expense', entityId: expenseId, mimeType: { in: ['application/xml', 'application/pdf'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, originalName: true, mimeType: true },
    })
    // XML first — it is the invoice itself.
    for (const att of [...files.filter((f) => f.mimeType === 'application/xml'), ...files.filter((f) => f.mimeType !== 'application/xml')]) {
      try {
        const file = await this.attachments.getFile(companyId, att.id)
        const read = await this.read(file.buffer)
        if (read) {
          return { eInvoice: true as const, attachmentId: att.id, originalName: att.originalName, source: read.source, embeddedFile: read.embeddedFile, invoice: read.invoice }
        }
      } catch {
        // not an invoice, or the file is gone — try the next
      }
    }
    return { eInvoice: false as const }
  }
}

// ---- wording -----------------------------------------------------------------

function describe(inv: ParsedEInvoice, lines: EInvoiceLine[], part: string | null): string {
  const names = lines.map((l) => l.name || l.description).filter((n): n is string => !!n)
  const what = names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? ` … (${names.length} Positionen)` : '') : `Rechnung ${inv.number ?? ''}`.trim()
  const tail = part ? ` (${part})` : ''
  const head = `${inv.seller.name ?? 'Lieferant'}: `
  return (head + what).slice(0, 500 - tail.length) + tail
}

function noteFor(inv: ParsedEInvoice, read: ReadEInvoice, exchangeRate?: number, check?: En16931Check | null): string {
  const syntax = inv.syntax === 'cii' ? 'CII' : 'UBL'
  const parts = [`E-Rechnung ${inv.profile} (${syntax}${read.source === 'pdf' ? `, eingebettet als ${read.embeddedFile}` : ''})`]
  // Tier 738: the verdict at the time of booking, kept with the expense
  if (check) {
    const on = check.at.slice(0, 10).split('-').reverse().join('.')
    parts.push(
      !check.checked
        ? 'EN 16931 nicht geprüft (Validator nicht verfügbar)'
        : check.valid
          ? `EN 16931 geprüft am ${on} (KoSIT): gültig`
          : `EN 16931 geprüft am ${on} (KoSIT): nicht gültig — ${[...new Set(check.errors.map((e) => e.rule).filter(Boolean))].slice(0, 8).join(', ') || `${check.errors.length} Fehler`}`,
    )
  }
  if (inv.currency && inv.currency !== 'EUR' && inv.totals.gross != null) {
    parts.push(`Original ${eur(inv.totals.gross)} ${inv.currency}, 1 EUR = ${String(exchangeRate).replace('.', ',')} ${inv.currency}`)
  }
  if (inv.dueDate) parts.push(`fällig ${inv.dueDate.split('-').reverse().join('.')}`)
  if (inv.totals.payable != null && inv.totals.gross != null && Math.round(inv.totals.payable * 100) !== Math.round(inv.totals.gross * 100)) {
    parts.push(`Zahlbetrag ${eur(inv.totals.payable)}`)
  }
  if (inv.payment.iban) parts.push(`IBAN laut Rechnung ${inv.payment.iban}`)
  if (inv.payment.remittance) parts.push(`Verwendungszweck ${inv.payment.remittance}`)
  for (const sk of inv.skonto) {
    parts.push(`Skonto ${String(sk.percent).replace('.', ',')} % innerhalb von ${sk.days} Tagen${sk.amount != null ? ` (${eur(sk.amount)})` : ''}`)
  }
  if (inv.payment.terms) parts.push(`Zahlungsbedingungen: ${inv.payment.terms}`)
  if (inv.periodStart || inv.periodEnd) parts.push(`Leistungszeitraum ${inv.periodStart ?? '?'} – ${inv.periodEnd ?? '?'}`)
  else if (inv.deliveryDate) parts.push(`Leistungsdatum ${inv.deliveryDate.split('-').reverse().join('.')}`)
  if (inv.orderReference) parts.push(`Bestellung ${inv.orderReference}`)
  if (inv.precedingInvoice) parts.push(`zu Rechnung ${inv.precedingInvoice}`)
  return parts.join(' · ').slice(0, 2000)
}

/** The stored name says what the file is, whatever it was called on upload. */
function attachmentName(original: string, source: 'xml' | 'pdf', number: string | null): string {
  const ext = source === 'pdf' ? '.pdf' : '.xml'
  const base = (original || '').replace(/[\\/]/g, '_').trim()
  if (base.toLowerCase().endsWith(ext) && base.length > ext.length) return base.slice(0, 200)
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '') || `E-Rechnung-${number ?? 'ohne-Nummer'}`
  return `${stem.slice(0, 190)}${ext}`
}

/** Plain text of the invoice, for the full-text search over attachments. */
function searchText(inv: ParsedEInvoice): string {
  const out = [
    `E-Rechnung ${inv.number ?? ''} vom ${inv.issueDate ?? ''}`,
    `${inv.seller.name ?? ''} ${inv.seller.vatId ?? ''} ${inv.seller.taxNumber ?? ''}`,
    `${inv.seller.street ?? ''} ${inv.seller.postalCode ?? ''} ${inv.seller.city ?? ''}`,
    ...inv.lines.map((l) => `${l.quantity ?? ''} ${l.unit ?? ''} ${l.name ?? ''} ${l.description ?? ''} ${l.netAmount ?? ''}`),
    `Netto ${inv.totals.net ?? ''} USt ${inv.totals.tax ?? ''} Brutto ${inv.totals.gross ?? ''} ${inv.currency ?? ''}`,
    ...inv.notes,
  ]
  return out.join('\n').replace(/[ \t]+/g, ' ').slice(0, 20000)
}
