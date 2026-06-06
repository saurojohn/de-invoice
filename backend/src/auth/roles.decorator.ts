import { SetMetadata, createParamDecorator, ExecutionContext, applyDecorators, UseGuards } from '@nestjs/common';
import { UsersService } from '../modules/users/users.service';
import { HeaderAuthGuard } from './header-auth.guard';
import { RolesGuard } from './roles.guard';

/**
 * Method-level decorator: require the caller to have a role of at least
 * `action` (which maps to a permission code in UsersService.PERMISSIONS).
 *
 * Usage:
 *   @Get()
 *   @Require('invoice.read')     // any logged-in user with view perms
 *   async list() { ... }
 *
 *   @Post()
 *   @Require('invoice.create')   // accountant or admin
 *   async create() { ... }
 *
 *   @Delete(':id')
 *   @Require('invoice.delete')   // accountant or admin
 *   async delete() { ... }
 */
export const REQUIRE_KEY = 'require:action'
export const Require = (action: keyof typeof UsersService.prototype | string) =>
  SetMetadata(REQUIRE_KEY, action)

/**
 * Convenience decorator: combine HeaderAuthGuard + RolesGuard so a
 * single annotation sets up the whole auth stack.
 *
 * Usage at controller level:
 *   @Controller('invoices')
 *   @Auth()                      // <-- adds both guards
 *   export class InvoiceController { ... }
 *
 * Then every route needs a @Require('xxx') decorator for permission
 * enforcement. Routes without @Require are still authenticated but
 * not subject to role checks (use sparingly).
 */
export const Auth = () => applyDecorators(UseGuards(HeaderAuthGuard, RolesGuard))

/**
 * Resolver: pull the caller's role out of the request — for use in
 * service classes that need to know who is calling (e.g. to record
 * `createdById` on a row).
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest()
    return req.user
  },
)
