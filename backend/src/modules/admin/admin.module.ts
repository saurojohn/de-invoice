/**
 * AdminModule — Tier 119 system health monitoring.
 *
 * Provides:
 *   - CronHealthService: write + read the CronHealth
 *     table. Imported by every scheduler that wants
 *     to be visible on the admin health page.
 *   - CronHealthController: REST endpoints for the
 *     admin dashboard.
 *   - CronHealthScheduler: nightly cleanup of old
 *     CronHealth rows.
 *
 * The module is deliberately small — admin features
 * (per-company health, alert subscriptions, etc.)
 * will go here as the suite grows.
 */
import { Module } from '@nestjs/common'
import { CronHealthService } from './cron-health.service'
import { CronHealthController } from './cron-health.controller'
import { CronHealthScheduler } from './cron-health.scheduler'
// Tier 202 — AdminModule needs the
// AuditService so CronHealthController
// can record `cron.run_manually`
// activity events.
import { AuditModule } from '../audit/audit.module'

@Module({
  imports: [AuditModule],
  controllers: [CronHealthController],
  providers: [CronHealthService, CronHealthScheduler],
  exports: [CronHealthService],
})
export class AdminModule {}
