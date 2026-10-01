import { withCheckedVatId } from '../../common/vat-id';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CompanyService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.company.findUnique({ where: { id } });
  }

  async update(id: string, data: any) {
    // Tier 490: the company's own USt-IdNr. (on every invoice) normalised and checked
    return this.prisma.company.update({ where: { id }, data: withCheckedVatId(data) });
  }
}
