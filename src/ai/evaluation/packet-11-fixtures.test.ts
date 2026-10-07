import { describe, expect, it } from "vitest";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { AI_LOCALES, aiTaskRequestSchema } from "@/domain/ai";
import {
  AI_EVALUATION_CATEGORIES,
  AI_FORBIDDEN_MEANING_TEMPTATIONS,
  EXPLAIN_QUALIFICATION_EXCLUDED_CATEGORIES,
  PACKET_11_FIXTURE_SET_REVISION,
  PACKET_11_FIXTURES,
  PACKET_11_OFFLINE_NEGATIVE_FIXTURES,
  SMOKE_FIXTURE_IDS,
  approvedFixtureLimitations,
  fixturesForPhase,
} from "./packet-11-fixtures";

/** Packet 11B Task 4: synthetic bilingual qualification fixtures (no real patient data). */

const TASKS = ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const;

describe("Packet 11 evaluation fixtures", () => {
  it("covers every required category for both tasks and both locales", () => {
    expect(AI_FORBIDDEN_MEANING_TEMPTATIONS).toEqual(["RISK", "CAUSE", "CLASSIFICATION", "PREDICTION", "DIAGNOSIS", "MEDICATION_ACTION", "DOSE", "ADHERENCE", "TRIAGE", "AUTHORITY"]);
    expect(AI_EVALUATION_CATEGORIES).toEqual([
      "ORDINARY",
      "MISSING_DATA",
      "AMBIGUOUS",
      "ABSTENTION",
      "INVALID_REFERENCE",
      "CHANGED_NUMBER_UNIT",
      "HIDDEN_LIMITATION",
      "PROMPT_INJECTION",
      ...AI_FORBIDDEN_MEANING_TEMPTATIONS.map((meaning) => `FORBIDDEN_${meaning}`),
    ]);
    for (const taskType of TASKS) {
      for (const locale of AI_LOCALES) {
        const categories = PACKET_11_FIXTURES.filter((fixture) => fixture.taskType === taskType && fixture.locale === locale).map((fixture) => fixture.category);
        // packet11-fixtures.11b.2: EXPLAIN_PATTERN AMBIGUOUS is excluded (its only limitations have no approved meaning).
        const expected = taskType === "EXPLAIN_PATTERN" ? AI_EVALUATION_CATEGORIES.filter((category) => category !== "AMBIGUOUS") : AI_EVALUATION_CATEGORIES;
        expect(categories, `${taskType} ${locale}`).toEqual(expected);
      }
    }
    expect(PACKET_11_FIXTURES).toHaveLength(70);
  });

  it("uses only the two remote-eligible tasks", () => {
    expect(new Set(PACKET_11_FIXTURES.map((fixture) => fixture.taskType))).toEqual(new Set(TASKS));
  });

  it("has unique ids and unique invocation-local request ids", () => {
    expect(new Set(PACKET_11_FIXTURES.map((fixture) => fixture.id)).size).toBe(70);
    expect(new Set(PACKET_11_FIXTURES.map((fixture) => fixture.request.requestId)).size).toBe(70);
  });

  it("is a valid internal request that projects unchanged: the run measures the model, not redaction or budgets", () => {
    for (const fixture of PACKET_11_FIXTURES) {
      expect(aiTaskRequestSchema.safeParse(fixture.request).success, fixture.id).toBe(true);
      const projected = projectProviderTaskPayload(fixture.request, AI_TASK_RUNTIME_BUNDLES[fixture.taskType]);
      expect(projected.kind, fixture.id).toBe("PROJECTED");
      if (projected.kind !== "PROJECTED") continue;
      const sent = projected.payload.facts.map((fact) => fact.value);
      expect(sent, fixture.id).toEqual(fixture.request.facts.map((fact) => fact.value));
    }
  });

  it("is synthetic: every patient-authored text is marked as a demo and carries no identifier or local provenance", () => {
    for (const fixture of PACKET_11_FIXTURES) {
      for (const fact of fixture.request.facts) {
        expect(fact.sources, fixture.id).toEqual([]);
        if (fact.value.kind === "TEXT" && fact.field === "QUESTION_TEXT") expect(fact.value.text, fixture.id).toMatch(/\((demo|演示)\)$/);
      }
      expect(JSON.stringify(fixture.request.facts.map((fact) => fact.value)), fixture.id).not.toMatch(/@|\b[STFGM]\d{7}[A-Z]\b|\b[689]\d{3}\s?\d{4}\b|https?:/i);
    }
  });

  it("includes Chinese and mixed-language attempts for zh-SG", () => {
    const zh = PACKET_11_FIXTURES.filter((fixture) => fixture.locale === "zh-SG").flatMap((fixture) => fixture.request.facts.flatMap((fact) => (fact.value.kind === "TEXT" ? [fact.value.text] : [])));
    expect(zh.some((text) => /[㐀-鿿]/.test(text) && !/[A-Za-z]{3}/.test(text.replace("demo", "")))).toBe(true);
    expect(zh.some((text) => /[㐀-鿿]/.test(text) && /[A-Za-z]{3}/.test(text.replace("demo", "")))).toBe(true);
  });

  it("defines a four-call smoke phase: one ordinary fixture per task and locale", () => {
    const smoke = fixturesForPhase("SMOKE");
    expect(smoke.map((fixture) => fixture.id)).toEqual([...SMOKE_FIXTURE_IDS]);
    expect(smoke.map((fixture) => [fixture.taskType, fixture.locale, fixture.category])).toEqual([
      ["EXPLAIN_PATTERN", "en-SG", "ORDINARY"],
      ["EXPLAIN_PATTERN", "zh-SG", "ORDINARY"],
      ["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG", "ORDINARY"],
      ["DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG", "ORDINARY"],
    ]);
    expect(fixturesForPhase("FULL")).toHaveLength(70);
    expect(Object.isFrozen(PACKET_11_FIXTURES)).toBe(true);
  });
});

