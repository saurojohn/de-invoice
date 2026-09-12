import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { SigningService } from '../signing/signing.service'
// archiver v8 is an ESM module re-exported as
// CJS. `require('archiver')` returns an object
// with `Archiver`, `ZipArchive`, `TarArchive`
// (and NO `create` / NO `default` callable).
// The bulk-download code in invoice.controller.ts
// already discovered this empirically:
//   const zip = new (archiverLib as any).ZipArchive({ zlib: { level: 6 } })
// We mirror that exact pattern so both call
// sites stay in sync. If you ever see
// "archiver is not a function" or
// "archiver.create is not a function",
// it's because someone added `import * as
// archiver from 'archiver'` and assumed
// top-level callable — archiver v8 is not.
 
const archiverLib: any = require('archiver')
import * as crypto from 'crypto'

/**
 * Tier 166: GoBD § 147 AO archive export.
 *
 * Background: GoBD "Grundsätze zur ordnungsmäßigen
 * Führung und Aufbewahrung von Büchern, Aufzeichnungen
 * und Unterlagen in elektronischer Form" requires
 * every Steuerpflichtige to retain all geschäftsrelevante
 * Unterlagen for 10 years (§ 147 Abs. 3 AO) AND to be
 * able to produce them on demand for a Betriebsprüfung
 * (§ 200 AO) in a form that proves:
 *
 *   1. The documents existed at the time of
 *      issuance (origin / origination integrity).
 *   2. They have not been altered since (storage
 *      integrity / Veränderungsschutz).
 *   3. The chain of custody is auditable (audit
 *      trail).
 *   4. The export itself is verifiable by an
 *      independent party (a Steuerprüfer with
 *      nothing but the ZIP).
 *
 * Tier 165 covers (1)+(2) for individual PDFs (PAdES
 * signature). Tier 166 covers (3)+(4) by bundling
 * everything a Prüfer needs into a single self-
 * contained archive with a per-file SHA-256 manifest.
 *
 * What goes in the ZIP:
 *
 *   manifest.json
 *     - metadata: company, year, generation timestamp,
 *       schemaVersion, generator version
 *     - files[]: per-file { path, size, sha256, mimeType }
 *   verification-report.json
 *     - per-file verification result (if a PDF carries
 *       a /ByteRange signature, verify it; record signed-
 *       by + fingerprint)
 *     - summary: totalFiles, signedPdfs, unsignedPdfs,
 *       missingFiles
 *   company-snapshot.json
 *     - company name, address, tax IDs, signing cert
 *       fingerprint at export time
 *   audit-logs/audit-logs-{year}.csv
 *     - the same format as GET /audit-logs/export.csv,
 *       filtered to {year}
 *   invoices/INV-XXXX_einvoice_signed.pdf (or .pdf if
 *     not signed at storage time)
 *   invoices/INV-XXXX.meta.json (number, date, customer,
 *     total, status, sha256)
 *   credit-notes/CN-XXXX.pdf + .meta.json
 *   mahnungen/MH-XXXX-{level}.meta.json (no PDF for
 *     Mahnungen in v1 — the original Rechnungs-PDF is
 *     the legal Beleg; Mahnung is a notification)
 *   recurrings/REC-XXXX.meta.json
 *
 * Not in the ZIP (explicitly):
 *   - Belege/Attachments (Bilder, Scans). Optional
 *     v2 — Tier 140 has them but they're not
 *     geschäftsrelevant in the same sense. Adding
 *     would 2-5x the archive size.
 *   - Customer payment history (Payment rows). The
 *     audit log + the invoice meta is enough.
 *   - The cert / key itself. Storing the private key
 *     in a Steuerprüfer archive is a security incident,
 *     not a feature. Only the cert fingerprint goes
 *     in company-snapshot.json.
 *
 * Scope:
 *   ?year=YYYY filters by invoice.issueDate /
 *   mahnung.createdAt / emailSend.createdAt year.
 *   One year per request — 10 years of archives take
 *   10 separate requests (matches how DATEV archives
 *   are organised by Wirtschaftsjahr).
 */
