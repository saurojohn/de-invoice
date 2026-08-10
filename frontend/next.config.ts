import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
