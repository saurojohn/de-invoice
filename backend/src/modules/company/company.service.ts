import { withCheckedVatId } from '../../common/vat-id';
import { elsterSteuernummerOrProblem } from '../../common/steuernummer';
import { isBareLegalForm, resolveRechtsform } from './rechtsform';
import { euerNotAllowedFor, gewinnermittlungOf, gewinnermittlungWechselOf, resolveGewinnermittlung } from './gewinnermittlung';
import { BadRequestException, Injectable } from '@nestjs/common';
import { assertIban } from '../../common/iban';
import { PrismaService } from '../../prisma/prisma.service';
import { KU_SELECT, kuOn } from '../../common/kleinunternehmer-period';
import { businessTodayIso } from '../../common/business-date';
import { refreshTaxOutOfPrice } from '../invoice/tax-out-of-price';
import { assertBooksOpen, assertPeriodOpen } from '../reports/filed-period';
import { companySettingsTransaction } from '../../common/company-settings';
import { ART_SELECT, artOn, wechselOf } from '../../common/besteuerungsart-period';
import { OSS_SELECT, ossOn, ossWechselOf } from '../../common/oss-period';

@Injectable()
export class CompanyService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.company.findUnique({ where: { id } });
  }

  async update(id: string, data: any) {
    // Tier 846: the body is the company's fields — a list, or nothing, reached
    // Prisma and answered 500. And `null` for a column that takes none is
    // „not given“ (@IsOptional() lets it through; measured:
    // `"defaultPaymentDays": null` answered 500).
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('Die Angaben zum Unternehmen fehlen.');
    }
    for (const k of ['invoiceNumberContinuous', 'defaultPaymentDays', 'ossVerfahren']) {
      if (data[k] === null) {
        data = { ...data };
        delete data[k];
      }
    }
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
    // Tier 908: a change of the Besteuerungsart applies from a month on
    if ('besteuerungsart' in data || 'besteuerungsartAb' in data) {
      data = await this.withBesteuerungsartWechsel(id, data);
    }
    // Tier 909: so does joining or leaving the OSS
    if ('ossVerfahren' in data || 'ossVerfahrenAb' in data) {
      data = await this.withOssWechsel(id, data);
    }
    // Tier 915: so does the way the profit is determined — by year
    if ('gewinnermittlung' in data || 'gewinnermittlungAb' in data) {
      data = await this.withGewinnermittlungWechsel(id, data);
    }
    const kuChanges = 'defaultVatMode' in data || 'kleinunternehmerAb' in data || 'kleinunternehmerBis' in data
    if (kuChanges) {
      data = await this.withKleinunternehmerPeriod(id, data);
    }
    // Tier 850: the invoices that owe their tax out of the price follow the period
    const saved = await this.saveCompany(id, data);
    if (kuChanges) await refreshTaxOutOfPrice(this.prisma, id);
    return saved;
  }

  /**
   * Tier 908 — Soll / Ist by date (common/besteuerungsart-period.ts). A change
   * applies from the first of a month (`besteuerungsartAb`, default the
   * current one); the months before keep the way they were taxed. A company
   * with nothing issued before that day changes as a whole, as before.
   */
  private async withBesteuerungsartWechsel(id: string, data: any) {
    const out = { ...data };
    delete out.besteuerungsartAb;
    const stored = await this.prisma.company.findUnique({ where: { id }, select: ART_SELECT });
    const before = stored?.besteuerungsart === 'ist' ? 'ist' : 'soll';
    const next = 'besteuerungsart' in data ? (data.besteuerungsart === 'ist' ? 'ist' : 'soll') : before;
    if (next === before) return out;
    const thisMonth = `${businessTodayIso().slice(0, 7)}-01`;
    const ab: string = data.besteuerungsartAb ?? thisMonth;
    if (!/^\d{4}-\d{2}-01$/.test(ab) || ab > thisMonth) {
      throw new BadRequestException(
        'Ein Wechsel der Besteuerungsart gilt ab dem Ersten eines Monats, der nicht in der Zukunft liegt (besteuerungsartAb: JJJJ-MM-01).',
      );
    }
    // the months from `ab` on are computed anew — not a filed one (also when
    // the setting changes as a whole)
    await assertPeriodOpen(this.prisma, id, [ab], 'den Wechsel der Besteuerungsart');
    const kept = wechselOf(stored).filter((w) => w.ab < ab);
    const earlier = await this.prisma.invoice.count({
      where: { companyId: id, issueDate: { lt: new Date(`${ab}T00:00:00Z`) }, status: { not: 'draft' } },
    });
    const settings = out.settings && typeof out.settings === 'object' && !Array.isArray(out.settings) ? out.settings : {};
    if (earlier === 0 && kept.length === 0) {
      out.settings = { ...settings, besteuerungsartWechsel: [] };
      return out;
    }
    const dayBefore = new Date(Date.parse(`${ab}T12:00:00Z`) - 86_400_000);
    const vorher = artOn(stored)(dayBefore);
    out.settings = { ...settings, besteuerungsartWechsel: [...kept, { ab, art: next, vorher }] };
    return out;
  }

  /**
   * Tier 909 — the OSS by date (common/oss-period.ts), as the Besteuerungsart
   * (Tier 908): a change applies from the first of a month (`ossVerfahrenAb`,
   * default the current one), not in a filed period; with nothing issued
   * before that day the setting changes as a whole.
   */
  private async withOssWechsel(id: string, data: any) {
    const out = { ...data };
    delete out.ossVerfahrenAb;
    const stored = await this.prisma.company.findUnique({ where: { id }, select: OSS_SELECT });
    const before = stored?.ossVerfahren === true;
    const next = 'ossVerfahren' in data ? data.ossVerfahren === true : before;
    if (next === before) return out;
    const thisMonth = `${businessTodayIso().slice(0, 7)}-01`;
    const ab: string = data.ossVerfahrenAb ?? thisMonth;
    if (!/^\d{4}-\d{2}-01$/.test(ab) || ab > thisMonth) {
      throw new BadRequestException(
        'Die Teilnahme am One-Stop-Shop beginnt oder endet am Ersten eines Monats, der nicht in der Zukunft liegt (ossVerfahrenAb: JJJJ-MM-01).',
      );
    }
    await assertPeriodOpen(this.prisma, id, [ab], 'den Wechsel beim One-Stop-Shop');
    const kept = ossWechselOf(stored).filter((w) => w.ab < ab);
    const earlier = await this.prisma.invoice.count({
      where: { companyId: id, issueDate: { lt: new Date(`${ab}T00:00:00Z`) }, status: { not: 'draft' } },
    });
    const settings = out.settings && typeof out.settings === 'object' && !Array.isArray(out.settings) ? out.settings : {};
    if (earlier === 0 && kept.length === 0) {
      out.settings = { ...settings, ossWechsel: [] };
      return out;
    }
    const dayBefore = new Date(Date.parse(`${ab}T12:00:00Z`) - 86_400_000);
    out.settings = { ...settings, ossWechsel: [...kept, { ab, on: next, vorher: ossOn(stored)(dayBefore) }] };
    return out;
  }

  /**
   * Tier 915 — the Gewinnermittlung by year (company/gewinnermittlung.ts). A
   * change applies from the first day of a year (`gewinnermittlungAb`,
   * default this one; at most the next — § 141 Abs. 2 AO: books from the year
   * after the Finanzamt's notice). The years before keep their method. With
   * nothing booked before that year the setting changes as a whole.
   */
  private async withGewinnermittlungWechsel(id: string, data: any) {
    const out = { ...data };
    delete out.gewinnermittlungAb;
    const stored = await this.prisma.company.findUnique({
      where: { id },
      select: { gewinnermittlung: true, rechtsform: true, settings: true, legalName: true, name: true },
    });
    const nextCompany = { ...(stored ?? {}), ...data, settings: stored?.settings };
    if (euerNotAllowedFor(resolveRechtsform(nextCompany).rechtsform)) return out; // a Kaufmann keeps books every year
    const thisYear = Number(businessTodayIso().slice(0, 4));
    const ab = data.gewinnermittlungAb ?? thisYear;
    if (!Number.isInteger(ab) || ab < 2000 || ab > thisYear + 1) {
      throw new BadRequestException(
        `Ein Wechsel der Gewinnermittlung gilt ab einem Wirtschaftsjahr — diesem oder dem nächsten (gewinnermittlungAb: ${thisYear} oder ${thisYear + 1}).`,
      );
    }
    const next = resolveGewinnermittlung(nextCompany).art;
    const vorher = gewinnermittlungOf(stored ?? {}, ab - 1).art;
    const kept = gewinnermittlungWechselOf(stored?.settings).filter((w) => w.ab < ab);
    const settings = out.settings && typeof out.settings === 'object' && !Array.isArray(out.settings) ? out.settings : {};
    if (next === vorher) {
      // back to the method of the year before: a change planned from `ab` on is dropped
      if (gewinnermittlungWechselOf(stored?.settings).length !== kept.length) out.settings = { ...settings, gewinnermittlungWechsel: kept };
      return out;
    }
    // the years from `ab` on are computed anew — not one whose books are closed
    await assertBooksOpen(this.prisma, id, [`${ab}-01-01`], 'den Wechsel der Gewinnermittlung');
    const before = new Date(`${ab}-01-01T00:00:00Z`);
    const [invoices, expenses] = await Promise.all([
      // Tier 916: supplied or invoiced before (supply-period.ts)
      this.prisma.invoice.count({
        where: {
          companyId: id, status: { not: 'draft' },
          OR: [{ issueDate: { lt: before } }, { deliveryDate: { lt: before } }, { servicePeriodEnd: { lt: before } }],
        },
      }),
      this.prisma.expense.count({ where: { companyId: id, invoiceDate: { lt: before } } }),
    ]);
    if (invoices + expenses === 0 && kept.length === 0) {
      out.settings = { ...settings, gewinnermittlungWechsel: [] };
      return out;
    }
    out.settings = { ...settings, gewinnermittlungWechsel: [...kept, { ab, art: next, vorher }] };
    return out;
  }

  private async saveCompany(id: string, data: any) {
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
