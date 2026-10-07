import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_MEANING_REGISTRY } from "@/application/ai/ai-meaning-registry";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { resolveAiTaskBundle } from "@/application/ai/ai-runtime-bundles";
import { EXPLAINABLE_PATTERN_FAMILIES, EXPLANATION_LIMITATION_CODES } from "@/domain/ai/ai-task-contracts";
import { PATTERN_LIMITATION_CODES } from "@/domain/patterns/pattern-registry";
import { diagnoseMeaningFailure } from "./packet-11-meaning-diagnostics";
import { PACKET_11_FIXTURES } from "./packet-11-fixtures";

/**
 * Packet 11B approved-meaning authority inventory. Owner approval
 * (2026-10-05) of review-matrix §13 covers exactly five codes for the
 * synthetic hackathon scope; it is not clinical validation or independent
 * professional linguistic certification. The other nine codes stay in the
 * domain type but are excluded from the registry and the qualification
 * fixtures because no approved meaning or evaluator exists.
 */

type AuthorityStatus = "APPROVED_SYNTHETIC_SCOPE" | "EXCLUDED_NO_APPROVED_MEANING";
const INVENTORY: Readonly<Record<string, AuthorityStatus>> = {
  COMPARABLE_SLOT_TREND: "APPROVED_SYNTHETIC_SCOPE",
  FAMILIAR_OR_FREQUENT_ITEM: "APPROVED_SYNTHETIC_SCOPE",
  DOES_NOT_ESTABLISH_CAUSE: "APPROVED_SYNTHETIC_SCOPE",
  SPARSE_RECORDING: "APPROVED_SYNTHETIC_SCOPE",
  UNKNOWN_NEGATIVE_STATUS: "APPROVED_SYNTHETIC_SCOPE",
  LIMITED_COMPARISON: "EXCLUDED_NO_APPROVED_MEANING",
  HIGH_VARIABILITY: "EXCLUDED_NO_APPROVED_MEANING",
  CONTRADICTORY_EVIDENCE: "EXCLUDED_NO_APPROVED_MEANING",
  CONTEXT_OVERLAP: "EXCLUDED_NO_APPROVED_MEANING",
  CARE_PLAN_BOUNDARY: "EXCLUDED_NO_APPROVED_MEANING",
  INSUFFICIENT_TIME_PRECISION: "EXCLUDED_NO_APPROVED_MEANING",
  IDENTITY_UNCERTAINTY: "EXCLUDED_NO_APPROVED_MEANING",
  MEASUREMENT_METHOD_CHANGE: "EXCLUDED_NO_APPROVED_MEANING",
  RECENCY_LIMIT: "EXCLUDED_NO_APPROVED_MEANING",
};
const approved = Object.entries(INVENTORY).filter(([, status]) => status === "APPROVED_SYNTHETIC_SCOPE").map(([code]) => code).sort();
const excluded = Object.entries(INVENTORY).filter(([, status]) => status === "EXCLUDED_NO_APPROVED_MEANING").map(([code]) => code);

describe("approved-meaning authority inventory", () => {
  it("inventories exactly the claim-family and limitation codes that can enter EXPLAIN_PATTERN; the domain keeps every code", () => {
    expect(Object.keys(INVENTORY).sort()).toEqual([...EXPLAINABLE_PATTERN_FAMILIES, ...EXPLANATION_LIMITATION_CODES].sort());
    for (const code of excluded) expect(PATTERN_LIMITATION_CODES).toContain(code);
  });

  it("the registry covers exactly the approved codes in both locales and nothing else", () => {
    expect([...new Set(AI_MEANING_REGISTRY.entries.map((entry) => entry.code))].sort()).toEqual(approved);
    for (const code of approved) expect(AI_MEANING_REGISTRY.entries.filter((entry) => entry.code === code).map((entry) => entry.locale).sort(), code).toEqual(["en-SG", "zh-SG"]);
  });
});

describe("conflicts resolved by the owner decision", () => {
  const quoted = (source: string) => EXPLANATION_LIMITATION_CODES.filter((code) => source.includes(`"${code}"`));
  const fixtureCodes = () => new Set(PACKET_11_FIXTURES.filter((fixture) => fixture.taskType === "EXPLAIN_PATTERN").flatMap((fixture) => (fixture.request.taskPayload as { limitations: { code: string }[] }).limitations.map((entry) => entry.code)));

  it("Packet 7A evaluators emit only SPARSE_RECORDING and UNKNOWN_NEGATIVE_STATUS, both approved", () => {
    const emitted = new Set(["comparable-slot-trend-evaluator.ts", "familiar-or-frequent-item-evaluator.ts"].flatMap((file) => quoted(readFileSync(join(process.cwd(), "src/patterns", file), "utf8"))));
    expect([...emitted].sort()).toEqual(["SPARSE_RECORDING", "UNKNOWN_NEGATIVE_STATUS"]);
    for (const code of emitted) expect(INVENTORY[code]).toBe("APPROVED_SYNTHETIC_SCOPE");
  });

  it("the qualification fixtures use no excluded code", () => {
    expect([...fixtureCodes()].filter((code) => excluded.includes(code))).toEqual([]);
  });
});

describe("the full-evaluation failure stays characterised (meaning rules unchanged)", () => {
  it("'is high' wording is still rejected by the classification rule wherever the model writes it", () => {
    // The live AMBIGUOUS fixture is excluded (packet11-fixtures.11b.2); the ordinary fixture characterises the same rule.
    const ordinary = PACKET_11_FIXTURES.find((fixture) => fixture.id === "p11.explain-pattern.en-sg.ordinary")!;
    const output = (evidence: string) => ({
      schemaVersion: "ai-output.explain-pattern@11b.1",
      taskType: "EXPLAIN_PATTERN",
      outcome: "SUCCESS",
      locale: "en-SG",
      inputRefsUsed: ["claim-1", "fact-1", "fact-2", "fact-3"],
      payload: {
        headline: { text: "Recorded values were 6.2 and 7.1 mmol/L.", claimRefs: ["claim-1"] },
        observation: { text: "The recent recorded values were 6.2 and 7.1 mmol/L.", claimRefs: ["claim-1"] },
        evidence: { text: evidence, factRefs: ["fact-1", "fact-2", "fact-3"] },
      },
    });
    const verdict = (candidate: unknown) => {
      const result = validateAiTaskOutput(ordinary.request, resolveAiTaskBundle(ordinary.taskType, ordinary.locale), candidate);
      return result.kind === "ACCEPTED" ? "ACCEPTED" : result.reason;
    };
    const failing = output("This uses 10 recorded readings, and their variability is high.");
    expect(verdict(failing)).toBe("CLINICAL_MEANING_VIOLATION");
    expect(diagnoseMeaningFailure(ordinary, failing)?.findings).toEqual([{ category: "CLINICAL_CLASSIFICATION", rule: "clinical.classification.en", path: "payload.evidence.text", count: 1 }]);
    expect(verdict(output("This uses 10 recorded readings."))).toBe("ACCEPTED");
  });
});
