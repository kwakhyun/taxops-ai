import { defineConfig } from "@playwright/test";

// A dedicated local recording server. Never point this fixture reset at a deployment.
const baseURL = "http://127.0.0.1:3300";
export default defineConfig({
  testDir: "./tests/portfolio",
  outputDir: "test-results/portfolio",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  reporter: "list",
  expect: { timeout: 15_000 },
  use: { baseURL, trace: "off" },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3300",
    url: `${baseURL}/api/health/live`,
    reuseExistingServer: process.env.PORTFOLIO_REUSE_SERVER === "true",
    timeout: 120_000,
    env: {
      AUTH_MODE: "demo",
      E2E_RESET_ENABLED: "true",
      E2E_FIXED_NOW: "2026-08-30T09:00:00+09:00",
      AI_GATEWAY_API_KEY: "",
      DATABASE_URL: "",
      OBJECT_BUCKET: "",
      REVIEW_SERVICE_URL: "",
    },
  },
});
