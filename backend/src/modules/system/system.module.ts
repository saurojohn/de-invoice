import { Module, Global } from "@nestjs/common"
import { PrismaModule } from "../../prisma/prisma.module"
import { ErrorTrackingService } from "./error-tracking.service"
import { SystemController } from "./system.controller"
import { SystemHealthController } from "./system-health.controller"
import { GlobalExceptionFilter } from "./system.filter"

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [SystemController, SystemHealthController],
  providers: [ErrorTrackingService, GlobalExceptionFilter],
  exports: [ErrorTrackingService, GlobalExceptionFilter],
})
export class SystemModule {}
