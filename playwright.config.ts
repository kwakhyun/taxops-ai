import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
if (!Number.isInteger(e2ePort) || e2ePort < 1_024 || e2ePort > 65_535) {
  throw new Error("PLAYWRIGHT_PORT must be an integer from 1024 to 65535");
}
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${e2ePort}`,
    url: `${baseURL}/api/health/live`,
    env: {
      ...process.env,
      E2E_RESET_ENABLED: "true",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
