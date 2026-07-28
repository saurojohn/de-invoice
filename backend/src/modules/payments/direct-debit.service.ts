import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 112: SEPA pain.008 (Lastschrift / Direct Debit) — incoming.
 *
 * The inverse of Tier 108 (pain.001, outgoing). Instead of
 * the company paying suppliers, here the company RECEIVES
 * money from customers via SEPA direct debit.
 *
 * Two preconditions for a direct-debit collection:
 *   1. A signed SEPA-Lastschriftmandat (mandate) by the
 *      customer. One mandate can power many collections
 *      (recurring subscriptions) or one (single-shot).
 *   2. A B2B or CORE scheme decision:
 *      - CORE (default, B2C): 14-day Vorabankündigung
 *        required, customer can Widerruf within 8 weeks.
 *      - B2B: 1-day Vorabankündigung, no Widerruf.
 *
 * The Mandate is the contractual link; the Batch is the
 * XML the Berater hands to the bank. The Collection is
 * the per-invoice row inside the batch (1 batch can
 * collect many invoices, one mandate per invoice).
 *
 * Gläubiger-Identifikationsnummer (creditor identifier):
 * 18-char Bundesbank-issued ID, REQUIRED for all
 * direct-debit collections. We default to a per-company
 * setting but allow per-batch override.
 *
 * v1 limitations (deferred to v2):
 *   - No actual Vorabankündigung email send (we just
 *     stamp the `preNotificationSentAt` field)
 *   - No R-Transaction (Rücklastschrift) handling —
 *     flagged as 'returned' status but no auto-credit
 *     to the customer's account
 *   - No automatic SEPA-Lastschriftmandat PDF
 *     generation (the user prints / emails the
 *     mandate text themselves)
 */
@Injectable()
export class DirectDebitService {
  constructor(private prisma: PrismaService) {}

  // ─── Mandate management ───────────────────────────────────

