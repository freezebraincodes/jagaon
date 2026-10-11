import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * Packet 12B B2 critical journey (and later Packet 12 specs). Production build only, own port, never reused (a stale server fails
 * the run). Run ONLY in a clean copy without `.env*` (the release orchestrator's export). Synthetic data only.
 */
export default defineConfig({
  testDir: path.join(ROOT, "e2e/packet-12"),
  tsconfig: path.join(ROOT, "tsconfig.json"),
  testMatch: /\.spec\.ts$/,
  outputDir: path.join(ROOT, "test-results/playwright-packet-12"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3410", trace: "off", screenshot: "off", video: "off" },
  webServer: { cwd: ROOT, command: "npx next start -p 3410", url: "http://localhost:3410", reuseExistingServer: false, timeout: 120_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
