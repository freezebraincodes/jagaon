import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const ROOT = resolve(__dirname, "../../../..");

/**
 * Packet 11C C7 bilingual browser and accessibility evidence (technical evidence, not owner approval). Two targets, each its own
 * server on its own port, never reused (a stale server fails the run instead of being tested):
 * - 3311: the production build as is (shipped manifest, all request classes PENDING), with a tripwire on /api/ai/*.
 * - 3312: the isolated TEST-ONLY harness (e2e/packet-11c/harness, README in harness-app.tsx): the real app with an injected test
 *   manifest and test-only QUALIFIED records; every /api/ai/shell answer is a fake typed body served by route interception.
 * Run ONLY in a clean copy without `.env*` (both apps built there first; see the harness README). Synthetic data only.
 * Evidence: test-results/packet-11c-browser-evidence/<timestamp>/ (summary written by evidence-summary.ts after the run).
 */
const stamp = process.env.C7_EVIDENCE_STAMP ?? new Date().toISOString().replace(/[:.]/g, "-");
process.env.C7_EVIDENCE_STAMP = stamp;
process.env.C7_EVIDENCE_DIR ??= join(ROOT, "test-results/packet-11c-browser-evidence", stamp);

export default defineConfig({
  testDir: join(ROOT, "e2e/packet-11c"),
  tsconfig: join(ROOT, "tsconfig.json"),
  testMatch: /\.spec\.ts$/,
  outputDir: join(ROOT, "test-results/playwright-packet-11c"),
  timeout: 150_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalTeardown: join(ROOT, "e2e/packet-11c/evidence-summary.ts"),
  use: { trace: "off", screenshot: "off", video: "off" },
  webServer: [
    { cwd: ROOT, command: "npx next start -p 3311", url: "http://localhost:3311", reuseExistingServer: false, timeout: 120_000 },
    { cwd: ROOT, command: "npx next start e2e/packet-11c/harness -p 3312", url: "http://localhost:3312", reuseExistingServer: false, timeout: 120_000 },
  ],
  projects: [
    { name: "isolation", testMatch: /isolation\.spec\.ts$/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testMatch: /(production|harness-[a-z]+)\.spec\.ts$/ },
    { name: "webkit-smoke", use: { ...devices["Desktop Safari"] }, testMatch: /(production|harness-[a-z]+)\.spec\.ts$/, grep: /@smoke/ },
  ],
});
