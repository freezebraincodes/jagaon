import { defineConfig, devices } from "@playwright/test";

/**
 * Packet 13 voice browser evidence (technical evidence, not owner approval; presentation human acceptance pending). Two targets, each
 * its own server on its own port, never reused:
 * - 3321: the PRODUCTION build as is (real TRTC loader, real /api/voice/usersig; NO voice environment in the clean copy, so the route
 *   answers VOICE_DISABLED): the voice-off proof (no microphone, no UserSig, no TRTC session).
 * - 3322: the isolated TEST-ONLY harness (e2e/packet-13/harness): the real app with the scripted fake transcriber; synthetic speech.
 * Run ONLY in a clean copy without `.env*`, after `npx next build` and `npx next build e2e/packet-13/harness`. No credential, no live
 * TRTC or DeepSeek call. Production saving is connected; no flag is needed.
 */
export default defineConfig({
  testDir: "e2e/packet-13",
  testMatch: /\.spec\.ts$/,
  outputDir: "test-results/playwright-packet-13",
  timeout: 150_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "off", screenshot: "off", video: "off" },
  webServer: [
    { command: "npx next start -p 3321", url: "http://localhost:3321", reuseExistingServer: false, timeout: 120_000 },
    { command: "npx next start e2e/packet-13/harness -p 3322", url: "http://localhost:3322", reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: "isolation", testMatch: /isolation\.spec\.ts$/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testMatch: /voice-(demo|safety|off)\.spec\.ts$/ },
    { name: "webkit-smoke", use: { ...devices["Desktop Safari"] }, testMatch: /voice-demo\.spec\.ts$/, grep: /@smoke/ },
  ],
});
