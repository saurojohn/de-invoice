import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './modules/system/system.filter';
import { ErrorTrackingService } from './modules/system/error-tracking.service';
import { MetricsController } from './modules/health/metrics.controller';
import { setRequestContext, clearRequestContext } from './prisma/prisma.service';
import helmet from 'helmet';
import type { Multer } from 'multer';

// Re-export Multer.File type used by controllers (Multer is a namespace in @types/multer)
declare global {
  namespace Express {
    interface Multer {
      File: Multer.File;
    }
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

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
    ],
    maxAge: 86400, // Cache preflight 24h
  });

  // Body size limit (10MB) for JSON payloads — Express default is 100kb which is too small
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
  // @ts-ignore - express types
  expressApp.use((req: any, res: any, next: any) => {
    if (req.headers['content-length'] && parseInt(req.headers['content-length']) > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    next();
  });

  // Metrics middleware — registered before any controller so it
  // wraps every request, including ones rejected by guards. The
  // controller registers itself with MetricsController.setInstance()
  // via OnApplicationBootstrap (see metrics.controller.ts).
  expressApp.use(MetricsController.middleware());

  // Tier 13: request context for the audit log. We pull userId
  // and companyId from the same x-user-id / x-company-id headers
  // the HeaderAuthGuard uses, so the audit row records the
  // caller's identity without needing a DB lookup. The
  // prisma.auditLog extension reads this global on every
  // update/delete and stamps userId on the row.
  expressApp.use((req: any, _res: any, next: any) => {
    setRequestContext({
      userId: req.headers['x-user-id'] || null,
      companyId: req.headers['x-company-id'] || null,
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
    })
    // Clear the context on response finish so a
    // background continuation can't read a stale
    // userId after the request has ended.
    _res.on('finish', () => clearRequestContext())
    next()
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