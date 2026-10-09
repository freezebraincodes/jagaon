import { defineConfig, devices } from "@playwright/test";

/**
 * Packet 12B B2 critical journey (and later Packet 12 specs). Production build only, own port, never reused (a stale server fails
 * the run). Run ONLY in a clean copy without `.env*` (the release orchestrator's export). Synthetic data only.
 */
export default defineConfig({
  testDir: "e2e/packet-12",
  testMatch: /\.spec\.ts$/,
  outputDir: "test-results/playwright-packet-12",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3410", trace: "off", screenshot: "off", video: "off" },
  webServer: { command: "npx next start -p 3410", url: "http://localhost:3410", reuseExistingServer: false, timeout: 120_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
