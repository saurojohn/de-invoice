/**
 * Global NestJS exception filter — captures every
 * unhandled error from any route into ErrorEvent
 * (the self-hosted Sentry) before responding to
 * the client.
 *
 * Why a global filter instead of per-route try/catch:
 *   - One place to add the capture
 *   - Catches errors in middleware, guards, interceptors
 *   - Preserves the original response shape (HTTP code
 *     + JSON body) so frontend error handling is unchanged
 *
 * The filter logs the error via Nest's built-in logger
 * (console) AND persists to ErrorEvent (DB). Console
 * output is for development; DB is for production
 * inspection via the dashboard.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common"
import { Request, Response } from "express"
import { ErrorTrackingService } from "./error-tracking.service"

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name)

  constructor(private readonly tracker: ErrorTrackingService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<Response>()
    const req = ctx.getRequest<Request>()

    // HttpException is a "controlled" error (e.g. 400
    // BadRequest from class-validator) — we still log
    // it for visibility but don't pollute the dashboard
    // with expected client errors.
    const isHttp = exception instanceof HttpException
    const status = isHttp
      ? (exception as HttpException).getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR
    const message = isHttp
      ? this.messageFromHttp(exception as HttpException)
      : (exception as Error)?.message ?? String(exception)
    const stack = (exception as Error)?.stack ?? null

    // Only persist 5xx and unknown errors — 4xx is
    // expected (validation, not found, etc.) and
    // would flood the dashboard.
    if (!isHttp || status >= 500) {
      try {
        await this.tracker.capture({
          source: "backend",
          kind: "unhandled",
          message: `[${req.method} ${req.originalUrl}] ${message}`,
          stack,
          url: req.originalUrl,
          method: req.method,
          statusCode: status,
          userId: (req as any).userId || null,
          companyId: (req as any).companyId || null,
          context: {
            body: this.safeBody(req.body),
            query: req.query,
            params: req.params,
            ip: req.ip,
            userAgent: req.get("user-agent"),
          },
        })
      } catch {
        // Capture failures must never break the error
        // response. Just log to console.
      }
    }

    if (isHttp) {
      this.logger.warn(
        `[${req.method} ${req.originalUrl}] ${status} ${message}`,
      )
    } else {
      this.logger.error(
        `[${req.method} ${req.originalUrl}] ${status} ${message}`,
        stack ?? "",
      )
    }

    // Preserve the original response shape: NestJS's
    // default is `{ statusCode, message, error }` for
    // HttpException and `{ statusCode, message: "Internal
    // server error" }` for everything else. Replicate that.
    const responseBody = isHttp
      ? (exception as HttpException).getResponse()
      : {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: "Internal server error",
        }
    res.status(status).json(responseBody)
  }

  private messageFromHttp(ex: HttpException): string {
    const resp = ex.getResponse()
    if (typeof resp === "string") return resp
    if (typeof resp === "object" && resp !== null) {
      const r: any = resp
      if (Array.isArray(r.message)) return r.message.join(", ")
      return r.message || ex.message
    }
    return ex.message
  }

  /**
   * Strip obvious secrets from request body before
   * logging. Don't want a password hash or password-
   * reset token showing up in the dashboard.
   */
  private safeBody(body: any): any {
    if (!body || typeof body !== "object") return body
    const cloned: any = { ...body }
    for (const key of Object.keys(cloned)) {
      const k = key.toLowerCase()
      if (
        k.includes("password") ||
        k.includes("token") ||
        k.includes("secret") ||
        k.includes("hash")
      ) {
        cloned[key] = "[redacted]"
      }
    }
    return cloned
  }
}
