// @vitest-environment node
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadStored } from "./packet-11-offline-presentation-replay.test";
import { CURRENT_SLOT_PLAN_VERSION, HISTORICAL_SLOT_PLAN_VERSION, RESPONSE_ECHO_OCCURRENCES_PER_RESPONSE, rewriteStoredResponseEcho } from "./packet-11-slot-plan-version-normalisation";

/**
 * Packet 11C P2b: the in-memory response echo rewrite used only by VERSION_NORMALISED_REPLAY (evidence only). It must touch exactly the
 * model's `slotPlanVersion` echo (historical -> current), once, and refuse everything else. Offline; nothing is sent.
 */
const TRACE = "test-results/packet-11-hybrid-live-trace/20261007T131032Z-6a13e8630a3464c8";
const shellText = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: "ai-shell.explain-pattern@11b.8", slotPlanVersion: HISTORICAL_SLOT_PLAN_VERSION, tokenInventory: ["S1", "S3"], taskType: "EXPLAIN_PATTERN", outcome: "SUCCESS", locale: "en-SG", abstentionReason: null, shells: { headline: "S1 headline", evidence: "S3 evidence" }, ...overrides });
/** A provider-like envelope written by hand, with a non-canonical `0.0` and the request-parameter echo of the schema enum. */
const envelope = (text: string, extra = "") =>
  `{"id":"r","status":"completed","frequency_penalty":0.0,"output":[{"type":"message","content":[{"type":"output_text","text":${JSON.stringify(text)}}]}],"text":{"format":{"schema":{"properties":{"slotPlanVersion":{"enum":["${HISTORICAL_SLOT_PLAN_VERSION}"]}}}}}${extra}}`;

describe("rewriteStoredResponseEcho (VERSION_NORMALISED_REPLAY helper, in memory only)", () => {
  it("rewrites exactly the model's echo, once; every other byte (0.0, the request-parameter enum echo) stays as stored", () => {
    const raw = envelope(shellText());
    const result = rewriteStoredResponseEcho(raw);
    expect(result.occurrences).toBe(RESPONSE_ECHO_OCCURRENCES_PER_RESPONSE);
    expect(result.paths).toEqual(["output[0].content[0].text#slotPlanVersion"]);
    expect(result.raw).toBe(envelope(shellText({ slotPlanVersion: CURRENT_SLOT_PLAN_VERSION })));
    expect(result.raw).toContain('"frequency_penalty":0.0');
    expect(result.raw).toContain(`"enum":["${HISTORICAL_SLOT_PLAN_VERSION}"]`);
  });
  it("leaves a planted historical version inside a shell untouched", () => {
    const planted = shellText({ shells: { headline: `S1 ${HISTORICAL_SLOT_PLAN_VERSION}`, evidence: "S3 evidence" } });
    const result = rewriteStoredResponseEcho(envelope(planted));
    expect(result.raw).toContain(`S1 ${HISTORICAL_SLOT_PLAN_VERSION}`);
    expect(result.paths).toEqual(["output[0].content[0].text#slotPlanVersion"]);
  });
  it("refuses an echo that is not the historical version, a non-canonical shell text, a repeated text literal and a second output_text", () => {
    expect(() => rewriteStoredResponseEcho(envelope(shellText({ slotPlanVersion: CURRENT_SLOT_PLAN_VERSION })))).toThrow("ECHO_REWRITE_NOT_HISTORICAL");
    expect(() => rewriteStoredResponseEcho(envelope(shellText().replace('"outcome"', ' "outcome"')))).toThrow("VERSION_NORMALISATION_NOT_CANONICAL");
    expect(() => rewriteStoredResponseEcho(envelope(shellText(), `,"metadata":${JSON.stringify(shellText())}`))).toThrow("ECHO_REWRITE_NOT_UNIQUE");
    const two = envelope(shellText()).replace('"content":[', `"content":[{"type":"output_text","text":"x"},`);
    expect(() => rewriteStoredResponseEcho(two)).toThrow("ECHO_REWRITE_OUTPUT_TEXT_COUNT");
    expect(() => rewriteStoredResponseEcho('{"output":"none"}')).toThrow("ECHO_REWRITE_NOT_AN_ENVELOPE");
  });
  it.runIf(existsSync(TRACE))("every stored INDEPENDENT_CONFIRMATION_RUN response rewrites at exactly the one echo path (read only)", () => {
    const stored = loadStored();
    expect(stored).toHaveLength(70);
    for (const call of stored) {
      const result = rewriteStoredResponseEcho(call.raw);
      expect([call.sequence, result.occurrences, result.paths]).toEqual([call.sequence, 1, ["output[0].content[0].text#slotPlanVersion"]]);
      expect(result.raw.length - call.raw.length).toBe(0);
    }
  });
});
