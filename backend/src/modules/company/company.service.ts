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
    return this.prisma.company.update({ where: { id }, data: withCheckedVatId(data) });
  }
}
