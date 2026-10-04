import { defineConfig, devices } from "@playwright/test";

/**
 * Packet 10 real-browser evidence (test-release-spec Section 8). Runs the
 * production build on localhost (a secure context) in Chromium and WebKit
 * with synthetic data only. WebKit here is Playwright's WebKit build; it is
 * not evidence for physical iPhone Safari.
 */
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/playwright",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3210", trace: "off", screenshot: "off", acceptDownloads: true },
  webServer: {
    command: "npx next start -p 3210",
    url: "http://localhost:3210",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /cross-browser/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: /cross-browser/ },
    { name: "cross-browser", testMatch: /cross-browser/ },
  ],
});
