import { Global, Module } from '@nestjs/common';
import { UserSessionService } from './user-session.service';
import { SessionCleanupScheduler } from './session-cleanup.scheduler';
import { AdminModule } from '../modules/admin/admin.module';

/**
 * Tier 400 — global, like PrismaModule: HeaderAuthGuard and SoftAuthGuard are
 * constructed in many modules (StorageModule, UsersModule, …) and all of them
 * need to resolve the session service. Without this the app fails to boot with
 * "Nest can't resolve dependencies of the HeaderAuthGuard".
 */
@Global()
@Module({
  // Tier 403: AdminModule exports CronHealthService, which the cleanup
  // scheduler wraps its tick in so the admin dashboard sees the run.
  imports: [AdminModule],
  providers: [UserSessionService, SessionCleanupScheduler],
  exports: [UserSessionService],
})
export class UserSessionModule {}
