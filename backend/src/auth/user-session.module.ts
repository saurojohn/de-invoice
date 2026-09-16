import { Global, Module } from '@nestjs/common';
import { UserSessionService } from './user-session.service';

/**
 * Tier 400 — global, like PrismaModule: HeaderAuthGuard and SoftAuthGuard are
 * constructed in many modules (StorageModule, UsersModule, …) and all of them
 * need to resolve the session service. Without this the app fails to boot with
 * "Nest can't resolve dependencies of the HeaderAuthGuard".
 */
@Global()
@Module({
  providers: [UserSessionService],
  exports: [UserSessionService],
})
export class UserSessionModule {}
