import { withCheckedVatId } from '../../common/vat-id';
import { BadRequestException, Injectable } from '@nestjs/common';
import { assertIban } from '../../common/iban';
import { PrismaService } from '../../prisma/prisma.service';

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
    const taxId = typeof data.taxId === 'string' ? data.taxId.trim() : '';
    if (taxId) {
      const digits = taxId.replace(/[\s/]/g, '');
      if (!/^[0-9]{10,13}$/.test(digits)) {
        throw new BadRequestException(
          `Die Steuernummer ${taxId} ist ungültig — sie besteht aus 10 bis 13 Ziffern (z. B. 12/345/67890).`,
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
    return this.prisma.company.update({ where: { id }, data: withCheckedVatId(data) });
  }
}
