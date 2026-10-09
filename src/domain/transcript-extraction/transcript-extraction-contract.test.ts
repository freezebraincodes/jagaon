// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_FACT_KINDS,
  TRANSCRIPT_EXTRACTION_CONTRACT_VERSION,
  TRANSCRIPT_EXTRACTION_LIMITS,
  TRANSCRIPT_EXTRACTION_TASK,
  extractionOutputJsonSchema,
  extractionOutputSchema,
  extractionRequestSchema,
} from "./transcript-extraction-contract";

/** Packet 13 (P13X): the EXTRACT_VOICE_FACTS task contract, transcript-extraction.13.1. Synthetic text only. */

const request = { taskType: "EXTRACT_VOICE_FACTS", contractVersion: "transcript-extraction.13.1", locale: "en-SG", transcript: "Sugar 6.5 before breakfast", allowedFactKinds: ["GLUCOSE_READING"] };

describe("transcript extraction request", () => {
  it("names its own task and version", () => {
    expect(TRANSCRIPT_EXTRACTION_TASK).toBe("EXTRACT_VOICE_FACTS");
    expect(TRANSCRIPT_EXTRACTION_CONTRACT_VERSION).toBe("transcript-extraction.13.1");
    expect(EXTRACTION_FACT_KINDS).toEqual(["GLUCOSE_READING", "MEAL_OR_FOOD_NOTE", "MEDICINE_OCCURRENCE"]);
  });

  it("accepts only the transcript, the locale and the allowed fact kinds", () => {
    expect(extractionRequestSchema.safeParse(request).success).toBe(true);
    for (const extra of [{ medicines: ["metformin"] }, { recordId: "r1" }, { profile: "HACKATHON_DEMO" }, { history: [] }, { displayName: "Ah Ma" }]) {
      expect(extractionRequestSchema.safeParse({ ...request, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("refuses an empty, over-long or control-character transcript, an unknown locale, kind or version and duplicate kinds", () => {
    const bad = [
      { transcript: "" },
      { transcript: "a".repeat(TRANSCRIPT_EXTRACTION_LIMITS.transcriptMaxCodePoints + 1) },
      { transcript: "six\u0007point five" },
      { locale: "ms-MY" },
      { allowedFactKinds: [] },
      { allowedFactKinds: ["DIAGNOSIS"] },
      { allowedFactKinds: ["GLUCOSE_READING", "GLUCOSE_READING"] },
      { contractVersion: "transcript-extraction.13.0" },
      { taskType: "EXTRACT_CANDIDATE_FACTS" },
    ];
    for (const patch of bad) expect(extractionRequestSchema.safeParse({ ...request, ...patch }).success, JSON.stringify(patch).slice(0, 60)).toBe(false);
    expect(extractionRequestSchema.safeParse({ ...request, transcript: "血糖六点五".repeat(240) }).success).toBe(true);
  });
});

describe("transcript extraction output", () => {
  const fact = { kind: "GLUCOSE_READING", sourceSpan: { start: 0, end: 9, text: "Sugar 6.5" }, value: "6.5", unit: null, status: null, negated: false, uncertain: false, unresolvedPhrase: null };

  it("is strict: no free text, advice, medicine name, dose suggestion or time field", () => {
    expect(extractionOutputSchema.safeParse({ facts: [fact], unsupportedSpans: [] }).success).toBe(true);
    for (const extra of [{ advice: "eat less" }, { medicineName: "insulin" }, { suggestedDose: "10" }, { time: "08:00" }, { note: "x" }]) {
      expect(extractionOutputSchema.safeParse({ facts: [{ ...fact, ...extra }], unsupportedSpans: [] }).success, Object.keys(extra)[0]).toBe(false);
    }
    expect(extractionOutputSchema.safeParse({ facts: [fact], unsupportedSpans: [], summary: "ok" }).success).toBe(false);
  });

  it("bounds the fact and unsupported counts and the value format", () => {
    expect(extractionOutputSchema.safeParse({ facts: Array(TRANSCRIPT_EXTRACTION_LIMITS.maxFacts + 1).fill(fact), unsupportedSpans: [] }).success).toBe(false);
    expect(extractionOutputSchema.safeParse({ facts: [], unsupportedSpans: Array(TRANSCRIPT_EXTRACTION_LIMITS.maxUnsupportedSpans + 1).fill(fact.sourceSpan) }).success).toBe(false);
    for (const value of ["6,5", "six", "-1", "12345", "6.555", ""]) expect(extractionOutputSchema.safeParse({ facts: [{ ...fact, value }], unsupportedSpans: [] }).success, value).toBe(false);
  });

  it("publishes a strict JSON schema with every property required and no additional properties", () => {
    const schema = extractionOutputJsonSchema() as { additionalProperties: boolean; required: string[]; properties: { facts: { items: { additionalProperties: boolean; required: string[] } } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["facts", "unsupportedSpans"]);
    expect(schema.properties.facts.items.additionalProperties).toBe(false);
    expect(schema.properties.facts.items.required).toEqual(["kind", "sourceSpan", "value", "unit", "status", "negated", "uncertain", "unresolvedPhrase"]);
  });
});
