"use client";

/*
 * ============================================================================================================================
 * README — Packet 13 voice browser harness (TEST-ONLY; technical evidence, not owner approval)
 * ============================================================================================================================
 *
 * What it is
 *   A separate, test-only Next.js app (this directory, with its own next.config.ts, tsconfig.json, postcss.config.js and app/) that
 *   renders the REAL `JagaOnApp` through its own `voiceTranscriberLoader` seam. Everything else is the shipped app: the voice-cloud
 *   disclosure, the deterministic extractor, the review cards, the clarification dialog, the patient-terminology record, the journal.
 *   Only the transcriber is replaced by the scripted fake (`createFakeVoiceTranscriber`), which "hears" exactly the text in the URL.
 *
 * Why it cannot reach production
 *   - It lives outside `src/`; nothing under `src/` imports it.
 *   - The production app is `src/app` only; e2e/packet-13/isolation.spec.ts scans the production `.next` for this harness's marker
 *     (positive control: the harness build contains it).
 *   - It has NO server routes. `/api/voice/usersig` does not exist here; the voice-off proof runs against the PRODUCTION build, whose
 *     route answers VOICE_DISABLED because no voice environment is set in the clean copy.
 *
 * Parameters (query string, read when the transcriber is loaded, i.e. after the disclosure is accepted)
 *   - `say`: the text the fake "hears" as one FINAL segment (omit for silence: Stop stays available, nothing is heard).
 *   - `fail`: a closed start failure (PERMISSION_DENIED, UNSUPPORTED_BROWSER, PROVIDER_FAILURE, CREDENTIAL_REFUSED+ACCESS_DENIED).
 *   - `passcode=none` (Owner decision 2026-10-12, optional passcodes): the availability answer says no demo passcode is required (a
 *     deployment without JAGAON_VOICE_DEMO_PASSCODE): the disclosure shows no passcode field. Absent: a passcode is required (as before).
 *
 * How to build and run (ONLY in a clean copy without `.env*`)
 *   npx next build && npx next build e2e/packet-13/harness && npx playwright test -c internal-docs/testing/playwright/configs/playwright.packet-13.config.ts
 * Data is synthetic only: the prepared demo profile and the runtime's synthetic seed.
 * ============================================================================================================================
 */

import { CURRENT_RELEASE_PROFILE } from "@/config/release-profile";
import { JagaOnApp } from "@/components/jagaon/JagaOnApp";
import { createFakeVoiceTranscriber, type FakeVoiceTranscriberScript } from "@/application/voice/fake-voice-transcriber";
import type { VoiceTranscriberPort } from "@/application/voice/voice-transcriber-port";

/** Searched for in the production build output by e2e/packet-13/isolation.spec.ts (it must never be there). */
export const P13_HARNESS_MARKER = "JAGAON-P13-ISOLATED-VOICE-HARNESS";

function scriptFromUrl(): FakeVoiceTranscriberScript {
  const params = new URLSearchParams(window.location.search);
  const say = params.get("say");
  const fail = params.get("fail");
  if (fail === "CREDENTIAL_REFUSED+ACCESS_DENIED") return { start: { kind: "FAILED", reason: "CREDENTIAL_REFUSED", credentialRefusal: "ACCESS_DENIED" } };
  if (fail === "PERMISSION_DENIED" || fail === "UNSUPPORTED_BROWSER" || fail === "PROVIDER_FAILURE") return { start: { kind: "FAILED", reason: fail } };
  return { segmentsOnStart: say ? [{ kind: "FINAL", segmentId: "harness-1", text: say }] : [] };
}

/**
 * Review I-5: the harness has no voice route; the scripted fake is "available" unless the URL asks for `?voice=off`. Owner decision
 * 2026-10-12 (optional passcodes): `?passcode=none` answers that no passcode is required.
 */
async function harnessAvailability(): Promise<Readonly<{ available: boolean; passcodeRequired: boolean }>> {
  const params = new URLSearchParams(window.location.search);
  return { available: params.get("voice") !== "off", passcodeRequired: params.get("passcode") !== "none" };
}

async function harnessTranscriber(): Promise<VoiceTranscriberPort> {
  return createFakeVoiceTranscriber(scriptFromUrl());
}

export function HarnessApp() {
  return (
    <div data-release-profile={CURRENT_RELEASE_PROFILE} data-p13-harness={P13_HARNESS_MARKER} className="app-shell">
      <JagaOnApp voiceTranscriberLoader={harnessTranscriber} voiceAvailabilityProbe={harnessAvailability} />
    </div>
  );
}
