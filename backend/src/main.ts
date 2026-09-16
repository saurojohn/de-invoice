import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './modules/system/system.filter';
import { ErrorTrackingService } from './modules/system/error-tracking.service';
import { MetricsController } from './modules/health/metrics.controller';
import { runWithRequestContext } from './prisma/request-context';
import helmet from 'helmet';
import type * as Multer from 'multer';

// Re-export Multer.File type used by controllers (Multer is a namespace in @types/multer).
// Tier 235 fix: @types/multer already declares `Express.Multer.File` in
// its global augmentation. Our local declaration collides with
// that one (the .d.ts says `File: { fieldname, originalname, ... }`
// while `@types/multer` says `File: File`). We use `import('multer').File`
// as a re-export alias below instead of redeclaring the namespace
// member, which is what was actually causing the TS2717.
declare global {
  namespace Express {
    type File = Multer.File;
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Body size limit (10MB) for JSON + urlencoded — NestJS's default
  // body parser limit is 100KB, which trips on a 370KB ZUGFeRD PDF
  // base64'd (Tier 72 PDF signing needs to round-trip full PDFs
  // through /signing/verify). We re-register the parsers here AFTER
  // Nest's defaults so the new limits take effect.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

  // 全局前缀 — exclude /metrics (Prometheus scrapers expect a
  // flat path with no version prefix). ExcludeForm is the
  // documented Nest API; alternative is the `exclude` array
  // but it only accepts string route patterns, and our
  // /metrics is a single route.
  app.setGlobalPrefix('api/v1', {
    exclude: ['metrics'],
  });

  // Security headers via helmet
  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP — Next.js handles its own
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow frontend to load PDFs/images
  }));

  // CORS — explicit whitelist (no wildcard)
  const frontendUrl = configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
  const allowedOrigins = frontendUrl.split(',').map((s) => s.trim()).filter(Boolean);
  // Tier 377: refuse a disallowed Origin here, before the cors middleware.
  // The cors `origin` callback below can only reject by raising an Error, and
  // that Error reached GlobalExceptionFilter as a 500: every such request —
  // unauthenticated, preflight or not — was logged as ERROR, stored as an
  // ErrorEvent row and notified. The fingerprint includes the URL, so varying
  // the query string created a new row per request (measured: 6 requests,
  // 6 rows). A plain 403 without the filter keeps the same block, quietly.
  app.use((req: { headers: Record<string, string | string[] | undefined> }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !allowedOrigins.includes(origin)) {
      res.status(403).json({ statusCode: 403, message: 'CORS: Origin nicht erlaubt', error: 'Forbidden' });
      return;
    }
    next();
  });
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow same-origin (no Origin header) + explicit whitelist
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      // HeaderAuthGuard shim — frontend sends these so the backend
      // can identify the calling user. Without them, browsers will
      // block the preflight and the request never reaches the API.
      'x-user-id',
      'x-company-id',
      // Tier 389: the Steuerberater-Modus (Tier 71) adds x-readonly: 1 to every
      // request. Missing here, the browser's preflight failed and every request
      // from the page was blocked by CORS as soon as the mode was on (measured:
      // /dashboard/customers → net::ERR_FAILED, no response).
      'x-readonly',
    ],
    // Tier 389: downloads are fetched with the auth headers and saved as a
    // blob; the file name comes from Content-Disposition, which a cross-origin
    // fetch can only read when it is exposed.
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400, // Cache preflight 24h
  });

  // Body size limit (10MB) is set above via app.use(json({ limit: '10mb' })).
  // The hand-rolled content-length gate previously at this spot
  // was removed in Tier 72 — the JSON body parser now returns
  // its own 413 with a proper body, so a duplicate gate only
  // caused double-checking. See the note above the metrics
  // middleware for the full rationale.
  const expressApp = app.getHttpAdapter().getInstance();
  // Trust X-Forwarded-* headers from nginx (same host, loopback).
  //
  // Tier 19: switched from `trust proxy: true` (DANGEROUS — would
  // trust X-Forwarded-For from ANY source, letting an attacker
  // spoof their IP for rate-limit bypass or audit log poisoning)
  // to `trust proxy: 'loopback'` (only trust the X-Forwarded-For
  // header when the TCP connection comes from 127.0.0.0/8 or ::1,
  // i.e. from nginx on the same host).
  //
  // When Cloudflare is in front of nginx, the real visitor IP
  // restoration happens at the nginx layer via
  // infra/cloudflare/cloudflare-real-ip.conf (which sets
  // $remote_addr from CF-Connecting-IP for CF edge IPs). nginx
  // then passes that real IP as X-Real-IP to the backend. The
  // backend doesn't need to know about CF — it just trusts
  // loopback (nginx) and reads X-Real-IP.
  if (process.env.TRUST_PROXY === 'true') {
    expressApp.set('trust proxy', 'loopback')
  }
  // NOTE: the previous hand-rolled 10MB content-length gate was
  // removed in Tier 72 once we re-registered the JSON body parser
  // with `app.use(json({ limit: '10mb' }))` above. The body parser
  // returns its own 413 with a proper JSON body for over-limit
  // requests, so a separate gate only caused double-checking.

  // Metrics middleware — registered before any controller so it
  // wraps every request, including ones rejected by guards. The
  // controller registers itself with MetricsController.setInstance()
  // via OnApplicationBootstrap (see metrics.controller.ts).
  expressApp.use(MetricsController.middleware());

  // Tier 13: request context for the audit log. We pull userId
  // and companyId from the same x-user-id / x-company-id headers
  // the HeaderAuthGuard uses, so the audit row records the
  // caller's identity without needing a DB lookup. The
  // prisma.auditLog extension reads it on every write.
  // Tier 384: scoped to this request with AsyncLocalStorage — it was a
  // process global that concurrent requests overwrote (see request-context.ts).
  expressApp.use((req: any, _res: any, next: any) => {
    runWithRequestContext(
      {
        // Tier 400: with session cookies the user is only known once the guard
        // has resolved the session — and this middleware runs BEFORE guards.
        // The header values are a starting point (still the credential while
        // ALLOW_HEADER_AUTH is on); HeaderAuthGuard overwrites userId with the
        // authenticated one. The store is a mutable object, so a write inside
        // the scope is what the audit extension reads.
        userId: req.headers['x-user-id'] || null,
        companyId: req.headers['x-company-id'] || null,
        ipAddress: req.ip || req.socket?.remoteAddress || null,
        userAgent: req.headers['user-agent'] || null,
      },
      next,
    )
  })

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global exception filter — captures every unhandled
  // backend error into the ErrorEvent table (self-hosted
  // Sentry). One place, no per-module try/catch boilerplate.
  const tracker = app.get(ErrorTrackingService);
  app.useGlobalFilters(new GlobalExceptionFilter(tracker));

  const port = configService.get('PORT', 3001);
  await app.listen(port);
  console.log(`Backend running on http://localhost:${port}`);
}

bootstrap();