import { describe, expect, it } from "vitest";
import { aiTaskRequestSchema, type AiLocale } from "@/domain/ai";
import type { CareSummarySnapshotPayload } from "@/domain/care-preparation/care-summary-snapshot";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { isApprovedShellTaskRequest, projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { buildCareSummaryAiRequest } from "./ai-care-summary-request";
import { asLegacy9c1Payload, NOW, syntheticCareDraft, type SyntheticCareDraftShape } from "./care-preparation-test-support";
import { renderDeterministicCareSummary } from "./deterministic-care-summary-renderer";

/**
 * Packet 11C Addendum B, Task B1b: the source-closed care request is built from the current unapproved deterministic snapshot alone,
 * from its AI-organisable sections only, with exactly the evaluated care fact kinds, and fails closed otherwise.
 */

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const LOCALES: readonly AiLocale[] = ["en-SG", "zh-SG"];
const BUNDLE = AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY;
const snapshotOf = async (shape: SyntheticCareDraftShape, locale: AiLocale) => (await renderDeterministicCareSummary(syntheticCareDraft(shape, locale))).payload;
const build = (current: CareSummarySnapshotPayload) => buildCareSummaryAiRequest({ current, requestId: REQUEST_ID, requestedAt: NOW });
const ready = (current: CareSummarySnapshotPayload) => {
  const built = build(current);
  if (built.kind !== "READY") throw new Error(`expected READY, got ${built.reason}`);
  return built;
};
const refKey = (ref: { recordType: string; recordId: string; revisionId: string }) => `${ref.recordType}|${ref.recordId}|${ref.revisionId}`;

describe("care-summary AI request builder (Packet 11C B1b)", () => {
  it.each(LOCALES)("%s: the request parses, names the hybrid care bundle and plans into a remote-eligible, value-blind shell request", async (locale) => {
    for (const shape of ["ORDINARY", "HIDDEN_LIMITATION", "RICH"] as const) {
      const current = await snapshotOf(shape, locale);
      const { request } = ready(current);
      expect(aiTaskRequestSchema.safeParse(request).success, shape).toBe(true);
      expect(request).toMatchObject({ requestId: REQUEST_ID, requestedAt: NOW, releaseProfile: "HACKATHON_DEMO", taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale, runtimeBundleKey: BUNDLE.bundleKey });
      const planned = planSlots(request, BUNDLE);
      if (planned.kind !== "PLANNED") throw new Error(`${shape}: ${planned.reason}`);
      expect(planned.plan.remote, shape).toEqual({ eligible: true });
      const shell = projectShellTaskRequest(planned.plan);
      expect(isApprovedShellTaskRequest(shell), shape).toBe(true);
      // Value-blind: no value, date, label, question, record or revision id reaches the shell request.
      const text = JSON.stringify(shell);
      expect(text.replace(/"(?:maxCodePoints|maxSentences)":\d+/g, "").replace(/"S\d+"|"C\d+"|sections\[\d+\]\.(?:intro|bullets\[\d+\])|"ai-[^"]*"|"[^"]*@[^"]*"/g, ""), shape).not.toMatch(/\d/);
      for (const source of current.selection.includedSourceRevisions) {
        expect(text).not.toContain(source.recordId);
        expect(text).not.toContain(source.revisionId);
      }
      for (const fact of request.facts) if (fact.value.kind === "TEXT") expect(text).not.toContain(fact.value.text);
    }
  });

  it.each(LOCALES)("%s: uses only the evaluated care fact kinds, the organisable sections and the snapshot's own sources", async (locale) => {
    const current = await snapshotOf("RICH", locale);
    const { request, blocks } = ready(current);
    expect(request.facts.map((fact) => `${fact.field}:${fact.value.kind}`)).toEqual([
      "APPOINTMENT_SERVICE:TEXT",
      "APPOINTMENT_TIME:DATE",
      "MEASUREMENT_VALUE:DECIMAL",
      "MEASUREMENT_VALUE:DECIMAL",
      "INTAKE_LABEL:TEXT",
      "ACTIVITY_LABEL:TEXT",
      "QUESTION_TEXT:TEXT",
    ]);
    // Never scope, limitations, safety history or notices; the insulin record and the meal without items stay out of the request.
    expect(request.taskPayload.sections.map((section) => section.sectionId)).toEqual(["CARE_ORGANISATION", "MEASUREMENTS", "INTAKE_AND_ACTIVITY", "QUESTIONS_FOR_CARE_TEAM"]);
    expect(blocks.map((block) => block.blockId)).toEqual(["organisation.appointment", "measurements.glucose", "intake.meals", "activity.walks"]);
    // Values exactly as stored; the appointment date is its own local date; texts verbatim.
    expect(request.facts.map((fact) => fact.value)).toEqual([
      { kind: "TEXT", text: locale === "en-SG" ? "Polyclinic follow-up" : "综合诊疗所复诊", language: "und" },
      { kind: "DATE", localDate: "2026-10-12" },
      { kind: "DECIMAL", value: "6.1", unit: "MMOL_L" },
      { kind: "DECIMAL", value: "7.2", unit: "MMOL_L" },
      { kind: "TEXT", text: locale === "en-SG" ? "chapati" : "印度煎饼", language: "und" },
      { kind: "TEXT", text: locale === "en-SG" ? "Evening walk" : "傍晚散步", language: "und" },
      { kind: "TEXT", text: locale === "en-SG" ? "Can I keep the pen in my bag? (demo)" : "我可以把笔放在包里吗？(演示)", language: locale },
    ]);
    // Source-closed: every fact names exactly one selected source; no medication, insulin or coded-meal source is named.
    const included = new Set(current.selection.includedSourceRevisions.map(refKey));
    for (const fact of request.facts) {
      expect(fact.sources).toHaveLength(1);
      expect(included.has(refKey(fact.sources[0]!))).toBe(true);
    }
    expect(request.facts.flatMap((fact) => fact.sources.map((source) => source.recordType))).toEqual(["APPOINTMENT", "APPOINTMENT", "GLUCOSE_READING", "GLUCOSE_READING", "INTAKE_EVENT", "ACTIVITY_EVENT", "CARE_QUESTION"]);
    // Every stored line is reconstructed exactly; the unphrased lines (the meal without items) carry no fact.
    const meals = blocks.find((block) => block.blockId === "intake.meals")!;
    expect(meals.lines.map((line) => line.factRefs.length)).toEqual([1, 0]);
  });

  it("is the same request for the same snapshot and request id (deterministic, no clock or randomness)", async () => {
    const current = await snapshotOf("HIDDEN_LIMITATION", "en-SG");
    expect(JSON.stringify(ready(current).request)).toBe(JSON.stringify(ready(structuredClone(current)).request));
  });

  it("refuses anything but the current unapproved deterministic snapshot", async () => {
    const current = await snapshotOf("ORDINARY", "en-SG");
    expect(build({ ...current, status: "APPROVED", patientApproval: { state: "APPROVED", approvedAt: NOW, approvedContentHash: current.rendering.contentHash } })).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOT_CURRENT_DETERMINISTIC" });
    expect(build({ ...current, status: "INVALIDATED", invalidation: { invalidatedAt: NOW, reason: "SOURCE_CORRECTED" } })).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOT_CURRENT_DETERMINISTIC" });
    expect(build({ ...current, status: "SUPERSEDED" })).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOT_CURRENT_DETERMINISTIC" });
    expect(build(await asLegacy9c1Payload(current))).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOT_CURRENT_DETERMINISTIC" });
    const ai = { ...current, composition: { method: "AI_ASSISTED" as const, templateVersion: current.composition.templateVersion, aiInvocationAuditRef: REQUEST_ID, validatedAt: NOW } };
    expect(build(ai)).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOT_CURRENT_DETERMINISTIC" });
  });

  it("fails closed on a stored text it cannot reconstruct, a snapshot with nothing to phrase, too many facts or a redactable label", async () => {
    const current = await snapshotOf("ORDINARY", "en-SG");
    const tampered = structuredClone(current);
    const block = tampered.sections.find((section) => section.sectionId === "MEASUREMENTS")!.blocks[0] as { renderedText: string };
    block.renderedText = block.renderedText.replace("6.2", "6.3");
    expect(build(tampered)).toEqual({ kind: "NOT_ELIGIBLE", reason: "LAYOUT_UNRECOGNISED" });

    const insulinOnly = (await renderDeterministicCareSummary({ ...syntheticCareDraft("RICH", "en-SG"), appointment: null, questions: [], groups: syntheticCareDraft("RICH", "en-SG").groups.filter((group) => group.key === "INSULIN") })).payload;
    expect(build(insulinOnly)).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOTHING_TO_PHRASE" });
    // Questions alone: the patient's words are never reworded, so there is nothing an AI-assisted replacement could change.
    expect(build(await snapshotOf("MISSING_DATA", "en-SG"))).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOTHING_TO_PHRASE" });

    const draft = syntheticCareDraft("ORDINARY", "en-SG");
    const many = draft.groups[0]!.facts[0]!;
    const readings = Array.from({ length: 33 }, (_, index) => ({ ...many, ref: { ...many.ref, recordId: `0000b1b2-0000-4000-8000-${String(index).padStart(12, "0")}`, revisionId: `0000b1b3-0000-4000-8000-${String(index).padStart(12, "0")}` } }));
    const tooMany = (await renderDeterministicCareSummary({ ...draft, questions: [], groups: [{ key: "GLUCOSE", facts: readings as never }] })).payload;
    expect(build(tooMany)).toEqual({ kind: "NOT_ELIGIBLE", reason: "TOO_MANY_FACTS" });

    const rich = syntheticCareDraft("RICH", "en-SG");
    const withPhone = (await renderDeterministicCareSummary({ ...rich, appointment: { ...rich.appointment!, label: "Call 6123 4567 first" } })).payload;
    expect(build(withPhone)).toEqual({ kind: "NOT_ELIGIBLE", reason: "TEXT_NOT_SENDABLE" });
  });
});