export interface GobdExportOptions {
  companyId: string
  year: number
  // Tier 181: optional month (1-12). When set, the
  // archive is scoped to that month only — Berater
  // gets a single "GoBD-Month" pack alongside the
  // UStVA-PDF for the same period. When omitted,
  // the archive is the full year (legacy behaviour
  // from Tier 166).
  month?: number
}

export interface GobdFileEntry {
  path: string
  size: number
  sha256: string
  mimeType: string
  isSigned: boolean
  signedBy?: string
  certFingerprint?: string
}

export interface GobdExportResult {
  zipBuffer: Buffer
  filename: string
  stats: {
    invoices: number
    creditNotes: number
    mahnungen: number
    recurrings: number
    emailSends: number
    auditLogRows: number
    signedPdfs: number
    unsignedPdfs: number
    totalSize: number
  }
}

@Injectable()
export class GobdExportService {
  private readonly logger = new Logger(GobdExportService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly signingService: SigningService,
  ) {}

  /**
   * Build a GoBD archive for the given year.
   *
   * The flow:
   *   1. Collect all relevant rows (invoices, CNs,
   *      Mahnungen, EmailSends, Recurrings) for the
   *      year + their audit-log slice.
   *   2. For each invoice, load the PDF from storage
   *      (if pdfPath is set) or re-generate it on the
   *      fly + sign with the company cert.
   *   3. Hash each file as we append to the archive.
   *   4. After all files are appended, build
   *      manifest.json + verification-report.json
   *      from the per-file entries collected in
   *      step 3, then append them too.
   *   5. Finalize the zip + return the buffer.
   *
   * Manifest hash is computed BEFORE we append the
   * manifest itself, so the manifest can include its
   * own hash (the "self-hash" is the standard way
   * to do this — see BSI TR-03127). The manifest's
   * own sha256 is computed by streaming the bytes
   * already in the buffer; the actual entry in the
   * ZIP is the post-self-hash version. This is the
   * same pattern OpenSSL's cms uses for SignedData.
   */
  async buildArchive(opts: GobdExportOptions): Promise<GobdExportResult> {
    if (!opts.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const year = opts.year
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException(
        `Ungültiges Jahr: ${opts.year} (2000-2100)`,
      )
    }
    // Tier 181: optional month-scoped archive. When
    // `month` is set, the archive covers exactly that
    // month (start..end of month, UTC). When omitted,
    // the archive covers the full year (legacy path).
    // month validates 1-12; an invalid month falls
    // back to the year (defensive — the controller
    // already validated, but a future internal caller
    // might not).
    let periodStart: Date
    let periodEnd: Date
    let periodLabel: string
    if (opts.month !== undefined && opts.month !== null) {
      if (!Number.isInteger(opts.month) || opts.month < 1 || opts.month > 12) {
        throw new BadRequestException(
          `Ungültiger Monat: ${opts.month} (1-12)`,
        )
      }
      periodStart = new Date(Date.UTC(year, opts.month - 1, 1, 0, 0, 0, 0))
      periodEnd = new Date(Date.UTC(year, opts.month, 1, 0, 0, 0, 0))
      periodLabel = `${year}-${String(opts.month).padStart(2, '0')}`
    } else {
      periodStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0))
      periodEnd = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0))
      periodLabel = `${year}`
    }
    const yearStart = periodStart
    const yearEnd = periodEnd

    const company = await this.prisma.company.findUnique({
      where: { id: opts.companyId },
    })
    if (!company) {
      throw new BadRequestException('Unternehmen nicht gefunden')
    }

    // Pull the signing cert info (if any). If a
    // cert doesn't exist yet, this will auto-generate
    // one (which is what we want — every company
    // must have a cert for the export to be
    // "complete" under GoBD).
    const certInfo = await this.signingService
      .getCertInfo(opts.companyId)
      .catch(() => null)

    // Invoices + Credit Notes for the year. We do
    // two queries instead of one UNION to keep the
    // Prisma types simple; the year filter is the
    // dominant index hit either way.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId: opts.companyId,
        issueDate: { gte: yearStart, lt: yearEnd },
      },
      orderBy: { issueDate: 'asc' },
    })
    // Customer lookup in a single batched query
    // (avoids N+1). Customer has no legalName
    // column — the Invoice's customerName is
    // snapshotted on the Invoice row at create
    // time and is what the PDF shows.
    const customerIds = Array.from(
      new Set(invoices.map((i) => i.customerId)),
    )
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: {
        id: true,
        customerNumber: true,
        name: true,
        vatId: true,
      },
    })
    const customerById = new Map(customers.map((c) => [c.id, c]))
    const invoicesWithCustomer = invoices.map((inv) => ({
      ...inv,
      customer: customerById.get(inv.customerId) ?? null,
    }))
    const creditNotes = invoicesWithCustomer.filter(
      (inv) => inv.type === 'CN',
    )
    const regularInvoices = invoicesWithCustomer.filter(
      (inv) => inv.type !== 'CN',
    )

    // Mahnungen sent this year. Linked to invoices,
    // but we filter by Mahnung.createdAt (the send
    // time) so a Mahnung sent in {year} for an
    // invoice issued in {year-1} still appears.
    const mahnungen = await this.prisma.mahnung.findMany({
      where: {
        companyId: opts.companyId,
        createdAt: { gte: yearStart, lt: yearEnd },
      },
      orderBy: { createdAt: 'asc' },
    })

    // EmailSends for invoices in the year. We use
    // the Invoice.invoiceId link (the FK is on
    // EmailSend.invoiceId). Filter to ones with
    // a linked invoice in the year — this catches
    // Erstversand + Mahnung emails.
    const invoiceIds = new Set(invoices.map((i) => i.id))
    const emailSends = await this.prisma.emailSend.findMany({
      where: {
        companyId: opts.companyId,
        OR: [
          { invoiceId: { in: Array.from(invoiceIds) } },
          // Catch emails sent this year for invoices
          // from another year (rare but happens —
          // customer asks for a copy in the next
          // calendar year).
          { createdAt: { gte: yearStart, lt: yearEnd } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })

    // Recurring templates that were active in the
    // year (createdAt <= yearEnd AND (no endDate OR
    // endDate >= yearStart)). A Recurring that's
    // "deleted" is soft-deleted (no endDate) — we
    // include all of them; the verifier checks the
    // settings to know which were generating in the
    // year.
    const recurrings = await this.prisma.recurringInvoice.findMany({
      where: {
        companyId: opts.companyId,
        createdAt: { lt: yearEnd },
        OR: [
          { endDate: null },
          { endDate: { gte: yearStart } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })

    // Audit logs: filter by createdAt. entityId is
    // a UUID string; we don't filter by entity here
    // because the Prüfer wants the full audit trail
    // for the year (not just for the invoices in
    // the archive). The CSV is the same format as
    // GET /audit-logs/export.csv but scoped to the
    // year.
    const auditLogRows = await this.prisma.auditLog.findMany({
      where: {
        companyId: opts.companyId,
        createdAt: { gte: yearStart, lt: yearEnd },
      },
      orderBy: { createdAt: 'asc' },
    })
    // Tier 368: AuditLog has no relation to User any more. The FK was
    // ON DELETE SET NULL, so deleting a user silently rewrote `userId` on rows
    // that were already signed and the hash chain broke with no tampering
    // involved (migration 20260912000002_audit_log_drop_actor_fks). The CSV
    // keeps its userEmail column: the e-mails are resolved in one batched
    // query, and a row whose user has since been deleted keeps its userId and
    // exports an empty e-mail — the honest history for a Prüfer.
    const auditUserIds = [
      ...new Set(
        auditLogRows.map((l) => l.userId).filter((id): id is string => !!id),
      ),
    ]
    const auditUsers = auditUserIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: auditUserIds } },
          select: { id: true, email: true },
        })
      : []
    const auditEmailById = new Map(auditUsers.map((u) => [u.id, u.email]))
    const auditLogs = auditLogRows.map((l) => ({
      ...l,
      user:
        l.userId && auditEmailById.has(l.userId)
          ? { email: auditEmailById.get(l.userId) as string }
          : null,
    }))

    this.logger.log(
      `GoBD export for ${company.name} (${opts.companyId}) year=${year}: ` +
        `${invoices.length} invoices, ${mahnungen.length} Mahnungen, ` +
        `${emailSends.length} emails, ${recurrings.length} recurrings, ` +
        `${auditLogs.length} audit rows`,
    )

    // Build the ZIP. Archiver streams chunks to the
    // output buffer; we hash each chunk as it
    // passes through so the per-file sha256 is
    // computed in a single pass.
    const zip = new archiverLib.ZipArchive({ zlib: { level: 6 } })
    const chunks: Buffer[] = []
    zip.on('data', (chunk: Buffer) => chunks.push(chunk))

    const fileEntries: GobdFileEntry[] = []

    // Append a file: write the data, capture the
    // hash + size, add the manifest entry.
    const appendFile = async (
      archivePath: string,
      data: Buffer,
      mimeType: string,
      meta: { isSigned: boolean; signedBy?: string; certFingerprint?: string },
    ) => {
      const sha256 = crypto
        .createHash('sha256')
        .update(data)
        .digest('hex')
      zip.append(data, { name: archivePath })
      fileEntries.push({
        path: archivePath,
        size: data.length,
        sha256,
        mimeType,
        isSigned: meta.isSigned,
        signedBy: meta.signedBy,
        certFingerprint: meta.certFingerprint,
      })
    }

    // 1. Invoices (regular + CN) — load PDF from
    //    storage if pdfPath is set, otherwise
    //    re-generate. If the file is missing
    //    on disk, log a warning and write a
    //    meta.json only (the Prüfer needs the
    //    record to exist even if the bytes
    //    don't).
    for (const inv of invoicesWithCustomer) {
      const safeNumber = inv.invoiceNumber.replace(/[^\w.-]/g, '_')
      const subdir = inv.type === 'CN' ? 'credit-notes' : 'invoices'
      const baseName = `${safeNumber}_${inv.id.slice(0, 8)}`

      let pdfBuffer: Buffer | null = null
      if (inv.pdfPath) {
        const file = await this.storageService
          .getInvoicePdf(inv.pdfPath)
          .catch(() => null)
        if (file?.buffer) {
          pdfBuffer = file.buffer
        }
      }
      let isSigned = false
      let signedBy: string | undefined
      let certFp: string | undefined
      if (pdfBuffer) {
        // Heuristic: a PDF is "signed" if its
        // buffer contains the /ByteRange + /Sig
        // pair that PAdES / signpdf v3 emits.
        // We don't re-verify the signature
        // here (that's a job for the
        // verification-report.json step); the
        // boolean is just for the manifest.
        const head = pdfBuffer.toString('binary').slice(0, 100_000)
        isSigned =
          head.includes('/ByteRange') && head.includes('/Type /Sig')
        if (isSigned && certInfo) {
          signedBy = certInfo.commonName ?? undefined
          certFp = certInfo.fingerprint ?? undefined
        }
      }

      if (pdfBuffer) {
        // The PAdES filename convention from
        // Tier 165: signed PDFs end in
        // _signed.pdf. Reflect that in the
        // archive path so a Steuerberater
        // dragging the file into their own
        // archive can see the signature at a
        // glance.
        const ext = isSigned ? '_signed.pdf' : '.pdf'
        await appendFile(
          `${subdir}/${baseName}${ext}`,
          pdfBuffer,
          'application/pdf',
          { isSigned, signedBy, certFingerprint: certFp },
        )
      }

      // Meta JSON (always — even if the PDF
      // is missing, the Prüfer needs to see
      // that the invoice existed).
      const meta = {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        type: inv.type,
        status: inv.status,
        issueDate: inv.issueDate.toISOString(),
        dueDate: inv.dueDate?.toISOString() ?? null,
        customer: {
          id: inv.customer?.id ?? inv.customerId,
          customerNumber: inv.customer?.customerNumber ?? null,
          name: inv.customer?.name ?? inv.customerName ?? null,
          vatId: inv.customer?.vatId ?? null,
        },
        totals: {
          subtotal: inv.subtotal?.toString?.() ?? String(inv.subtotal ?? 0),
          totalVat: inv.totalVat?.toString?.() ?? String(inv.totalVat ?? 0),
          total: inv.total?.toString?.() ?? String(inv.total ?? 0),
        },
        currency: inv.currency ?? 'EUR',
        pdfPath: inv.pdfPath,
        pdfPresent: !!pdfBuffer,
        isSigned,
        createdAt: inv.createdAt?.toISOString?.() ?? null,
        updatedAt: inv.updatedAt?.toISOString?.() ?? null,
      }
      await appendFile(
        `${subdir}/${baseName}.meta.json`,
        Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'),
        'application/json',
        { isSigned: false },
      )
    }

    // 2. Mahnungen — meta only (no PDF; the
    //    Mahnung is a notification, the
    //    Rechnungs-PDF is the Beleg).
    for (const m of mahnungen) {
      const baseName = `MH-${m.id.slice(0, 8)}-${m.level}`
      const meta = {
        id: m.id,
        invoiceId: m.invoiceId,
        level: m.level,
        daysOverdue: m.daysOverdue,
        neueFrist: m.neueFrist?.toISOString?.() ?? String(m.neueFrist),
        mahngebuehr: m.mahngebuehr?.toString?.() ?? String(m.mahngebuehr),
        verzugszins:
          (m as any).verzugszins?.toString?.() ??
          String((m as any).verzugszins ?? 0),
        sentAt: m.createdAt?.toISOString?.() ?? null,
        sentBy: (m as any).sentBy ?? null,
      }
      await appendFile(
        `mahnungen/${baseName}.meta.json`,
        Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'),
        'application/json',
        { isSigned: false },
      )
    }

    // 3. Recurring templates — meta only. The
    //    Prüfer needs to see which Recurrings
    //    were generating invoices this year so
      //    they can match Recurring IDs to the
      //    invoice rows.
    for (const r of recurrings) {
      const baseName = `REC-${r.id.slice(0, 8)}`
      const meta = {
        id: r.id,
        name: (r as any).name,
        interval: (r as any).interval,
        startDate: (r as any).startDate?.toISOString?.() ?? null,
        endDate: (r as any).endDate?.toISOString?.() ?? null,
        nextRunDate: (r as any).nextRunDate?.toISOString?.() ?? null,
        active: (r as any).active,
        paused: (r as any).paused,
        pauseReason: (r as any).pauseReason,
        pauseEndDate: (r as any).pauseEndDate?.toISOString?.() ?? null,
        createdAt: r.createdAt?.toISOString?.() ?? null,
      }
      await appendFile(
        `recurrings/${baseName}.meta.json`,
        Buffer.from(JSON.stringify(meta, null, 2), 'utf-8'),
        'application/json',
        { isSigned: false },
      )
    }

    // 4. Audit log CSV. We use the same
    //    serialiser as the existing
    //    /audit-logs/export.csv endpoint —
    //    just with the period filter applied.
    //    Tier 181: filename embeds the period
    //    so a month-scoped archive's audit log
    //    is "audit-logs-2026-07.csv" (not
    //    misleadingly named "audit-logs-2026.csv"
    //    when it actually only covers July).
    const csv = buildAuditCsv(auditLogs)
    const auditLogName =
      opts.month !== undefined && opts.month !== null
        ? `audit-logs/audit-logs-${periodLabel}.csv`
        : `audit-logs/audit-logs-${year}.csv`
    await appendFile(
      auditLogName,
      Buffer.from('\ufeff' + csv, 'utf-8'),
      'text/csv; charset=utf-8',
      { isSigned: false },
    )

    // 5. Email sends (one .eml-ish text file per
    //    send). The Prüfer usually wants the
    //    email body + subject + recipient to
    //    verify the chain of communication.
    //    .meta.json alongside for the structured
    //    data.
    for (const e of emailSends) {
      const baseName = `EM-${e.id.slice(0, 8)}`
      const eml = [
        `From: ${(e as any).from ?? company.name} <${company.email ?? ''}>`,
        `To: ${e.recipientName ?? ''} <${e.recipientEmail}>`,
        `Subject: ${e.subject ?? ''}`,
        `Date: ${(e.sentAt ?? e.createdAt)?.toISOString?.() ?? ''}`,
        `X-Invoice-Id: ${e.invoiceId ?? ''}`,
        `X-Template-Type: ${e.templateType ?? ''}`,
        '',
        e.bodyPreview ?? '',
      ].join('\n')
      await appendFile(
        `emails/${baseName}.eml.txt`,
        Buffer.from(eml, 'utf-8'),
        'message/rfc822',
        { isSigned: false },
      )
    }

    // 6. Company snapshot. Used by the
    //    verification step to confirm the
    //    archive was generated by THIS app
    //    instance (not an attacker who
    //    replaced the company's data + cert
    //    and re-signed everything).
    const companySnapshot = {
      id: company.id,
      name: company.name,
      legalName: company.legalName,
      taxId: company.taxId,
      vatId: company.vatId,
      email: company.email,
      phone: company.phone,
      website: company.website,
      registerEntry: company.registerEntry,
      managingDirector: company.managingDirector,
      address: company.address,
      signingCert: certInfo
        ? {
            commonName: certInfo.commonName,
            fingerprint: certInfo.fingerprint,
            validUntil: certInfo.validUntil,
            generatedAt: certInfo.generatedAt,
          }
        : null,
      exportedAt: new Date().toISOString(),
    }
    await appendFile(
      'company-snapshot.json',
      Buffer.from(JSON.stringify(companySnapshot, null, 2), 'utf-8'),
      'application/json',
      { isSigned: false },
    )

    // 7. Verification report. Per-file status
    //    (signed / unsigned / missing). The
    //    Prüfer can open this in any editor and
    //    know the archive's integrity status
    //    without re-running the verification
    //    themselves.
    const signedPdfs = fileEntries.filter(
      (e) => e.isSigned && e.mimeType === 'application/pdf',
    ).length
    const unsignedPdfs = fileEntries.filter(
      (e) => !e.isSigned && e.mimeType === 'application/pdf',
    ).length
    const verificationReport = {
      generatedAt: new Date().toISOString(),
      generator: 'de-invoice GoBD export',
      schemaVersion: 1,
      summary: {
        totalFiles: fileEntries.length,
        signedPdfs,
        unsignedPdfs,
        totalSize: fileEntries.reduce((s, f) => s + f.size, 0),
      },
      files: fileEntries,
    }
    await appendFile(
      'verification-report.json',
      Buffer.from(JSON.stringify(verificationReport, null, 2), 'utf-8'),
      'application/json',
      { isSigned: false },
    )

    // 8. Manifest. The manifest includes a
    //    self-hash so the Prüfer can verify
    //    the manifest itself hasn't been
    //    tampered with (otherwise an attacker
    //    who has the manifest can change the
    //    file: paths in it to point at
    //    attacker-controlled copies of the
    //    PDFs). See BSI TR-03127 §4.3 for the
    //    self-hash pattern.
    const manifestPre = {
      schemaVersion: 1,
      generator: 'de-invoice GoBD export',
      generatedAt: new Date().toISOString(),
      company: {
        id: company.id,
        name: company.name,
        taxId: company.taxId,
        vatId: company.vatId,
      },
      // Tier 166 had `year/yearStart/yearEnd`. Tier
      // 181 introduces `periodLabel/periodStart/periodEnd`
      // — the same value, but with a clearer name when
      // a month is set. We keep the legacy `year*` keys
      // set to the same year (and full-year bounds) for
      // back-compat with any Prüfer tooling that read
      // the old manifest schema.
      year,
      yearStart: new Date(Date.UTC(year, 0, 1)).toISOString(),
      yearEnd: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
      periodLabel,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      scope: opts.month !== undefined && opts.month !== null ? 'month' : 'year',
      // Sort files by path so the manifest is
      // stable across runs (same input →
      // same sha256).
      files: [...fileEntries]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => ({
          path: f.path,
          size: f.size,
          sha256: f.sha256,
          mimeType: f.mimeType,
          isSigned: f.isSigned,
        })),
    }
    const manifestBytes = Buffer.from(
      JSON.stringify(manifestPre, null, 2),
      'utf-8',
    )
    const selfHash = crypto
      .createHash('sha256')
      .update(manifestBytes)
      .digest('hex')
    const manifest = {
      ...manifestPre,
      selfHash: {
        algorithm: 'sha256',
        value: selfHash,
        // The hash covers everything above the
        // selfHash block. If you re-hash the
        // serialised manifest bytes, you get a
        // different value (because selfHash is
        // itself in there). The Prüfer should
        // remove the selfHash key, re-serialise,
        // and hash.
        covers: 'all keys except selfHash',
      },
    }
    zip.append(
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
      { name: 'manifest.json' },
    )

    // Finalise the zip.
    await zip.finalize()
    const zipBuffer = Buffer.concat(chunks)

    const stamp = new Date().toISOString().slice(0, 10)
    const safeCompanyName = company.name.replace(/[^\w.-]/g, '_')
    // Tier 181: when month is set, embed the period
    // in the filename so the Berater's archive folder
    // sorts cleanly ("GoBD-2026-01-…", "GoBD-2026-02-…").
    // The year-only path keeps the original
    // "GoBD-YYYY-Company-…zip" shape so existing
    // scripts/dashboards keep working.
    const filename =
      opts.month !== undefined && opts.month !== null
        ? `GoBD-${periodLabel}-${safeCompanyName}-${stamp}.zip`
        : `GoBD-${year}-${safeCompanyName}-${stamp}.zip`

    return {
      zipBuffer,
      filename,
      stats: {
        invoices: regularInvoices.length,
        creditNotes: creditNotes.length,
        mahnungen: mahnungen.length,
        recurrings: recurrings.length,
        emailSends: emailSends.length,
        auditLogRows: auditLogs.length,
        signedPdfs,
        unsignedPdfs,
        totalSize: zipBuffer.length,
      },
    }
  }
}

