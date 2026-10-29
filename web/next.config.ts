import type { NextConfig } from "next";
import path from "node:path";

const exporting = process.env.DIVIWISH_STATIC_EXPORT === "1";
const nextConfig: NextConfig = {
  output: exporting ? "export" : "standalone",
  outputFileTracingRoot: path.resolve(__dirname),
  turbopack: { root: path.resolve(__dirname) },
  devIndicators: false,
  ...(exporting ? {} : {
    async rewrites() {
      return [{ source: "/api/:path*", destination: `${process.env.API_URL || "http://127.0.0.1:8787"}/api/:path*` }];
    },
  }),
};

export default nextConfig;