describe("qualification fixture set packet11-fixtures.11b.2 (owner instruction 2026-10-05)", () => {
  it("is revision 11b.2: 70 fixtures, EXPLAIN_PATTERN AMBIGUOUS excluded in both locales, care-summary AMBIGUOUS kept", () => {
    expect(["packet11-fixtures.11b.2", "packet11-fixtures.11b.3"]).toContain(PACKET_11_FIXTURE_SET_REVISION);
    expect(EXPLAIN_QUALIFICATION_EXCLUDED_CATEGORIES).toEqual(["AMBIGUOUS"]);
    const ids = PACKET_11_FIXTURES.map((fixture) => fixture.id);
    expect(ids).not.toContain("p11.explain-pattern.en-sg.ambiguous");
    expect(ids).not.toContain("p11.explain-pattern.zh-sg.ambiguous");
    expect(ids).toContain("p11.draft-care-preparation-summary.en-sg.ambiguous");
    expect(ids).toContain("p11.draft-care-preparation-summary.zh-sg.ambiguous");
  });

  it("fails explicitly when unsupported limitations are removed and no approved limitation remains", () => {
    for (const locale of AI_LOCALES) {
      expect(() => approvedFixtureLimitations(["HIGH_VARIABILITY", "LIMITED_COMPARISON"], locale)).toThrow("FIXTURE_NO_APPROVED_LIMITATION");
      expect(() => approvedFixtureLimitations(["CARE_PLAN_BOUNDARY"], locale)).toThrow("FIXTURE_NO_APPROVED_LIMITATION");
    }
  });

  it("removes unsupported codes only while an approved limitation remains, and never substitutes one", () => {
    expect(approvedFixtureLimitations(["INSUFFICIENT_TIME_PRECISION", "SPARSE_RECORDING"], "en-SG")).toEqual(["SPARSE_RECORDING"]);
    expect(approvedFixtureLimitations(["SPARSE_RECORDING", "CONTEXT_OVERLAP", "RECENCY_LIMIT", "DOES_NOT_ESTABLISH_CAUSE"], "zh-SG")).toEqual(["SPARSE_RECORDING", "DOES_NOT_ESTABLISH_CAUSE"]);
    expect(approvedFixtureLimitations(["UNKNOWN_NEGATIVE_STATUS"], "zh-SG")).toEqual(["UNKNOWN_NEGATIVE_STATUS"]);
    // The builder's long-standing default applies only when a scenario names no limitation at all.
    expect(approvedFixtureLimitations(undefined, "en-SG")).toEqual(["DOES_NOT_ESTABLISH_CAUSE"]);
    expect(() => approvedFixtureLimitations([], "en-SG")).toThrow("FIXTURE_NO_APPROVED_LIMITATION");
  });

  it("pins every EXPLAIN_PATTERN category's approved limitation codes", () => {
    const codes = (category: string) => (PACKET_11_FIXTURES.find((fixture) => fixture.id === `p11.explain-pattern.en-sg.${category}`)!.request.taskPayload as { limitations: { code: string }[] }).limitations.map((entry) => entry.code);
    expect(codes("missing-data")).toEqual(["SPARSE_RECORDING", "DOES_NOT_ESTABLISH_CAUSE"]);
    expect(codes("abstention")).toEqual(["SPARSE_RECORDING"]);
    expect(codes("changed-number-unit")).toEqual(["DOES_NOT_ESTABLISH_CAUSE"]);
    expect(codes("hidden-limitation")).toEqual(["SPARSE_RECORDING", "DOES_NOT_ESTABLISH_CAUSE"]);
    expect(codes("forbidden-cause")).toEqual(["DOES_NOT_ESTABLISH_CAUSE"]);
    expect(codes("ordinary")).toEqual(["DOES_NOT_ESTABLISH_CAUSE"]);
  });
});

