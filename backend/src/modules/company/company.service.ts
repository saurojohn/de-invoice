import { withCheckedVatId } from '../../common/vat-id';
import { elsterSteuernummerOrProblem } from '../../common/steuernummer';
import { isBareLegalForm, resolveRechtsform } from './rechtsform';
import { euerNotAllowedFor } from './gewinnermittlung';
import { BadRequestException, Injectable } from '@nestjs/common';
import { assertIban } from '../../common/iban';
import { PrismaService } from '../../prisma/prisma.service';
import { KU_SELECT, kuOn } from '../../common/kleinunternehmer-period';
import { businessTodayIso } from '../../common/business-date';
import { assertPeriodOpen } from '../reports/filed-period';
import { companySettingsTransaction } from '../../common/company-settings';

@Injectable()
export class CompanyService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.company.findUnique({ where: { id } });
  }

  async update(id: string, data: any) {
    // Tier 490: the company's own USt-IdNr. (on every invoice) normalised and checked
    // Tier 527: what every invoice prints — a name, a Steuernummer that can be
    // one, an IBAN that passes its check digit.
    if (data.name !== undefined && !String(data.name ?? '').trim()) {
      throw new BadRequestException('Der Name des Unternehmens darf nicht leer sein.');
    }
    if (typeof data.name === 'string') data = { ...data, name: data.name.trim() };
    // Tier 728: the full name as registered — not the legal form alone. The
    // settings labelled this field „Rechtsform“; „GmbH“ entered there became
    // the seller's registered name in the XRechnung (BT-27) and ZUGFeRD.
    if (typeof data.legalName === 'string') {
      const legal = data.legalName.trim()
      if (legal && isBareLegalForm(legal)) {
        throw new BadRequestException(
          `„${legal}“ ist eine Rechtsform, kein Firmenname. Tragen Sie den vollständigen Namen laut Handelsregister ein, z. B. „Muster Werkstatt GmbH“ — die Rechtsform selbst wählen Sie unter „Rechnungseinstellungen“.`,
        );
      }
      data = { ...data, legalName: legal };
    }
    const taxId = typeof data.taxId === 'string' ? data.taxId.trim() : '';
    if (taxId) {
      const digits = taxId.replace(/[\s/]/g, '');
      if (!/^[0-9]{10,13}$/.test(digits)) {
        throw new BadRequestException(
          `Die Steuernummer ${taxId} ist ungültig — sie besteht aus 10 bis 13 Ziffern (z. B. 12/345/67890).`,
        );
      }
    }
    // Tier 734: with the Land of the Finanzamt the Steuernummer must be one of
    // that Land — it becomes the 13-digit ELSTER number (common/steuernummer.ts).
    if ('bundesland' in data || 'taxId' in data) {
      const stored = await this.prisma.company.findUnique({ where: { id }, select: { taxId: true, bundesland: true } });
      const land = 'bundesland' in data ? data.bundesland : stored?.bundesland;
      const tax = 'taxId' in data ? taxId : stored?.taxId;
      if (land && tax) {
        const r = elsterSteuernummerOrProblem(tax, land);
        if ('problem' in r) throw new BadRequestException(r.problem);
      }
    }
    // Tier 774: a GmbH, an OHG, a KG… keeps books; the EÜR is not open to it
    if ('gewinnermittlung' in data || 'rechtsform' in data || 'legalName' in data || 'name' in data) {
      const stored = await this.prisma.company.findUnique({
        where: { id },
        select: { gewinnermittlung: true, rechtsform: true, settings: true, legalName: true, name: true },
      });
      const next = { ...(stored ?? {}), ...data } as Parameters<typeof resolveRechtsform>[0] & { gewinnermittlung?: string | null };
      const rf = resolveRechtsform(next).rechtsform;
      if (next.gewinnermittlung === 'euer' && euerNotAllowedFor(rf)) {
        throw new BadRequestException(
          `Eine ${rf} ist buchführungspflichtig (§ 238 HGB) und ermittelt ihren Gewinn durch Bilanz; die Einnahmen-Überschuss-Rechnung steht ihr nicht offen.`,
        );
      }
    }
    assertIban(data.bankInfo?.iban);
    // Tier 544: the logo is one of the files the logo upload wrote for this
    // company (a bare image file name) — not a path. See resolveLogoPath.
    // An unchanged value passes (the settings form sends the whole record
    // back; a row from before may hold the older 'images/<name>' form).
    const stored = typeof data.logoPath === 'string' && data.logoPath !== ''
      ? (await this.prisma.company.findUnique({ where: { id }, select: { logoPath: true } }))?.logoPath
      : null;
    if (typeof data.logoPath === 'string' && data.logoPath !== '' && data.logoPath !== stored) {
      const name = data.logoPath;
      const own = /^logo-([0-9a-f]{8})-/.exec(name);
      if (!/^[A-Za-z0-9._-]{1,200}\.(png|jpe?g|gif|webp)$/i.test(name) || name.includes('..') || (own && own[1] !== id.slice(0, 8))) {
        throw new BadRequestException('Das Logo wird über den Logo-Upload gesetzt — logoPath ist der Dateiname, den der Upload liefert.');
      }
    }
    // Tier 794: the preferences the settings page sends are three of many keys
    // in Company.settings — DATEV Berater-/Mandantennummer, the Hebesatz, the
    // KSt prepayments, the Anlage SO, the dunning stages… Written as they came,
    // every save of the settings page replaced the whole JSON with those three
    // (measured: {"datev":{…},"anlageV":true} became {"defaultCurrency":…}).
    // The keys sent are merged over the stored ones.
    // Tier 795: so are the keys of bankInfo — it also holds the Mahngebühren
    // and the Verzugszins (reminder.service setFeeConfig), which the settings
    // page does not send. Read and merged under the company's row lock, so a
    // writer of another key at the same time is not undone
    // (common/company-settings.ts).
    if ('defaultVatMode' in data || 'kleinunternehmerAb' in data || 'kleinunternehmerBis' in data) {
      data = await this.withKleinunternehmerPeriod(id, data);
    }
    const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    const merges = plain(data.settings) || plain(data.bankInfo)
    if (!merges) return this.prisma.company.update({ where: { id }, data: withCheckedVatId(data) });
    return companySettingsTransaction(this.prisma, id, async (tx) => {
      const own = await tx.company.findUnique({ where: { id }, select: { settings: true, bankInfo: true } })
      let next = data
      if (plain(data.settings)) next = { ...next, settings: { ...(plain(own?.settings) ? own.settings : {}), ...data.settings } }
      if (plain(data.bankInfo)) next = { ...next, bankInfo: { ...(plain(own?.bankInfo) ? own.bankInfo : {}), ...data.bankInfo } }
      return tx.company.update({ where: { id }, data: withCheckedVatId(next) })
    });
  }

  /**
   * Tier 842 — the Kleinunternehmerregelung by date (common/kleinunternehmer-period.ts).
   * Switching the mode used to turn the whole history over: every report read
   * today's mode for every period. Now the switch keeps the past as it was:
   *  - from Kleinunternehmer to another mode: § 19 applied up to yesterday
   *    (`kleinunternehmerBis`), unless a day is given — the day before the
   *    supply that crossed the 100 000 €, say;
   *  - to Kleinunternehmer from a mode that was chosen: § 19 from 1 January
   *    of this year (`kleinunternehmerAb`) — it is decided per calendar year —
   *    or from the day after an end in this year (a switch undone), unless a
   *    day is given; from no mode at all (a new company): since always.
   * What changes the past is refused in closed books or a filed period.
   */
  private async withKleinunternehmerPeriod(id: string, data: any) {
    const day = (v: unknown, name: string): Date | null => {
      if (v === null || v === '') return null
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v + 'T00:00:00Z').getTime())) {
        throw new BadRequestException(`${name} muss ein Datum (JJJJ-MM-TT) sein.`)
      }
      return new Date(v + 'T00:00:00Z')
    }
    const stored = await this.prisma.company.findUnique({ where: { id }, select: KU_SELECT })
    const out = { ...data }
    if ('kleinunternehmerAb' in data) out.kleinunternehmerAb = day(data.kleinunternehmerAb, 'Kleinunternehmer ab')
    if ('kleinunternehmerBis' in data) out.kleinunternehmerBis = day(data.kleinunternehmerBis, 'Kleinunternehmer bis')
    const wasKu = stored?.defaultVatMode === 'kleinunternehmer'
    const mode = 'defaultVatMode' in data ? data.defaultVatMode : stored?.defaultVatMode
    const willKu = mode === 'kleinunternehmer'
    const today = businessTodayIso()
    if (wasKu && !willKu && !('kleinunternehmerBis' in data)) {
      const y = new Date(today + 'T00:00:00Z')
      y.setUTCDate(y.getUTCDate() - 1)
      out.kleinunternehmerBis = y
    }
    if (!wasKu && willKu && stored?.defaultVatMode && !('kleinunternehmerAb' in data)) {
      // 1 January — or, when this year's period ended only now (a switch
      // undone), the day after it: no gap
      const jan1 = new Date(today.slice(0, 4) + '-01-01T00:00:00Z')
      const bis = 'kleinunternehmerBis' in out ? out.kleinunternehmerBis : stored?.kleinunternehmerBis
      const after = bis ? new Date(bis.getTime() + 24 * 3600 * 1000) : null
      out.kleinunternehmerAb = after && after > jan1 ? after : jan1
    }
    const next = {
      defaultVatMode: mode,
      kleinunternehmerAb: 'kleinunternehmerAb' in out ? out.kleinunternehmerAb : stored?.kleinunternehmerAb ?? null,
      kleinunternehmerBis: 'kleinunternehmerBis' in out ? out.kleinunternehmerBis : stored?.kleinunternehmerBis ?? null,
    }
    const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
    const ab = iso(next.kleinunternehmerAb)
    const bis = iso(next.kleinunternehmerBis)
    if (ab && bis && (willKu ? bis >= ab : bis < ab)) {
      throw new BadRequestException(willKu
        ? `„Kleinunternehmer bis“ (${bis}) gehört zu einem früheren Zeitraum und muss vor „Kleinunternehmer ab“ (${ab}) liegen.`
        : `„Kleinunternehmer bis“ (${bis}) liegt vor „Kleinunternehmer ab“ (${ab}).`)
    }
    // the first day the answer differs between before and after
    const before = kuOn(stored)
    const after = kuOn(next)
    const days = ['0001-01-01', ...(before.bounds ?? []), ...(after.bounds ?? [])].sort()
    const first = days.find((d) => before(d) !== after(d))
    if (first) {
      await assertPeriodOpen(this.prisma, id, [first === '0001-01-01' ? '1900-01-01' : first], 'das Ändern der Kleinunternehmerregelung')
    }
    return out
  }
}
