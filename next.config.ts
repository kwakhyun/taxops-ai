import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir:
    process.env.NODE_ENV !== "production" &&
    (process.env.E2E_RESET_ENABLED === "true" ||
      process.env.TAXOPS_AUTH_TEST_RUN === "1")
      ? ".next-e2e"
      : ".next",
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  devIndicators: false,
  allowedDevOrigins: [
    "127.0.0.1",
    ...(process.env.E2E_RESET_ENABLED === "true" ? ["host.lima.internal"] : []),
  ],
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    proxyClientMaxBodySize: "16mb",
    // Isolated auth runs restart with fresh credentials; avoid reusing dev graph state.
    ...(process.env.TAXOPS_AUTH_TEST_RUN === "1"
      ? { turbopackFileSystemCacheForDev: false }
      : {}),
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
