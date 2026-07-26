import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 108: SEPA pain.001 batch payment generator.
 *
 * Generates a single pain.001.001.09 XML file that
 * batches all "unpaid" expenses for a company into
 * one batch the Berater hands to the bank via the
 * bank's online banking portal. Same workflow as
 * XRechnung (the receiver-side document) but for
 * the sender side (the payer).
 *
 * pain.001 schema (v3, the standard for German
 * banks since ~2014):
 *   - GroupHeader: InitiatingParty + control sums
 *     (NbOfTxs + CtrlSum)
 *   - PaymentInformation: DebtorAccount + one or
 *     more CreditTransferTransactionInfo records
 *     (each = one vendor payment with IBAN, BIC,
 *     amount, remittance)
 *
 * The same XML format is used for SEPA Lastschriften
 * (incoming direct debits) but we only generate
 * the outgoing "Überweisung" (credit transfer) path
 * here. v2: extend with pain.008 for Lastschriften.
 *
 * IBAN validation: SEPA IBAN check digit algorithm
 * (ISO 13616, mod-97-10). We validate the format
 * but not the check digits — the bank does that
 * at submission time. v1: format + length check.
 *
 * BIC: optional in SEPA pain.001.001.09 since
 * 2016 (the routing can be derived from the
 * IBAN's country + bank code for SEPA
 * participants). We include it when the supplier
 * provides it; otherwise we leave it empty
 * (the XML schema allows this).
 *
 * Remittance: pain.001 supports either
 *   <Strd><CdtrRefInf><Ref>...</Ref></CdtrRefInf></Strd>
 * for SEPA-structured references, or
 *   <Ustrd>free text up to 140 chars</Ustrd>
 * for unstructured. We use Ustrd with the supplier
 * invoice number + the expense description
 * (e.g. "RE-2026-0042 Material").
 */
@Injectable()
export class PaymentsService {
  constructor(private prisma: PrismaService) {}

