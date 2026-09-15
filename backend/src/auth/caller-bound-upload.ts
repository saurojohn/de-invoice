import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface'

/** Body fields that name the acting user (GoBD author / uploader / importer). */
export const ACTOR_ID_KEYS = ['createdById', 'closedById', 'uploadedById', 'sentById', 'grantedById'] as const

/**
 * Throw 403 when a request body names a company other than the authenticated
 * one, or an actor other than the authenticated user. Empty values are left to
 * the handler. Shared by HeaderAuthGuard (JSON bodies) and CallerBoundUpload
 * (multipart bodies, which are parsed only after the guards have run).
 */
export function assertBodyBoundToCaller(
  body: unknown,
  companyId: string,
  userId: string,
  opts: { checkCompany?: boolean; actorKeys?: readonly string[] } = {},
): void {
  if (!body || typeof body !== 'object') return
  const b = body as Record<string, unknown>
  const empty = (v: unknown) => v === undefined || v === null || v === ''
  if (opts.checkCompany !== false && !empty(b.companyId) && b.companyId !== companyId) {
    throw new ForbiddenException('Kein Zugriff auf diese Firma (companyId im Body)')
  }
  for (const key of opts.actorKeys ?? ACTOR_ID_KEYS) {
    if (!empty(b[key]) && b[key] !== userId) {
      throw new ForbiddenException(`${key} muss der angemeldete Benutzer sein`)
    }
  }
}

/**
 * Runs after FileInterceptor, so req.body holds the multipart form fields.
 * Multipart forms also use `userId` for the importing user (bank statements).
 */
@Injectable()
export class CallerBoundBodyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest()
    const userId = req.user?.id
    const companyId = req.headers['x-company-id']
    if (!userId || typeof companyId !== 'string') {
      throw new ForbiddenException('Authentifizierung erforderlich')
    }
    assertBodyBoundToCaller(req.body, companyId, userId, { actorKeys: [...ACTOR_ID_KEYS, 'userId'] })
    return next.handle()
  }
}

/**
 * Tier 383: the only way a controller accepts a file upload.
 *
 * HeaderAuthGuard binds `companyId` and actor ids in the body to the caller,
 * but guards run before multer parses a multipart body — so every upload route
 * saw an empty body there and trusted the form's `companyId`. Measured: tenant
 * B's POST /attachments with the form field companyId=<A> and one of A's
 * invoices answered 201 and stored the file under company A; uploadedById=<B>
 * on A's upload was stored as the uploader; POST /storage/upload with
 * companyId=<A> wrote into A's directory. e2e 183 fails if a controller uses
 * FileInterceptor directly.
 */
export const CallerBoundUpload = (field: string, options?: MulterOptions) =>
  applyDecorators(UseInterceptors(FileInterceptor(field, options), CallerBoundBodyInterceptor))
