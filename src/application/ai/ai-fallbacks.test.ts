import { describe, expect, it } from "vitest";
import { AI_TASK_TYPES, aiTaskRequestSchema, type AiTaskRequest } from "@/domain/ai";
import { requestFixture } from "@/domain/ai/ai-test-fixtures";
import { AI_REASON_CODES, aiFallbackResultSchema, createDeterministicFallback } from "./ai-fallbacks";
import { AI_MEANING_REGISTRY } from "./ai-meaning-registry";

/** Packet 11A Task 2: every task has a local deterministic fallback (ai-system-spec Section 10). */

const request = (taskType: (typeof AI_TASK_TYPES)[number], locale: "en-SG" | "zh-SG" = "en-SG") =>
  aiTaskRequestSchema.parse({ ...requestFixture(taskType), locale }) as AiTaskRequest;

describe("closed reason codes", () => {
  it("is exactly the matrix Section 5 non-patient-facing list", () => {
    expect([...AI_REASON_CODES]).toEqual([
      "TASK_DISABLED", "PROFILE_NOT_PERMITTED", "MISSING_CONFIGURATION", "PRIVACY_REJECTED", "PAYLOAD_INVALID", "BUDGET_EXCEEDED",
      "TRANSPORT_FAILED", "PROVIDER_TIMEOUT", "PROVIDER_REJECTED", "PROVIDER_RATE_LIMITED", "PROVIDER_FAILED", "MODEL_ABSTAINED",
      "SCHEMA_INVALID", "REFERENCE_MISMATCH", "FACT_FIDELITY_FAILED", "AUTHORITY_BOUNDARY_VIOLATION", "CLINICAL_MEANING_VIOLATION",
      "LOCALE_INVALID", "OUTPUT_BUDGET_EXCEEDED", "OPERATIONAL_SPEND_LOCKED", "REQUEST_CANCELLED", "SOURCE_CHANGED",
    ]);
  });
});

describe("deterministic fallbacks", () => {
  it.each(AI_TASK_TYPES)("%s returns a typed, closed, locale- and reason-bound fallback in both locales", (taskType) => {
    for (const locale of ["en-SG", "zh-SG"] as const) {
      const result = createDeterministicFallback(request(taskType, locale), "TASK_DISABLED");
      expect(aiFallbackResultSchema.safeParse(result).success).toBe(true);
      expect(result).toMatchObject({ kind: "DETERMINISTIC_FALLBACK", taskType, locale, reason: "TASK_DISABLED" });
      // Fallbacks never contain generated prose. The only text is reviewed registry limitation copy (Option B).
      const presentation = result.presentation as { limitations?: Array<{ text: string }> };
      const reviewed = new Set(AI_MEANING_REGISTRY.entries.filter((entry) => entry.kind === "LIMITATION_TEXT" && entry.locale === locale).map((entry) => entry.text));
      for (const limitation of presentation.limitations ?? []) expect(reviewed.has(limitation.text), limitation.text).toBe(true);
      expect(JSON.stringify({ ...result, presentation: { ...presentation, limitations: [] } })).not.toMatch(/"text"|"label"|"headline"|"message"/);
    }
  });

  it("maps each task to its Section 10 deterministic presentation", () => {
    expect(createDeterministicFallback(request("EXTRACT_CANDIDATE_FACTS"), "PROVIDER_TIMEOUT").presentation).toEqual({
      kind: "ORIGINAL_NOTE_PRESERVED", excerptRef: "fact-1", noticeRequired: true, manualEntryOffered: true, extractedFacts: [],
    });
    expect(createDeterministicFallback(request("EXPLAIN_PATTERN"), "SCHEMA_INVALID").presentation).toEqual({
      kind: "TEMPLATE_PATTERN_CARD", claimRef: "claim-1", evidenceFactRefs: ["fact-1", "fact-2", "fact-3"], evidenceCount: 3, limitationRefs: ["limitation-1"],
      limitations: [{ limitationRef: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE", text: "This describes your records; it does not explain the cause." }],
      limitationCopyComplete: true,
      noticeRequired: false,
    });
    expect(createDeterministicFallback(request("DRAFT_NEUTRAL_INQUIRY"), "MODEL_ABSTAINED").presentation).toEqual({
      kind: "APPROVED_INQUIRY_TEMPLATE", questionIntentCode: "CONFIRM_RECORDED_TIME", optionRefs: ["option-1", "option-2"], noticeRequired: false,
    });
    expect(createDeterministicFallback(request("ANSWER_BOUNDED_RECORD_QUERY"), "TRANSPORT_FAILED").presentation).toEqual({
      kind: "SELECTED_RECORD_LIST", recordRefs: ["record-1"], noticeRequired: false,
    });
    expect(createDeterministicFallback(request("DRAFT_CARE_PREPARATION_SUMMARY"), "FACT_FIDELITY_FAILED").presentation).toEqual({
      kind: "STRUCTURED_PREVIEW", sections: [{ sectionRef: "section-1", factRefs: ["fact-1"] }, { sectionRef: "section-2", factRefs: ["fact-2"] }], noticeRequired: false,
    });
    expect(createDeterministicFallback(request("PHRASE_NON_CLINICAL_RESPONSE"), "LOCALE_INVALID").presentation).toEqual({
      kind: "REVIEWED_LOCALE_STRING", intentCode: "RECORD_SAVED_ACKNOWLEDGEMENT", noticeRequired: false,
    });
  });

  it("needs no network, provider configuration or clock, and is deterministic", () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network forbidden");
    }) as typeof fetch;
    try {
      for (const taskType of AI_TASK_TYPES) {
        expect(createDeterministicFallback(request(taskType), "MISSING_CONFIGURATION")).toEqual(createDeterministicFallback(request(taskType), "MISSING_CONFIGURATION"));
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects an unknown reason code", () => {
    expect(() => createDeterministicFallback(request("EXPLAIN_PATTERN"), "PROVIDER_SAID_SO" as never)).toThrow("UNKNOWN_AI_REASON");
  });
});