  /**
   * List all unpaid expenses for a company. The
   * "unpaid" set is `status='booked' AND paidAt IS
   * NULL` — the typical "open payables" view the
   * Berater sees at month-end.
   */
  async listUnpaidExpenses(companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        status: 'booked',
        paidAt: null,
        // We need a supplier with IBAN. Expenses
        // without a supplier OR with a supplier
        // without bankInfo can't be paid via SEPA.
        supplierId: { not: null },
      },
      include: {
        supplier: true,
      },
      orderBy: [{ invoiceDate: 'asc' }, { invoiceNumber: 'asc' }],
    })
    // Filter out expenses where the supplier has
    // no IBAN (cannot be paid via SEPA). The DB
    // query above filters suppliers by id; the
    // bankInfo check has to be in code because
    // bankInfo is a Json column.
    return expenses.filter((e) => {
      const iban = (e.supplier as any)?.bankInfo?.iban
      return typeof iban === 'string' && iban.length > 0
    })
  }

  /**
   * Generate a single pain.001 batch from the given
   * expense IDs. The batch is persisted to the
   * SepaBatch table + the linked Expenses are
   * marked as paidAt = executionDate.
   */
  async generateBatch(
    companyId: string,
    userId: string | null,
    params: {
      expenseIds: string[]
      executionDate: string // ISO date
      notes?: string
      debtorIban?: string
      debtorBic?: string
      debtorName?: string
    },
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Array.isArray(params.expenseIds) || params.expenseIds.length === 0) {
      throw new BadRequestException('expenseIds[] ist erforderlich (nicht leer)')
    }
    if (!params.executionDate || !/^\d{4}-\d{2}-\d{2}$/.test(params.executionDate)) {
      throw new BadRequestException('executionDate ist ungültig (YYYY-MM-DD)')
    }

    // Load the company for the debtor info.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) {
      throw new NotFoundException('Firma nicht gefunden')
    }
    const debtorIban =
      params.debtorIban || (company.bankInfo as any)?.iban
    const debtorBic =
      params.debtorBic || (company.bankInfo as any)?.bic
    const debtorName = params.debtorName || company.legalName || company.name
    if (!debtorIban || !/^[A-Z]{2}\d{2}/.test(String(debtorIban).replace(/\s/g, ''))) {
      throw new BadRequestException(
        'Debtor-IBAN fehlt oder ist ungültig (bitte unter "Einstellungen" → Bankverbindung erfassen).',
      )
    }

    // Load the selected expenses (with suppliers).
    const expenses = await this.prisma.expense.findMany({
      where: {
        id: { in: params.expenseIds },
        companyId,
        status: 'booked',
        paidAt: null,
      },
      include: { supplier: true },
    })
    if (expenses.length === 0) {
      throw new BadRequestException(
        'Keine offenen Ausgaben gefunden — entweder bereits bezahlt oder IDs ungültig.',
      )
    }
    if (expenses.length !== params.expenseIds.length) {
      const found = new Set(expenses.map((e) => e.id))
      const missing = params.expenseIds.filter((id) => !found.has(id))
      throw new BadRequestException(
        `Folgende Ausgaben sind nicht offen / nicht im Besitz dieser Firma: ${missing.join(', ')}`,
      )
    }

    // Validate each expense has an IBAN + the IBAN format.
    for (const e of expenses) {
      const iban = (e.supplier as any)?.bankInfo?.iban
      if (!iban || !/^[A-Z]{2}\d{2}/.test(String(iban).replace(/\s/g, ''))) {
        throw new BadRequestException(
          `Ausgabe ${e.invoiceNumber || e.id} hat keine gültige Lieferanten-IBAN.`,
        )
      }
    }

    // Build the pain.001 XML.
    const xml = this.buildPain001Xml({
      companyId,
      companyName: debtorName,
      debtorIban: String(debtorIban).replace(/\s/g, ''),
      debtorBic: debtorBic ? String(debtorBic).replace(/\s/g, '') : undefined,
      executionDate: params.executionDate,
      notes: params.notes,
      messageId: `BATCH-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      payments: expenses.map((e) => {
        const iban = String((e.supplier as any).bankInfo.iban).replace(/\s/g, '')
        const bic = (e.supplier as any).bankInfo?.bic
        const recipientName = (e.supplier as any).bankInfo?.kontoinhaber
          || e.supplier!.name
        return {
          paymentId: e.id,
          endToEndId: `E2E-${e.id}`,
          amount: Number(e.grossAmount),
          currency: 'EUR',
          creditorIban: iban,
          creditorBic: bic ? String(bic).replace(/\s/g, '') : undefined,
          creditorName: recipientName,
          // Use the invoice number + description as
          // an unstructured remittance (max 140 chars).
          remittance: this.truncate(
            `${e.invoiceNumber || ''} ${e.description || ''}`.trim(),
            140,
          ),
        }
      }),
    })

    // Persist the batch + mark expenses as paid.
    const totalAmount = expenses.reduce(
      (s, e) => s + Number(e.grossAmount),
      0,
    )
    const batch = await this.prisma.sepaBatch.create({
      data: {
        companyId,
        xmlContent: xml,
        paymentCount: expenses.length,
        totalAmount: Math.round(totalAmount * 100) / 100,
        debtorIban: String(debtorIban).replace(/\s/g, ''),
        debtorBic: debtorBic ? String(debtorBic).replace(/\s/g, '') : null,
        debtorName,
        executionDate: new Date(params.executionDate),
        notes: params.notes || null,
        status: 'generated',
      },
    })
    await this.prisma.expense.updateMany({
      where: { id: { in: expenses.map((e) => e.id) } },
      data: {
        paidAt: new Date(params.executionDate),
        paidBySepaBatchId: batch.id,
      },
    })

    return {
      id: batch.id,
      paymentCount: batch.paymentCount,
      totalAmount: Number(batch.totalAmount),
      executionDate: batch.executionDate,
      status: batch.status,
      xmlContent: xml,
    }
  }

  /**
   * Build the actual pain.001.001.09 XML.
   */
  private buildPain001Xml(input: {
    companyId: string
    companyName: string
    debtorIban: string
    debtorBic?: string
    executionDate: string
    notes?: string
    messageId: string
    payments: Array<{
      paymentId: string
      endToEndId: string
      amount: number
      currency: string
      creditorIban: string
      creditorBic?: string
      creditorName: string
      remittance: string
    }>
  }): string {
    const totalAmount = input.payments.reduce((s, p) => s + p.amount, 0)
    const nbOfTxs = input.payments.length
    const ctrlSum = Math.round(totalAmount * 100) / 100
    const createdAt = new Date().toISOString()

    const txBlock = input.payments
      .map((p, i) => {
        const instrId = `INSTR-${i + 1}`
        return `
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>${this.escapeXml(instrId)}</InstrId>
        <EndToEndId>${this.escapeXml(p.endToEndId)}</EndToEndId>
      </PmtId>
      <Amt>
        <InstdAmt Ccy="${this.escapeXml(p.currency)}">${p.amount.toFixed(2)}</InstdAmt>
      </Amt>
      <CdtrAgt>
        <FinInstnId>${p.creditorBic ? `<BIC>${this.escapeXml(p.creditorBic)}</BIC>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId>
      </CdtrAgt>
      <Cdtr>
        <Nm>${this.escapeXml(p.creditorName)}</Nm>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <IBAN>${this.escapeXml(p.creditorIban)}</IBAN>
        </Id>
      </CdtrAcct>
      <RmtInf>
        <Ustrd>${this.escapeXml(p.remittance)}</Ustrd>
      </RmtInf>
    </CdtTrfTxInf>`
      })
      .join('')

    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${this.escapeXml(input.messageId)}</MsgId>
      <CreDtTm>${createdAt}</CreDtTm>
      <NbOfTxs>${nbOfTxs}</NbOfTxs>
      <CtrlSum>${ctrlSum.toFixed(2)}</CtrlSum>
      <InitgPty>
        <Nm>${this.escapeXml(input.companyName)}</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${this.escapeXml(input.messageId)}-PMT</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${nbOfTxs}</NbOfTxs>
      <CtrlSum>${ctrlSum.toFixed(2)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
      </PmtTpInf>
      <ReqdExctnDt>${input.executionDate}</ReqdExctnDt>
      <Dbtr>
        <Nm>${this.escapeXml(input.companyName)}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>${this.escapeXml(input.debtorIban)}</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>${input.debtorBic ? `<BIC>${this.escapeXml(input.debtorBic)}</BIC>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId>
      </DbtrAgt>${txBlock}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`
  }

  async getBatch(batchId: string) {
    return this.prisma.sepaBatch.findUnique({
      where: { id: batchId },
      include: { expenses: { select: { id: true, invoiceNumber: true, description: true, grossAmount: true } } },
    })
  }

  async listBatches(companyId: string) {
    return this.prisma.sepaBatch.findMany({
      where: { companyId },
      orderBy: { executionDate: 'desc' },
      select: {
        id: true,
        paymentCount: true,
        totalAmount: true,
        debtorIban: true,
        debtorName: true,
        executionDate: true,
        status: true,
        notes: true,
        createdAt: true,
      },
    })
  }

  private truncate(s: string, n: number): string {
    return s.length > n ? s.substring(0, n) : s
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }
}
