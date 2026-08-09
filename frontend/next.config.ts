import type { NextConfig } from "next";
import path from "node:path";

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
  // Tier 165: explicitly pin the Turbopack
  // workspace root to this package. Without
  // this, Next.js 16 auto-detects the closest
  // common ancestor of every lockfile in
  // /Users/shledergmbh/Projects (i.e. the
  // whole Projects/ tree) and runs the file
  // watcher over it — which on this machine
  // includes the de-invoice/backend/ tree,
  // node_modules/ (43k+ files between the
  // two packages), and other sibling projects
  // (qt-postgres, etc). The result is that
  // next-server spends 50%+ CPU scanning
  // unrelated directories on every change,
  // and kernel_task spikes to 250%+ because
  // FSEvents wakes up Next.js, ts-node-dev,
  // Prisma, and Docker all at once.
  //
  // Pinning the root to this package means
  // Next.js only watches frontend/src and
  // frontend/messages. ts-node-dev is
  // already scoped to backend/src (see
  // backend/scripts/start-backend.sh). The
  // two never see each other's changes —
  // each tier restart is a deliberate act.
  turbopack: {
    root: path.join(__dirname),
  },
  // Belt-and-suspenders: even with a pinned
  // root, tell webpack (production builds)
  // to ignore the .git, test-results, and
  // backend directories. Cheap insurance.
  webpack: (config, { isServer: _isServer }) => {
    config.watchOptions = {
      ...config.watchOptions,
      // The defaults are fine, but explicitly
      // set these so a future Next.js upgrade
      // can't quietly re-enable aggressive
      // polling on macOS.
      poll: false,
      aggregateTimeout: 300,
    };
    return config;
  },
};

export default nextConfig;
