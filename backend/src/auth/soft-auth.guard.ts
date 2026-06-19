/**
 * Soft variant of HeaderAuthGuard — attaches the user
 * to req.user if the x-user-id and x-company-id headers
 * are present and valid, but lets the request through
 * regardless. Used for routes that should work
 * pre-auth (e.g. capturing a frontend error from the
 * login page, where the user isn't logged in yet but
 * a crash is still worth recording).
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class SoftAuthGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp()
    const req = http.getRequest()

    const userId = req.headers['x-user-id'] as string | undefined
    const companyId = req.headers['x-company-id'] as string | undefined

    // No headers? That's fine for a public route. Just
    // return true and let downstream code use nulls.
    if (!userId || !companyId) {
      return true
    }

    // Headers present — try to attach the user. If
    // invalid (stale token, etc.) we still let the
    // request through with user=null rather than 401.
    // The route handler will store the error event
    // with userId=null, which is fine.
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, companyId: true, role: true, status: true },
      })
      if (user && user.companyId === companyId && user.status === 'active') {
        req.user = user
      }
    } catch {
      // Swallow — never break the route on auth lookup
    }
    return true
  }
}
