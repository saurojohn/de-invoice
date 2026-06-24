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
};

export default nextConfig;
