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
    // Tier 71: Read-Only Modus check.
    //
    // If the request is tagged as read-only (the
    // HeaderAuthGuard reads `x-readonly: 1`) and
    // the action is a *write* action (anything
    // not in the read-only allowlist), we 403.
    //
    // The allowlist is the canonical list of
    // action codes that DO NOT mutate state. Any
    // new "read" action must be added here, or
    // it will be 403'd in read-only mode.
    //
    // This is defence in depth: the UI also
    // hides / disables mutation buttons, but
    // a Steuerberater with the role "berater"
    // can still send a POST from a curl. The
    // guard is the authoritative check.
    if (req.user?.readonly) {
      // Read actions are allowed. Anything else
      // (create / update / delete / send / submit)
      // is a write and is blocked.
      //
      // The list mirrors the *.read actions
      // defined in UsersService.PERMISSIONS —
      // we keep it short and explicit so a new
      // permission added later is BLOCKED in
      // read-only mode until someone explicitly
      // adds it here. Fail-safe > fail-open.
      const READONLY_ALLOW = new Set<string>([
        'users.read',
        'invoice.read',
        'customer.read',
        'product.read',
        'accounting.read',
        'reports.read',
        'ustva.read',
        'audit.read',
        // Tier 376: read actions that were missing, so read-only mode
        // would have refused plain reads once these routes got @Require.
        'company.read',
        'expense.read',
        'payment.read',
        'admin.read',
        'berater.note.read',
      ])
      if (!READONLY_ALLOW.has(action)) {
        throw new ForbiddenException(
          `Read-Only Modus aktiv — Schreibvorgang "${action}" ist gesperrt`,
        )
      }
    }
    return true
  }
}
