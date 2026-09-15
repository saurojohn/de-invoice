import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withAuditLog } from './audit-log.extension';

// The audit request context lives in ./request-context (Tier 384).

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
})

// Apply the audit log extension. The
// extension wraps update/updateMany/delete/
// deleteMany on a fixed list of business
// models and writes an AuditLog row for
// each. See audit-log.extension.ts for the
// full list and rationale.
const prismaWithAudit = withAuditLog(basePrisma)

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name)

  // The Nest DI graph hands other services
  // `this` (the PrismaService). They call
  // `this.customer.findMany(...)` etc. We
  // need those calls to flow through the
  // audit-log extension, not the base
  // PrismaClient. We do this by replacing
  // the prototype's model accessors to
  // forward to the extended client.
  //
  // This is a bit of a hack but it's the
  // idiomatic Prisma pattern for client
  // extensions + NestJS. The alternative
  // (making every service depend on a
  // different PrismaService subclass) is
  // much more invasive.
  //
  // The index signature below tells
  // TypeScript that `this.foo` is valid
  // for any string `foo` (matches how
  // PrismaClient's `this.customer` etc.
  // work). The actual properties are
  // assigned in onModuleInit() at
  // runtime, so the type system can't
  // know about them statically.

  async onModuleInit() {
    await basePrisma.$connect()
    // Copy model accessors from the extended
    // client to `this`. We do this at
    // module-init time, not at constructor
    // time, so we don't lose the PrismaClient
    // base class methods ($connect, $transaction,
    // etc.).
    const ext = prismaWithAudit as any
    for (const model of Object.keys(ext)) {
      // Skip internal $... methods
      if (model.startsWith('$')) continue
       
      ;(this as any)[model] = ext[model]
    }
  }

  async onModuleDestroy() {
    await basePrisma.$disconnect()
  }
}
