import type { NextConfig } from "next";

// Tier 859 (security audit, item 5) — a Content-Security-Policy on every page.
// There was none: a script that got into a page (a dependency, an injected
// string) could load code from anywhere, send the session's data anywhere,
// put the app in a frame of another site or post its forms elsewhere.
// Everything the app loads comes from itself and from its API (the same
// origin in production behind Caddy; :3011 while developing). Inline scripts
// stay allowed: Next.js writes its page data as inline scripts, and a nonce
// for each would make every page dynamic. `unsafe-eval` only for `next dev`
// (React Refresh), and its websocket.
const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL || "").origin;
  } catch {
    return "";
  }
})();
const dev = process.env.NODE_ENV !== "production";
export const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${apiOrigin}`.trim(),
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin}${dev ? " ws: wss:" : ""}`.trim(),
  `frame-src 'self' blob: ${apiOrigin}`.trim(),
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: contentSecurityPolicy }] }];
  },
  // Tier 11: standalone output — produces a minimal
  // Node server in .next/standalone that bundles
  // only the files needed at runtime, cutting
  // the production image from ~400MB (full
  // node_modules) to ~120MB. The trace includes
  // both server and client code; the public
  // directory and .next/static are copied in
  // alongside via the Dockerfile.
  output: "standalone",
  //
  // Tier 165 rollback: the earlier `turbopack.root`
  // + `webpack.watchOptions` change caused a
  // node fork storm in Next.js 16 dev mode
  // (300+ node processes, maxprocperuid
  // 2666 hit, system EAGAIN). The pin + the
  // watchOptions override together made
  // Turbopack re-spawn workers in a tight
  // loop on every file event. Reverted both
  // — the kernel_task 250% symptom is back
  // but it's a *display* of un-attributable
  // kernel work, not the cause. The real
  // cause (Turbopack auto-detecting the
  // workspace root as the closest common
  // lockfile ancestor) is a Next.js 16 bug
  // we'll address in a separate tier
  // (probably with .swcrc + ignore patterns
  // instead of workspace-root pinning).
  //
  // What this commit does:
  // 1. Reverts `turbopack.root` (was line 38-40)
  // 2. Reverts `webpack` watchOptions override
  //    (was line 45-55) — neither helped and
  //    together they triggered fork-storm
};

export default nextConfig;