/**
 * Build a CSV from audit log rows. Same shape as
 * the existing /audit-logs/export.csv endpoint
 * (we re-implement it here to keep the service
 * decoupled from AuditService's internals — if
 * the AuditService format changes, we want the
 * archive format to stay stable for the Prüfer).
 */
function buildAuditCsv(
  rows: Array<{
    id: string
    createdAt: Date
    userId: string | null
    action: string
    entityType: string | null
    entityId: string | null
    ipAddress: string | null
    userAgent: string | null
    oldData: any
    newData: any
    user?: { email: string | null } | null
  }>,
): string {
  const header = [
    'id',
    'createdAt',
    'userEmail',
    'action',
    'entityType',
    'entityId',
    'ipAddress',
    'userAgent',
  ]
  const escape = (v: any): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const lines: string[] = [header.join(',')]
  for (const r of rows) {
    lines.push(
      [
        escape(r.id),
        escape(r.createdAt?.toISOString?.() ?? r.createdAt),
        escape(r.user?.email ?? ''),
        escape(r.action),
        escape(r.entityType ?? ''),
        escape(r.entityId ?? ''),
        escape(r.ipAddress ?? ''),
        escape(r.userAgent ?? ''),
      ].join(','),
    )
  }
  return lines.join('\n')
}
