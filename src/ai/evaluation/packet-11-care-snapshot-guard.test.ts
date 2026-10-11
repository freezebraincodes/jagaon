// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiLocale, AiTaskRequest } from "@/domain/ai";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import { NOW, syntheticCareDraft, type SyntheticCareDraftShape } from "@/application/care-preparation/care-preparation-test-support";
import { renderDeterministicCareSummary } from "@/application/care-preparation/deterministic-care-summary-renderer";
import { capture } from "./packet-11-presentation-guard.test";
import { hybridFixturesForPhase } from "./packet-11-hybrid-fixtures";
import { differingPaths, normaliseSlotPlanVersion, SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY } from "./packet-11-slot-plan-version-normalisation";

/**
 * Packet 11C Addendum B, Task B1b body-class guard (evaluation-only, offline). A care request built from a stored deterministic snapshot
 * (`buildCareSummaryAiRequest`) must produce a model-facing body of an already-evaluated care class: byte-identical to the body of the
 * care fixture of the same shape among the 70, both current (ai-slot-plan.11b.9) and after the documented version-only normalisation to
 * the historical class (11b.8). Captured exactly as the presentation guard captures the 70 bodies (its exported `capture`: the real
 * DeepSeek shell adapter with a fetcher that records the body and throws). No provider call is made; the global fetch is stubbed to throw.
 *
 * Classes hit (value-blind, so the values of the snapshot and the fixture differ while the bodies are identical):
 * - ORDINARY: one reading and one question (the care fixtures ORDINARY, AMBIGUOUS, INVALID_REFERENCE, CHANGED_NUMBER_UNIT,
 *   PROMPT_INJECTION and every FORBIDDEN_* share this body);
 * - HIDDEN_LIMITATION: an appointment, three readings, two meal items and two questions.
 * A questions-only snapshot (the MISSING_DATA / ABSTENTION class) is never sent: nothing in it may be reworded (NOTHING_TO_PHRASE).
 */
const CLASSES: ReadonlyArray<readonly [SyntheticCareDraftShape, string]> = [
  ["ORDINARY", "ordinary"],
  ["HIDDEN_LIMITATION", "hidden-limitation"],
];
const LOCALES: readonly AiLocale[] = ["en-SG", "zh-SG"];
const CASES = LOCALES.flatMap((locale) => CLASSES.map(([shape, slug]) => [locale, shape, slug] as const));
/** Current (11b.9) body SHA-256 of each class, i.e. of the stored fixture body; pinned so any drift shows. */
const CURRENT_CLASS_BODY_SHA: Readonly<Record<string, string>> = {
  "en-SG ordinary": "358bd7e9f19769e41ea9c093f89f274b985e9d99048aae5012bd46f15fa6e6ef",
  "en-SG hidden-limitation": "f1da1c2d28a87e474e7d141af7d0d8a42abc9b69b1ad68eba7554779dee6ea12",
  "zh-SG ordinary": "258e37da92488c0c38f844f92ada39a2db77ad542756ab6b6ae0e6e5b84fba93",
  "zh-SG hidden-limitation": "27ee20f0311a9a401282fb45e43271745fa1b983ec31a124fbffcf08b07e8328",
};
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const fixtureBody = async (locale: AiLocale, slug: string) => {
  const fixture = hybridFixturesForPhase("FULL").find((entry) => entry.id === `p11.draft-care-preparation-summary.${locale.toLowerCase()}.${slug}`)!;
  return (await capture(fixture)).body!;
};
const snapshotRequest = async (shape: SyntheticCareDraftShape, locale: AiLocale): Promise<AiTaskRequest> => {
  const current = (await renderDeterministicCareSummary(syntheticCareDraft(shape, locale))).payload;
  const built = buildCareSummaryAiRequest({ current, requestId: "33333333-3333-4333-8333-333333333333", requestedAt: NOW });
  if (built.kind !== "READY") throw new Error(built.reason);
  return built.request;
};

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK_FORBIDDEN_IN_CARE_SNAPSHOT_GUARD");
  });
});
afterAll(() => vi.unstubAllGlobals());

describe("Packet 11C B1b care snapshot body-class guard (offline)", () => {
  it.each(CASES)("%s %s: the snapshot request's model-facing body is the evaluated care class body", async (locale, shape, slug) => {
    const { body } = await capture({ request: await snapshotRequest(shape, locale), taskType: "DRAFT_CARE_PREPARATION_SUMMARY" });
    expect(body, "no body was captured (the plan is not remote-eligible)").not.toBeNull();
    const reference = await fixtureBody(locale, slug);
    if (body !== reference) expect.fail(`differs from the class body at: ${differingPaths(body!, reference).join(", ")}`);
    expect(sha256(body!)).toBe(CURRENT_CLASS_BODY_SHA[`${locale} ${slug}`]);
    // The same class after the documented version-only normalisation (exactly the two slot-plan version fields).
    const normalised = normaliseSlotPlanVersion(body!);
    expect(normalised.occurrences).toBe(SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY);
    expect(normalised.body).toBe(normaliseSlotPlanVersion(reference).body);
  });

  it.each(CASES)("%s %s: no value, date, label, question or source reaches the body", async (locale, shape) => {
    const request = await snapshotRequest(shape, locale);
    const { body } = await capture({ request, taskType: "DRAFT_CARE_PREPARATION_SUMMARY" });
    for (const fact of request.facts) {
      const value = fact.value;
      const shown = value.kind === "TEXT" ? value.text : value.kind === "DECIMAL" ? value.value : value.kind === "DATE" ? value.localDate : null;
      if (shown !== null) expect(body).not.toContain(shown);
      for (const source of fact.sources) {
        expect(body).not.toContain(source.recordId);
        expect(body).not.toContain(source.revisionId);
      }
    }
  });
});
