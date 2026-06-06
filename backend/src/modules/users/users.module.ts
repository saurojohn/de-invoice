import { Global, Module } from '@nestjs/common';
import { UsersController, InvitationsController } from './users.controller';
import { UsersService } from './users.service';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { HeaderAuthGuard } from '../../auth/header-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';

// Global so every other module can use the auth guards + UsersService
// without needing to import this module.
@Global()
@Module({
  imports: [MailModule, PrismaModule],
  controllers: [UsersController, InvitationsController],
  providers: [UsersService, HeaderAuthGuard, RolesGuard],
  exports: [UsersService, RolesGuard, HeaderAuthGuard],
})
export class UsersModule {}
