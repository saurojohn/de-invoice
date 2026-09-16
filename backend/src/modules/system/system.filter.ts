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
 *
 * Security:
 *   - The HTTP response body NEVER includes the raw
 *     Prisma/driver error message. Only a small whitelist
 *     of generic messages is exposed ("Resource already
 *     exists", "Service temporarily unavailable", ...).
 *     The full message + stack is still captured to
 *     ErrorEvent for operator diagnosis.
 *   - 4xx is expected (validation, not found, etc.) and
 *     would flood the dashboard — only 5xx + unknown
 *     exceptions are persisted.
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
    // Tier 378: Prisma P2025 ("record to update/delete not found") is a
    // not-found, not a server fault. It answered 500 — e.g. PATCH / DELETE
    // /webhooks/<another tenant's id>, whose update is scoped by companyId,
    // and was stored as an ErrorEvent. P2002 / P2003 stay 500 on purpose:
    // they also come from server-side races (Tier 174's invoice numbers).
    const isPrismaNotFound =
      !isHttp && (exception as { code?: unknown })?.code === "P2025"
    const status = isHttp
      ? (exception as HttpException).getStatus()
      : isPrismaNotFound
        ? HttpStatus.NOT_FOUND
        : HttpStatus.INTERNAL_SERVER_ERROR

    // The message we expose to the client (sanitized for 5xx).
    const publicMessage = isHttp
      ? this.messageFromHttp(exception as HttpException)
      : this.sanitizeUnknownMessage(exception)

    // The message we persist for the operator (full, raw).
    const persistMessage =
      (exception as Error)?.message ?? String(exception)
    const persistStack = (exception as Error)?.stack ?? null

    // Only persist 5xx and unknown errors — 4xx is
    // expected (validation, not found, etc.) and
    // would flood the dashboard.
    if (!isHttp || status >= 500) {
      try {
        await this.tracker.capture({
          source: "backend",
          kind: "unhandled",
          message: `[${req.method} ${req.originalUrl}] ${persistMessage}`,
          stack: persistStack,
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
        `[${req.method} ${req.originalUrl}] ${status} ${publicMessage}`,
      )
    } else {
      // Server-side log keeps the full message for debugging.
      this.logger.error(
        `[${req.method} ${req.originalUrl}] ${status} ${persistMessage}`,
        persistStack ?? "",
      )
    }

    // Preserve the original response shape: NestJS's
    // default is `{ statusCode, message, error }` for
    // HttpException and `{ statusCode, message: "Internal
    // server error" }` for everything else. Replicate that
    // — but with the SANITIZED message for 5xx so we don't
    // leak Prisma's P2002 / SQL fragments / connection
    // strings to the client.
    const responseBody = isHttp
      ? (exception as HttpException).getResponse()
      : {
          // Tier 393: was hard-coded to 500 while res.status(status) sent the
          // mapped code — a P2025 answered HTTP 404 with a body saying 500.
          statusCode: status,
          message: publicMessage,
        }
    res.status(status).json(responseBody)
  }

  /**
   * Whitelist Prisma error codes that have a generic,
   * safe public message. For any other unhandled error
   * (raw PrismaClientKnownRequestError, ECONNREFUSED,
   * SQL fragment, etc.) we return a generic "Internal
   * server error" so the client never sees the internal
   * details. The full original message is still persisted
   * to ErrorEvent for operator diagnosis.
   */
  private sanitizeUnknownMessage(exception: unknown): string {
    if (!exception || typeof exception !== "object") {
      return "Internal server error"
    }
    const e = exception as any
    // PrismaClientKnownRequestError has a `code` field
    // like P2002 (unique constraint), P2003 (FK),
    // P2025 (not found). Map the most common ones to
    // safe messages; the rest stay generic.
    if (typeof e.code === "string" && e.code.startsWith("P")) {
      switch (e.code) {
        case "P2002":
          return "Resource already exists"
        case "P2003":
          return "Related resource not found"
        case "P2025":
          return "Resource not found"
        default:
          return "Internal server error"
      }
    }
    // Database connection / timeout errors come from
    // the driver without a `code`. Don't leak driver
    // string.
    if (
      e.code === "ECONNREFUSED" ||
      e.code === "ETIMEDOUT" ||
      e.code === "ENOTFOUND"
    ) {
      return "Service temporarily unavailable"
    }
    return "Internal server error"
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
   * Strip obvious secrets + PII from request body before
   * logging. Don't want a password hash, password-reset
   * token, customer email, or IBAN showing up in the
   * dashboard.
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
        continue
      }
      // PII keys (case-insensitive substring match).
      // The actual values live in the DB and are visible
      // to the customer who owns them; just don't echo to
      // the log stream (k8s, CloudWatch, Datadog).
      if (
        k === "email" ||
        k.endsWith("email") ||
        k === "iban" ||
        k.endsWith("iban") ||
        k.includes("phone")
      ) {
        cloned[key] = "[redacted]"
        continue
      }
    }
    return cloned
  }
}