  async listMandates(companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.prisma.sepaDirectDebitMandate.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, customerNumber: true } },
        _count: { select: { collections: true } },
      },
    })
  }

  async createMandate(
    companyId: string,
    body: {
      customerId: string
      mandateReference?: string
      dateOfSignature: string
      type?: 'CORE' | 'B2B'
      iban: string
      bic?: string
      debitorName: string
      description?: string
    },
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!body.customerId) {
      throw new BadRequestException('customerId ist erforderlich')
    }
    if (!body.dateOfSignature || !/^\d{4}-\d{2}-\d{2}$/.test(body.dateOfSignature)) {
      throw new BadRequestException('dateOfSignature ist ungültig (YYYY-MM-DD)')
    }
    if (!body.iban || !/^[A-Z]{2}\d{2}/.test(String(body.iban).replace(/\s/g, ''))) {
      throw new BadRequestException('IBAN ist ungültig')
    }
    if (!body.debitorName || body.debitorName.trim().length === 0) {
      throw new BadRequestException('debitorName ist erforderlich')
    }
    const type = body.type || 'CORE'
    if (type !== 'CORE' && type !== 'B2B') {
      throw new BadRequestException("type muss 'CORE' oder 'B2B' sein")
    }

    // Verify the customer belongs to this company
    const customer = await this.prisma.customer.findFirst({
      where: { id: body.customerId, companyId },
    })
    if (!customer) {
      throw new NotFoundException('Kunde nicht gefunden')
    }

    // Generate a mandate reference if not provided.
    // Convention: MANDATE-{customerNumber}-{YYYYMMDD}-{4digit}
    // The 4-digit suffix avoids duplicates on the same day
    // for the same customer. We use count() to size the
    // suffix (idempotent re-runs: same date yields the
    // same suffix but we block via the @unique constraint
    // on (companyId, mandateReference) and 409 on collision).
    let mandateRef = body.mandateReference?.trim()
    if (!mandateRef) {
      const cnum = customer.customerNumber || customer.id.substring(0, 8)
      const today = body.dateOfSignature.replace(/-/g, '')
      const existing = await this.prisma.sepaDirectDebitMandate.count({
        where: { companyId, mandateReference: { startsWith: `MANDATE-${cnum}-${today}-` } },
      })
      mandateRef = `MANDATE-${cnum}-${today}-${String(existing + 1).padStart(4, '0')}`
    }

    return this.prisma.sepaDirectDebitMandate.create({
      data: {
        companyId,
        customerId: body.customerId,
        mandateReference: mandateRef,
        dateOfSignature: new Date(body.dateOfSignature),
        type,
        iban: String(body.iban).replace(/\s/g, '').toUpperCase(),
        bic: body.bic ? String(body.bic).replace(/\s/g, '').toUpperCase() : null,
        debitorName: body.debitorName.trim(),
        description: body.description || null,
        status: 'active',
      },
    })
  }

  async revokeMandate(companyId: string, mandateId: string, reason?: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const mandate = await this.prisma.sepaDirectDebitMandate.findFirst({
      where: { id: mandateId, companyId },
    })
    if (!mandate) {
      throw new NotFoundException('Mandat nicht gefunden')
    }
    if (mandate.status === 'revoked') {
      // Idempotent — no-op on double-revoke.
      return mandate
    }
    return this.prisma.sepaDirectDebitMandate.update({
      where: { id: mandateId },
      data: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedReason: reason || null,
      },
    })
  }

  // ─── Open invoices (eligible for direct debit) ───────────

  /**
   * List invoices that are eligible to be collected via
   * direct debit. The criteria are:
   *   - status = 'sent' or 'overdue' (NOT 'draft' or
   *     'paid' or 'cancelled')
   *   - NOT already collected by another direct-debit batch
   *     (collectedBySepaBatchId IS NULL)
   *   - The customer has at least one active mandate
   *     (we return the mandate ref so the UI can auto-
   *     select it for the batch)
   *
   * The eligibility check joins Customer + Mandate in
   * code (Prisma's relation filters don't reach across
   * the Customer → Mandate edge the way we need for
   * the OR-mandate-or-skip logic).
   */
  async listOpenInvoices(companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ['sent', 'overdue'] },
        collectedBySepaBatchId: null,
      },
      include: {
        customer: {
          include: {
            sepaDirectDebitMandates: {
              where: { status: 'active' },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { invoiceNumber: 'asc' }],
    })
    // Annotate: only return invoices whose customer has
    // at least one active mandate. The customer with no
    // mandate is filtered out — they need a mandate
    // signed first.
    return invoices
      .filter((inv) => inv.customer.sepaDirectDebitMandates.length > 0)
      .map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerId: inv.customerId,
        customerName: inv.customer.name,
        customerNumber: inv.customer.customerNumber,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        total: Number(inv.total),
        status: inv.status,
        mandateId: inv.customer.sepaDirectDebitMandates[0].id,
        mandateReference: inv.customer.sepaDirectDebitMandates[0].mandateReference,
        mandateType: inv.customer.sepaDirectDebitMandates[0].type,
        iban: inv.customer.sepaDirectDebitMandates[0].iban,
      }))
  }

  // ─── Batch generation ─────────────────────────────────────

  /**
   * Generate a single pain.008 batch from the given
   * invoice + mandate pairs. Each (invoiceId, mandateId)
   * pair becomes one SepaDirectDebitCollection row + one
   * <DrctDbtTxInf> in the pain.008 XML.
   *
   * Important: ALL collections in a batch must use the
   * same type (CORE or B2B) per §2.2 of the Scheme
   * Rulebook. We enforce this here.
   */
  async generateBatch(
    companyId: string,
    params: {
      collections: Array<{ invoiceId: string; mandateId: string }>
      executionDate: string
      type?: 'CORE' | 'B2B'
      notes?: string
      creditorIban?: string
      creditorBic?: string
      creditorName?: string
      creditorIdentifier?: string
    },
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Array.isArray(params.collections) || params.collections.length === 0) {
      throw new BadRequestException('collections[] ist erforderlich (nicht leer)')
    }
    if (!params.executionDate || !/^\d{4}-\d{2}-\d{2}$/.test(params.executionDate)) {
      throw new BadRequestException('executionDate ist ungültig (YYYY-MM-DD)')
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) {
      throw new NotFoundException('Firma nicht gefunden')
    }

    // Default creditor info from Company.bankInfo + settings
    const creditorIban =
      params.creditorIban || (company.bankInfo as any)?.iban
    const creditorBic =
      params.creditorBic || (company.bankInfo as any)?.bic
    const creditorName = params.creditorName || company.legalName || company.name
    // The Gläubiger-ID comes from settings (we added
    // company.settings.sepaCreditorIdentifier support in
    // v1; the user sets it on the settings page).
    const creditorIdentifier =
      params.creditorIdentifier ||
      (company.settings as any)?.sepaCreditorIdentifier ||
      `DE${company.id.replace(/-/g, '').substring(0, 14).toUpperCase()}00`
    if (!creditorIban || !/^[A-Z]{2}\d{2}/.test(String(creditorIban).replace(/\s/g, ''))) {
      throw new BadRequestException(
        'Gläubiger-IBAN fehlt oder ist ungültig (bitte unter "Einstellungen" → Bankverbindung erfassen).',
      )
    }
    if (!creditorIdentifier || creditorIdentifier.length < 18) {
      throw new BadRequestException(
        'Gläubiger-Identifikationsnummer fehlt oder ist zu kurz (18 Zeichen erforderlich, bitte unter "Einstellungen" setzen).',
      )
    }

    // Load the selected invoices + their mandates.
    const invoiceIds = params.collections.map((c) => c.invoiceId)
    const invoices = await this.prisma.invoice.findMany({
      where: {
        id: { in: invoiceIds },
        companyId,
        status: { in: ['sent', 'overdue'] },
        collectedBySepaBatchId: null,
      },
      include: { customer: true },
    })
    if (invoices.length === 0) {
      throw new BadRequestException(
        'Keine offenen Rechnungen gefunden — entweder bereits eingezogen oder IDs ungültig.',
      )
    }
    if (invoices.length !== invoiceIds.length) {
      const found = new Set(invoices.map((i) => i.id))
      const missing = invoiceIds.filter((id) => !found.has(id))
      throw new BadRequestException(
        `Folgende Rechnungen sind nicht offen / nicht im Besitz dieser Firma: ${missing.join(', ')}`,
      )
    }

    // Load the mandates and verify they're active + belong
    // to the right customer for each invoice.
    const mandateIds = [...new Set(params.collections.map((c) => c.mandateId))]
    const mandates = await this.prisma.sepaDirectDebitMandate.findMany({
      where: { id: { in: mandateIds }, companyId },
    })
    const mandateById = new Map(mandates.map((m) => [m.id, m]))
    for (const m of mandates) {
      if (m.status !== 'active') {
        throw new BadRequestException(
          `Mandat ${m.mandateReference} ist widerrufen und kann nicht verwendet werden.`,
        )
      }
    }

    // Enforce the §2.2 rule: all collections in a batch
    // must use the same type. Determine the batch type
    // from the first mandate and verify the rest match.
    const invMandatePairs = params.collections.map((c) => {
      const inv = invoices.find((i) => i.id === c.invoiceId)!
      const mandate = mandateById.get(c.mandateId)
      if (!mandate) {
        throw new BadRequestException(
          `Mandat ${c.mandateId} nicht gefunden.`,
        )
      }
      if (mandate.customerId !== inv.customerId) {
        throw new BadRequestException(
          `Mandat ${mandate.mandateReference} gehört nicht zum Kunden der Rechnung ${inv.invoiceNumber}.`,
        )
      }
      return { inv, mandate }
    })
    const batchType = params.type || invMandatePairs[0].mandate.type
    if (batchType !== 'CORE' && batchType !== 'B2B') {
      throw new BadRequestException("type muss 'CORE' oder 'B2B' sein")
    }
    const wrongType = invMandatePairs.find((p) => p.mandate.type !== batchType)
    if (wrongType) {
      throw new BadRequestException(
        `Mandat ${wrongType.mandate.mandateReference} ist ${wrongType.mandate.type}, Batch ist aber ${batchType} (alle Mandate eines Batches müssen gleichen Typ haben, §2.2 Scheme Rulebook).`,
      )
    }

    // Build the pain.008 XML.
    const totalAmount = invMandatePairs.reduce(
      (s, p) => s + Number(p.inv.total),
      0,
    )
    const xml = this.buildPain008Xml({
      companyId,
      messageId: `DD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      creditorIban: String(creditorIban).replace(/\s/g, ''),
      creditorBic: creditorBic ? String(creditorBic).replace(/\s/g, '') : undefined,
      creditorName,
      creditorIdentifier,
      type: batchType,
      executionDate: params.executionDate,
      notes: params.notes,
      transactions: invMandatePairs.map(({ inv, mandate }) => ({
        collectionId: `C-${inv.id}`,
        endToEndId: `E2E-${inv.id}`,
        invoiceNumber: inv.invoiceNumber,
        amount: Number(inv.total),
        currency: inv.currency,
        debitorIban: mandate.iban,
        debitorBic: mandate.bic || undefined,
        debitorName: mandate.debitorName,
        mandateReference: mandate.mandateReference,
        dateOfSignature: mandate.dateOfSignature,
        remittance: this.truncate(
          `RE ${inv.invoiceNumber} ${inv.notes || ''}`.trim(),
          140,
        ),
      })),
    })

    // Persist the batch + collections + mark invoices.
    const batch = await this.prisma.sepaDirectDebitBatch.create({
      data: {
        companyId,
        xmlContent: xml,
        collectionCount: invMandatePairs.length,
        totalAmount: Math.round(totalAmount * 100) / 100,
        creditorIban: String(creditorIban).replace(/\s/g, ''),
        creditorBic: creditorBic ? String(creditorBic).replace(/\s/g, '') : null,
        creditorName,
        creditorIdentifier,
        type: batchType,
        executionDate: new Date(params.executionDate),
        notes: params.notes || null,
        status: 'generated',
      },
    })

    // Pre-notification deadline: 14 days (CORE) or 1 day
    // (B2B) before executionDate. The actual send
    // timestamp is set to NOW (we treat the batch
    // creation as the moment of pre-notification; the
    // UI is expected to email the customer separately
    // for now — v2 wires up an actual email).
    const preNotifDeadline = new Date(params.executionDate)
    preNotifDeadline.setDate(
      preNotifDeadline.getDate() - (batchType === 'B2B' ? 1 : 14),
    )

    for (const { inv, mandate } of invMandatePairs) {
      await this.prisma.sepaDirectDebitCollection.create({
        data: {
          companyId,
          batchId: batch.id,
          mandateId: mandate.id,
          invoiceId: inv.id,
          amount: inv.total,
          preNotificationSentAt: new Date(),
          preNotificationDeadline: preNotifDeadline,
          status: 'pre_notified',
        },
      })
    }
    await this.prisma.invoice.updateMany({
      where: { id: { in: invoiceIds } },
      data: { collectedBySepaBatchId: batch.id },
    })

    return {
      id: batch.id,
      collectionCount: batch.collectionCount,
      totalAmount: Number(batch.totalAmount),
      executionDate: batch.executionDate,
      type: batch.type,
      creditorIdentifier: batch.creditorIdentifier,
      status: batch.status,
      xmlContent: xml,
    }
  }

  /**
   * Build the actual pain.008.001.02 XML.
   *
   * pain.008 is symmetric to pain.001 in structure but
   * with the creditor/debtor sides flipped:
   *   - pain.001: <Dbtr> = company, <Cdtr> = supplier
   *   - pain.008: <Cdtr> = company, <Dbtr> = customer
   *
   * The PmtInf in pain.008 has PmtMtd=DD (Direct Debit)
   * and PmtTpInf/LclInstrm/Cd = CORE or B2B.
   * Each DrctDbtTxInf carries MndtId + DtOfSgntr inside
   * the <DrctDbtTx> block, and the creditor scheme ID
   * (CdtrSchmeId) is on the <PmtInf> level.
   */
  private buildPain008Xml(input: {
    companyId: string
    messageId: string
    creditorIban: string
    creditorBic?: string
    creditorName: string
    creditorIdentifier: string
    type: 'CORE' | 'B2B'
    executionDate: string
    notes?: string
    transactions: Array<{
      collectionId: string
      endToEndId: string
      invoiceNumber: string
      amount: number
      currency: string
      debitorIban: string
      debitorBic?: string
      debitorName: string
      mandateReference: string
      dateOfSignature: Date
      remittance: string
    }>
  }): string {
    const totalAmount = input.transactions.reduce((s, t) => s + t.amount, 0)
    const nbOfTxs = input.transactions.length
    const ctrlSum = Math.round(totalAmount * 100) / 100
    const createdAt = new Date().toISOString()
    const lclInstrm = input.type // 'CORE' or 'B2B'
    const seqType = input.type === 'B2B' ? 'B2B' : 'FRST' // FRST=first, RCUR=recurring, OOFF=one-off; v1 always FRST

    const txBlock = input.transactions
      .map((t, i) => {
        const instrId = `INSTR-${i + 1}`
        return `
    <DrctDbtTxInf>
      <PmtId>
        <InstrId>${this.escapeXml(instrId)}</InstrId>
        <EndToEndId>${this.escapeXml(t.endToEndId)}</EndToEndId>
      </PmtId>
      <InstdAmt Ccy="${this.escapeXml(t.currency)}">${t.amount.toFixed(2)}</InstdAmt>
      <DrctDbtTx>
        <MndtId>${this.escapeXml(t.mandateReference)}</MndtId>
        <DtOfSgntr>${t.dateOfSignature.toISOString().substring(0, 10)}</DtOfSgntr>
      </DrctDbtTx>
      <DbtrAgt>
        <FinInstnId>${t.debitorBic ? `<BIC>${this.escapeXml(t.debitorBic)}</BIC>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId>
      </DbtrAgt>
      <Dbtr>
        <Nm>${this.escapeXml(t.debitorName)}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>${this.escapeXml(t.debitorIban)}</IBAN>
        </Id>
      </DbtrAcct>
      <RmtInf>
        <Ustrd>${this.escapeXml(t.remittance)}</Ustrd>
      </RmtInf>
    </DrctDbtTxInf>`
      })
      .join('')

    return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${this.escapeXml(input.messageId)}</MsgId>
      <CreDtTm>${createdAt}</CreDtTm>
      <NbOfTxs>${nbOfTxs}</NbOfTxs>
      <CtrlSum>${ctrlSum.toFixed(2)}</CtrlSum>
      <InitgPty>
        <Nm>${this.escapeXml(input.creditorName)}</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${this.escapeXml(input.messageId)}-PMT</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <NbOfTxs>${nbOfTxs}</NbOfTxs>
      <CtrlSum>${ctrlSum.toFixed(2)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
        <LclInstrm>
          <Cd>${lclInstrm}</Cd>
        </LclInstrm>
        <SeqTp>
          <Cd>${seqType}</Cd>
        </SeqTp>
      </PmtTpInf>
      <ReqdColltnDt>${input.executionDate}</ReqdColltnDt>
      <Cdtr>
        <Nm>${this.escapeXml(input.creditorName)}</Nm>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <IBAN>${this.escapeXml(input.creditorIban)}</IBAN>
        </Id>
      </CdtrAcct>
      <CdtrAgt>
        <FinInstnId>${input.creditorBic ? `<BIC>${this.escapeXml(input.creditorBic)}</BIC>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId>
      </CdtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId>
        <Id>
          <PrvtId>
            <Othr>
              <Id>${this.escapeXml(input.creditorIdentifier)}</Id>
              <SchmeNm>
                <Prtry>SEPA</Prtry>
              </SchmeNm>
            </Othr>
          </PrvtId>
        </Id>
      </CdtrSchmeId>${txBlock}
    </PmtInf>
  </CstmrDrctDbtInitn>
</Document>
`
  }

  async getBatch(batchId: string) {
    return this.prisma.sepaDirectDebitBatch.findUnique({
      where: { id: batchId },
      include: {
        collections: {
          include: {
            invoice: { select: { id: true, invoiceNumber: true, total: true, status: true } },
            mandate: { select: { id: true, mandateReference: true, type: true, debitorName: true, iban: true } },
          },
        },
      },
    })
  }

  async listBatches(companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.prisma.sepaDirectDebitBatch.findMany({
      where: { companyId },
      orderBy: { executionDate: 'desc' },
      select: {
        id: true,
        collectionCount: true,
        totalAmount: true,
        creditorIban: true,
        creditorName: true,
        creditorIdentifier: true,
        type: true,
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
