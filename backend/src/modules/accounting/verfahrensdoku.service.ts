import { Injectable, NotFoundException } from '@nestjs/common'
import * as fs from 'fs/promises'
import * as path from 'path'
import { PrismaService } from '../../prisma/prisma.service'
import { markdownToDocx } from '../../common/markdown-docx'
import { resolveGewinnermittlung } from '../company/gewinnermittlung'
import { resolveRechtsform } from '../company/rechtsform'
import { BUNDESLAND_NAMEN } from '../../common/steuernummer'

/**
 * Tier 748 — the Verfahrensdokumentation of a company, as a Word file.
 *
 * The template (assets/verfahrensdokumentation.md) says what the program does;
 * spec 463 keeps it true. What the program knows about the company goes in
 * here: name, legal form, tax numbers, how the profit is determined, who has
 * which role, how mail goes out, up to when the books are closed. What only the
 * company knows stays [Auszufüllen], and is highlighted in the file. The
 * template used to be a file in the repository, which no company could reach.
 *
 * The file is a starting point, not a record: the company keeps its own
 * versions (GoBD Rz. 154), so nothing is stored here.
 */
const TEMPLATE = path.resolve(__dirname, '..', '..', '..', 'assets', 'verfahrensdokumentation.md')
const TO_FILL = '**[Auszufüllen]**'
const de = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('.')
/** a table cell of the company's own text: no line break, no column */
const cell = (v: string | null | undefined) => (v && v.trim() ? v.trim().replace(/\s+/g, ' ').replace(/\|/g, '/') : TO_FILL)

const ROLE_NAMES: Record<string, string> = {
  admin: 'Administrator',
  accountant: 'Buchhalter',
  berater: 'Steuerberater',
  viewer: 'Lesezugriff',
  auditor: 'Betriebsprüfer',
}

@Injectable()
export class VerfahrensdokuService {
  constructor(private readonly prisma: PrismaService) {}

  /** The template with the company's details. */
  async markdown(companyId: string, now = new Date()): Promise<string> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    const [members, ownMail, cashEntries, vouchers, assets] = await Promise.all([
      this.prisma.userCompany.groupBy({ by: ['role'], where: { companyId, user: { status: 'active' } }, _count: { _all: true } }),
      this.prisma.mailConfig.findUnique({ where: { companyId }, select: { enabled: true, smtpHost: true } }),
      this.prisma.cashBookEntry.count({ where: { companyId } }),
      this.prisma.voucher.count({ where: { companyId } }),
      this.prisma.asset.count({ where: { companyId } }),
    ])
    const name = company.legalName || company.name
    const address = (company.address ?? {}) as { street?: string; postalCode?: string; city?: string; country?: string }
    const place = [address.street, [address.postalCode, address.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    const gewinn = resolveGewinnermittlung(company as any)
    const roles = members
      .map((m) => `${m._count._all} ${ROLE_NAMES[m.role] ?? m.role}`)
      .sort()
      .join(', ')
    const rows: Array<[string, string | null | undefined]> = [
      ['Firma', name],
      ['Rechtsform', resolveRechtsform(company as any).rechtsform],
      ['Anschrift', place],
      ['Steuernummer', company.taxId],
      ['USt-IdNr.', company.vatId],
      ['Finanzamt im Land', company.bundesland ? BUNDESLAND_NAMEN[company.bundesland as keyof typeof BUNDESLAND_NAMEN] : null],
      ['Handelsregister', company.registerEntry],
      ['Geschäftsführung', company.managingDirector],
      ['Gewinnermittlung', gewinn.art === 'bilanz' ? 'Bilanz (§ 4 Abs. 1, § 5 EStG)' : 'Einnahmen-Überschuss-Rechnung (§ 4 Abs. 3 EStG)'],
      ['Umsatzsteuer', company.besteuerungsart === 'ist' ? 'Ist-Versteuerung' : 'Soll-Versteuerung'],
      ['Kleinunternehmer (§ 19 UStG)', company.defaultVatMode === 'kleinunternehmer' ? 'ja' : 'nein'],
      ['One-Stop-Shop', company.ossVerfahren ? 'ja' : 'nein'],
      ['Zugänge im Programm', roles],
      ['E-Mail-Versand', ownMail?.enabled && ownMail.smtpHost ? 'über den eigenen SMTP-Server der Firma' : 'über den Mailserver der Installation'],
      ['Bücher festgeschrieben bis', company.booksClosedUntil ? de(company.booksClosedUntil) : 'noch nicht'],
      ['Im Programm genutzt', `Kassenbuch: ${cashEntries ? 'ja' : 'nein'}, Buchungsbelege: ${vouchers ? 'ja' : 'nein'}, Anlagenverzeichnis: ${assets ? 'ja' : 'nein'}`],
    ]
    const table = [
      '| Angabe | Stand ' + de(now) + ' |',
      '|---|---|',
      ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
      '',
      `> ${TO_FILL} Art des Geschäfts, ungefähre Zahl der Belege im Jahr, steuerlicher Berater.`,
    ].join('\n')

    let text = await fs.readFile(TEMPLATE, 'utf8')
    text = text.replace(/<!-- firma -->[\s\S]*?<!-- \/firma -->/, () => table)
    text = text.replace('# Verfahrensdokumentation de-invoice (Vorlage)', () => `# Verfahrensdokumentation ${cell(name)}`)
    // the two paragraphs that address the reader of a template
    text = text.replace(/Diese Vorlage beschreibt, was das Programm de-invoice tatsächlich tut\.[\s\S]*?sollten mit dem Steuerberater besprochen werden\. Die Vorlage ersetzt keine\nsteuerliche Beratung\./, () =>
      `Diese Dokumentation beschreibt das Verfahren der Buchführung von ${cell(name)} mit dem Programm de-invoice. ` +
      `Sie wurde am ${de(now)} aus dem Programm erzeugt: Die Angaben über das Programm und die Firma stehen fest; die gelb markierten Stellen ` +
      'ergänzt das Unternehmen. Abschnitt 7 nennt die Grenzen des Programms; er ist mit dem Steuerberater zu besprechen. ' +
      'Diese Fassung ersetzt keine steuerliche Beratung.\n\n> **[Auszufüllen]** … hier trägt das Unternehmen seine Angaben ein.')
    // The template names where each statement is in the code, for spec 463. A
    // company's document is read by a Steuerberater and an auditor.
    text = text.replace(/\s*\((?:`[^`]+`(?:,\s*)?)+\)/g, '')
    text = text.replace('<!-- erzeugt -->', () => `| | ${de(now)} | Für ${cell(name)} aus dem Programm erzeugt | **[Auszufüllen]** |`)
    return text
  }

  async docx(companyId: string): Promise<{ buffer: Buffer; filename: string }> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true, legalName: true } })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    const safe = (company.legalName || company.name).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60)
    return {
      buffer: await markdownToDocx(await this.markdown(companyId)),
      filename: `Verfahrensdokumentation-${safe}-${new Date().toISOString().slice(0, 10)}.docx`,
    }
  }
}
