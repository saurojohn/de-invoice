import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    
    return user;
  }

  async register(data: { email: string; password: string; companyName: string }) {
    const hash = await bcrypt.hash(data.password, 10);
    
    const company = await this.prisma.company.create({
      data: { 
        name: data.companyName,
        address: { street: '', city: '', postalCode: '', country: 'DE' }
      },
    });
    
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash: hash,
        companyId: company.id,
        role: 'admin',
      },
    });
    
    return { company, user };
  }
}
