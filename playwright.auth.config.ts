import { defineConfig } from "@playwright/test";

if (process.env.TAXOPS_AUTH_TEST_RUN !== "1") {
  throw new Error(
    "Use npm run test:auth-e2e to create the isolated auth stack",
  );
}
const baseURL = "http://127.0.0.1:3218";

export default defineConfig({
  testDir: "./tests/auth-e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/auth-test/results.json" }],
  ],
  outputDir: "test-results/auth",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1280, height: 900 },
    // Authentication credentials and authorization codes must not enter trace artifacts.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
