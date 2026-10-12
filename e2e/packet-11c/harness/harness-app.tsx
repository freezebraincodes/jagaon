"use client";

/*
 * ============================================================================================================================
 * README — Packet 11C C7 isolated browser harness (TEST-ONLY; technical evidence, not owner approval)
 * ============================================================================================================================
 *
 * What it is
 *   A separate, test-only Next.js app (this directory: `e2e/packet-11c/harness/`, with its own `next.config.ts`, `tsconfig.json`,
 *   `postcss.config.js` and `app/`) that renders the REAL `JagaOnApp` with the app's own `aiAssistanceFactory` seam, supplying:
 *   - a test activation manifest (EXPLAIN_PATTERN and DRAFT_CARE_PREPARATION_SUMMARY = SYNTHETIC_REMOTE_ENABLED), and
 *   - the test-only QUALIFIED request-class gate (`qualifiedTestRequestClassGate`, src/application/ai/request-class-test-support.ts).
 *   Everything else is the shipped browser wiring (`createBrowserAiAssistance`): the per-request disclosure, the in-memory demo
 *   passcode, the "Keep wording on this device" setting, the browser shell client and its global `fetch` to POST /api/ai/shell.
 *
 * Why it cannot reach production
 *   - It lives outside `src/`; nothing under `src/` imports it (pinned by tests/packet-11c-c7-harness-isolation.test.ts).
 *   - It is never part of the production build: the production app is `src/app` only. e2e/packet-11c/isolation.spec.ts scans the
 *     production `.next` for this harness's marker and the test-only record strings (and, as a positive control, finds them in the
 *     harness build).
 *   - It has NO server routes. `/api/ai/shell` does not exist here: every call is answered by Playwright route interception
 *     (`page.route`) with FAKE bodies typed by the shared route contract (e2e/packet-11c/support.ts). An unintercepted call gets this
 *     app's 404, which the browser client treats as a closed refusal. No provider, credential or `.env` is involved.
 *
 * How to build and run (ONLY in a clean copy without `.env*`, never in the checkout — `next` loads `.env.local`)
 *   env -u KIE_API_KEY -u DEEPSEEK_API_KEY npx next build                          # the production app (target 1)
 *   env -u KIE_API_KEY -u DEEPSEEK_API_KEY npx next build e2e/packet-11c/harness   # this harness (target 2)
 *   env -u KIE_API_KEY -u DEEPSEEK_API_KEY npm run test:e2e:packet11c              # starts both servers (ports 3311, 3312; never reused)
 *   Evidence is written to test-results/packet-11c-browser-evidence/<timestamp>/ (or $C7_EVIDENCE_DIR).
 *
 * Parameters
 *   - Locale and viewport: chosen by the test (e2e/packet-11c/support.ts: `LOCALES`, `VIEWPORTS`, `startPreparedProfile(page, locale)`);
 *     the app's own Welcome language choice sets the locale, the Playwright context sets the viewport and scale.
 *   - Query `?records=pending`: the harness keeps the test manifest but uses an all-PENDING gate over the shipped definitions
 *     (`pendingTestRequestClassGate`: no class qualified, the pre-activation state), to show that the care AI action and the disclosure
 *     appear only for a qualified request.
 *   - Query `?records=shipped`: the harness keeps the test manifest but uses the SHIPPED records. Since the Packet 11C English
 *     activation (owner decisions Q and A, 2026-10-12) they qualify the six en-SG classes and keep the six zh-SG classes PENDING, so
 *     an en-SG history request is offered the disclosure and a zh-SG one is not.
 *
 * Reuse (Packet 12): add a spec under e2e/packet-11c/ (or a sibling folder with its own config) and reuse `support.ts`; keep the
 * harness free of product logic. Data is synthetic only: the prepared demo profile and the runtime's synthetic seed.
 * ============================================================================================================================
 */

import { useMemo, useSyncExternalStore } from "react";
import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { JagaOnApp, type AiAssistanceFactory } from "@/components/jagaon/JagaOnApp";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { createBrowserAiAssistance } from "@/application/ai/browser-history-explainer";
import { pendingTestRequestClassGate, qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";

/** Searched for in the production build output by e2e/packet-11c/isolation.spec.ts (it must never be there). */
export const C7_HARNESS_MARKER = "JAGAON-C7-ISOLATED-TEST-HARNESS";

/**
 * TEST-ONLY activation: the two shell tasks remote-enabled. Packet 11C English activation (owner decisions Q and A): the shipped manifest
 * now enables the same two tasks; the harness keeps its own explicit test manifest so its behaviour does not depend on the shipped one.
 */
const HARNESS_TEST_MANIFEST: AiActivationManifest = {
  ...AI_ACTIVATION_MANIFEST,
  tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" },
};

type HarnessRecords = "test-qualified" | "pending" | "shipped";

function factoryFor(records: HarnessRecords): AiAssistanceFactory {
  return (ports) =>
    createBrowserAiAssistance({
      ...ports,
      manifest: HARNESS_TEST_MANIFEST,
      // "shipped": no gate injected, so the wiring uses the shipped records.
      ...(records === "test-qualified" ? { requestClassGate: qualifiedTestRequestClassGate() } : records === "pending" ? { requestClassGate: pendingTestRequestClassGate() } : {}),
    });
}

const noSubscription = () => () => undefined;
const readRecords = (): HarnessRecords => {
  const records = new URLSearchParams(window.location.search).get("records");
  return records === "shipped" || records === "pending" ? records : "test-qualified";
};

export function HarnessApp() {
  // Read from the URL in the browser only (null while prerendering and hydrating), before the app and its runtime mount; the factory
  // keeps one identity for the page's lifetime.
  const records = useSyncExternalStore(noSubscription, readRecords, () => null);
  const factory = useMemo(() => (records === null ? null : { records, create: factoryFor(records) }), [records]);
  return (
    <div data-release-profile={CURRENT_RELEASE_PROFILE} data-c7-harness={C7_HARNESS_MARKER} data-c7-records={factory?.records ?? ""} className="app-shell">
      {factory ? <JagaOnApp aiAssistanceFactory={factory.create} /> : null}
    </div>
  );
}
