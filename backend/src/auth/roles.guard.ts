import { Injectable, CanActivate, ForbiddenException, Logger, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { UsersService } from '../modules/users/users.service'
import { REQUIRE_KEY } from './roles.decorator'

/**
 * Global role-based access guard. Reads the action required by the
 * route via @Reflector, then calls UsersService.can() to check whether
 * the caller's role grants that action.
 *
 * Pair with @Require('action') on the route handler, and @Auth() (or
 * @UseGuards(HeaderAuthGuard, RolesGuard)) at the controller level.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name)
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.get<string>(REQUIRE_KEY, context.getHandler())
    // No @Require = no role check beyond authentication. Allow.
    if (!action) return true

    const req = context.switchToHttp().getRequest()
    const role = req.user?.role
    if (!role) {
      // No authenticated user — for role-protected routes, treat as
      // forbidden (defence in depth).
      throw new ForbiddenException(`Unzureichende Berechtigung: ${action}`)
    }
    if (!UsersService.can(role, action as any)) {
      throw new ForbiddenException(`Unzureichende Berechtigung: ${action}`)
    }
    return true
  }
}
