import { Module, Global } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { PrismaModule } from "../../prisma/prisma.module"
import { ErrorTrackingService } from "./error-tracking.service"
import { NotificationService } from "./notification.service"
import { SystemController } from "./system.controller"
import { SystemHealthController } from "./system-health.controller"
import { GlobalExceptionFilter } from "./system.filter"

@Global()
@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [SystemController, SystemHealthController],
  providers: [
    ErrorTrackingService,
    NotificationService,
    GlobalExceptionFilter,
  ],
  exports: [ErrorTrackingService, NotificationService, GlobalExceptionFilter],
})
export class SystemModule {}
