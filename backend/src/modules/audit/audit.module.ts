import { Module } from '@nestjs/common'
import { AuditController } from './audit.controller'
import { AuditService } from './audit.service'
import { PrismaModule } from '../../prisma/prisma.module'

/**
 * Tier 67: Audit-Trail read API.
 *
 * Read-only view over the auto-populated AuditLog
 * table (writes happen via prisma/audit-log.extension.ts
 * on every update/delete of a GoBD-relevant model).
 *
 * Exports: AuditService — kept for future modules
 * that want to embed audit summaries (e.g. the
 * customer detail page could show "letzte
 * Änderungen an diesem Kunden").
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  imports: [PrismaModule],
  exports: [AuditService],
})
export class AuditModule {}
