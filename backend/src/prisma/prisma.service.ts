import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithBufferedAudit, withAuditLog } from './audit-log.extension';
import { companyScope } from './company-scope.extension';
import { noteWrite } from '../common/shared-while-running';

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
// Tier 551: and, under it, the company-scope check (company-scope.extension.ts).
// Tier 788: and every write is counted, so a computation shared between
// requests is never one that began before a write (shared-while-running.ts).
const WRITE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])
const writeCounter = Prisma.defineExtension({
  name: 'writeCounter',
  query: {
    $allModels: {
      async $allOperations({ operation, args, query }) {
        const result = await query(args)
        if (WRITE_OPERATIONS.has(operation)) noteWrite()
        return result
      },
    },
  },
})
const prismaWithAudit = withAuditLog(basePrisma.$extends(writeCounter).$extends(companyScope) as unknown as PrismaClient)

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

    // Tier 406: transactions go through the extended client as well.
    //
    // The loop above skips every `$…` member, so `$transaction` stayed the one
    // PrismaService inherits — a second, unextended PrismaClient. In the
    // callback form its `tx` bypassed the audit extension, and eleven writes
    // (credit notes, recurring invoices, customer credit, merges, instalment
    // plans, portal payments, invitations, invoice deletion) left no AuditLog
    // row. The callback form also buffers those rows until the transaction
    // commits — see runWithBufferedAudit. The array form was already audited
    // (its promises come from the extended accessors, and a failed batch
    // rejects before any row is written); it now simply runs on the same
    // client and pool as everything else.
    const extTransaction = ext.$transaction.bind(ext)
    // Tier 788: a transaction's writes count again once it has committed —
    // a computation that began between a write and the commit read without it.
    ;(this as any).$transaction = (arg: any, options?: any) =>
      (typeof arg === 'function'
        ? runWithBufferedAudit(() => extTransaction(arg, options))
        : extTransaction(arg, options)
      ).finally(noteWrite)
  }

  async onModuleDestroy() {
    await basePrisma.$disconnect()
  }
}
