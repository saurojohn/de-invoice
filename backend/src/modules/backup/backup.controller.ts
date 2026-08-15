/**
 * BackupController — Tier 120 admin backup management.
 *
 * REST surface for the backup dashboard. Five endpoints:
 *
 *   GET    /api/v1/admin/backups
 *     → all known backups (newest-first). The UI renders
 *       this as a table with size/age/has-db/has-att.
 *
 *   POST   /api/v1/admin/backups/run
 *     → trigger a manual backup. Awaits completion
 *       (the script takes 30s-5min). Returns the new
 *       stage dir + size + duration + last 200 lines
 *       of the script log.
 *
 *   POST   /api/v1/admin/backups/:id/verify
 *     → run pg_restore --list against the backup file.
 *       Returns {valid, tableCount, error?}. The UI
 *       shows a green check + table count on success,
 *       a red X with the error message on failure.
 *
 *   POST   /api/v1/admin/backups/restore-drill
 *     → Tier 195 — sanity-check that the most-recent
 *       backup actually restores. We spin up a
 *       throwaway database `de_invoice_restore_drill`,
 *       run `pg_restore` into it, count the tables,
 *       then DROP the database. The operator's
 *       production DB is never touched.
 *       Returns {ok, dbName, tableCount, error?}.
 *
 *   DELETE /api/v1/admin/backups/:id
 *     → delete a specific backup. The auto-backup cron
 *       re-creates fresh ones; this is for the operator
 *       who wants to free disk now.
 *
 * All endpoints require `admin.read` (same rank as
 * cron-health). Tier 119.5 added the role assignment
 * to Berater + Mandant in users.service.ts.
 */
import { Controller, Delete, Get, HttpCode, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { Auth, Require } from '../../auth/roles.decorator'
import { BackupService } from './backup.service'

@Auth()
@Controller('admin/backups')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get()
  @Require('admin.read')
  async list() {
    const items = await this.backup.list()
    const newest = items[0] ?? null
    return {
      items,
      newest,
      health: BackupService.healthColor(newest),
      backupRoot: this.backup['backupRoot'] as string,
    }
  }

  // Action endpoint, not a resource creation. Return
  // 200 OK (the default for POST is 201 Created, which
  // would mislead callers — no resource is "created"
  // here, the script just runs).
  @Post('run')
  @HttpCode(200)
  @Require('admin.read')
  async run() {
    return this.backup.runBackup()
  }

  @Post(':id/verify')
  @HttpCode(200)
  @Require('admin.read')
  async verify(@Param('id') id: string) {
    return this.backup.verify(id)
  }

  /**
   * Tier 195 — restore-drill. Picks the most recent
   * backup, restores it into a throwaway database,
   * counts the resulting tables, drops the database.
   * The production `de_invoice` DB is never touched.
   *
   * Use case: the operator wants assurance that the
   * last auto-backup actually works end-to-end (not
   * just that pg_restore --list parses the TOC).
   * Running a restore is the only true check.
   *
   * 200 → ok=true, tableCount > 0
   * 500 → ok=false with the error message (the
   *        throwaway DB is still dropped in the
   *        catch block so we don't leak it).
   */
  @Post('restore-drill')
  @HttpCode(200)
  @Require('admin.read')
  async restoreDrill() {
    return this.backup.restoreDrill()
  }

  @Delete(':id')
  @HttpCode(200)
  @Require('admin.read')
  async delete(@Param('id') id: string) {
    return this.backup.delete(id)
  }
}