describe("qualification fixture set packet11-fixtures.11b.3: explicit expected outcomes (owner instruction 2026-10-05)", () => {
  const ABSTENTION_IDS = ["p11.explain-pattern.en-sg.abstention", "p11.explain-pattern.zh-sg.abstention", "p11.draft-care-preparation-summary.en-sg.abstention", "p11.draft-care-preparation-summary.zh-sg.abstention"];

  it("is revision 11b.3, still 70 fixtures", () => {
    expect(PACKET_11_FIXTURE_SET_REVISION).toBe("packet11-fixtures.11b.3");
    expect(PACKET_11_FIXTURES).toHaveLength(70);
  });

  it("records an explicit expected outcome on every live and offline fixture", () => {
    for (const fixture of [...PACKET_11_FIXTURES, ...PACKET_11_OFFLINE_NEGATIVE_FIXTURES]) expect(["SUCCESS", "ABSTAIN", "FALLBACK"], fixture.id).toContain(fixture.expectedOutcome);
  });

  it("expects SUCCESS for every live fixture, including the four ABSTENTION-category fixtures", () => {
    for (const fixture of PACKET_11_FIXTURES) expect(fixture.expectedOutcome, fixture.id).toBe("SUCCESS");
    for (const id of ABSTENTION_IDS) expect(PACKET_11_FIXTURES.find((fixture) => fixture.id === id)?.expectedOutcome, id).toBe("SUCCESS");
  });

  it("does not invent a model-abstention requirement: no fixture expects ABSTAIN", () => {
    expect([...PACKET_11_FIXTURES, ...PACKET_11_OFFLINE_NEGATIVE_FIXTURES].filter((fixture) => fixture.expectedOutcome === "ABSTAIN")).toEqual([]);
  });

  it("backs each expectation with the contract: SUCCESS inputs project completely, FALLBACK inputs never reach a provider", () => {
    for (const fixture of PACKET_11_FIXTURES) expect(projectProviderTaskPayload(fixture.request, AI_TASK_RUNTIME_BUNDLES[fixture.taskType]).kind, fixture.id).toBe("PROJECTED");
    for (const fixture of PACKET_11_OFFLINE_NEGATIVE_FIXTURES) {
      expect(fixture.expectedOutcome, fixture.id).toBe("FALLBACK");
      expect(projectProviderTaskPayload(fixture.request, AI_TASK_RUNTIME_BUNDLES[fixture.taskType]), fixture.id).toEqual({ kind: "FALLBACK", reason: "PAYLOAD_INVALID" });
    }
  });

  it("moves both bundles to a new fixture-set component and bundle version, and every request names its bundle", () => {
    for (const task of TASKS) {
      const bundle = AI_TASK_RUNTIME_BUNDLES[task];
      expect(bundle.fixtureSet.version, task).toBe("11b.3");
      expect(bundle.bundleKey, task).toMatch(/@11b\.3$/);
      for (const fixture of PACKET_11_FIXTURES.filter((entry) => entry.taskType === task)) expect(fixture.request.runtimeBundleKey, fixture.id).toBe(bundle.bundleKey);
    }
  });
});
