import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * Packet 10 real-browser evidence (test-release-spec Section 8). Runs the
 * production build on localhost (a secure context) in Chromium and WebKit
 * with synthetic data only. WebKit here is Playwright's WebKit build; it is
 * not evidence for physical iPhone Safari.
 */
export default defineConfig({
  // Packet 10 specs only (Packet 11C C7 has its own config: playwright.packet-11c.config.ts).
  testDir: path.join(ROOT, "e2e/packet-10"),
  tsconfig: path.join(ROOT, "tsconfig.json"),
  outputDir: path.join(ROOT, "test-results/playwright"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3210", trace: "off", screenshot: "off", acceptDownloads: true },
  webServer: {
    cwd: ROOT,
    command: "npx next start -p 3210",
    url: "http://localhost:3210",
    reuseExistingServer: process.env.JAGAON_RELEASE !== "1",
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /cross-browser/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: /cross-browser/ },
    { name: "cross-browser", testMatch: /cross-browser/ },
  ],
});
