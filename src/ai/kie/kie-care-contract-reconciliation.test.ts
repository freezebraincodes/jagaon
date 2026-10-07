import { describe, expect, it } from "vitest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { aiTaskOutputVariantSchema } from "@/domain/ai";
import { outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { CARE_CONTRACT_RECONCILIATION, providerOutputJsonSchema } from "./kie-responses-contracts";

/**
 * Packet 11B corrective pass: every rule the 11A care-summary contract enforces
 * is either represented in the provider-facing schema or deliberately enforced
 * after parsing by the local validator. Kie documents no keyword-level
 * enforcement, so representation is a request to the provider, never a claim
 * that it is enforced.
 */

type Node = Record<string, any>;
const schema = providerOutputJsonSchema("DRAFT_CARE_PREPARATION_SUMMARY", "en-SG") as Node;
const payload = schema.properties.payload.anyOf[0];
const section = payload.properties.sections.items;
const bullet = section.properties.bullets.items;
const zodSuccess = aiTaskOutputVariantSchema("DRAFT_CARE_PREPARATION_SUMMARY", "SUCCESS");
const care = () => structuredClone(outputFixture("DRAFT_CARE_PREPARATION_SUMMARY")) as Node;
const zodAccepts = (mutate: (output: Node) => void) => {
  const output = care();
  mutate(output);
  return zodSuccess.safeParse(output).success;
};
const localReason = (mutate: (output: Node) => void) => {
  const output = care();
  mutate(output);
  const result = validateAiTaskOutput(requestFixture("DRAFT_CARE_PREPARATION_SUMMARY"), AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY, output);
  return result.kind === "ACCEPTED" ? "ACCEPTED" : result.reason;
};

describe("care-summary contract reconciliation", () => {
  it("documents every rule as provider-represented or local-only, with no claim of provider enforcement", () => {
    expect(CARE_CONTRACT_RECONCILIATION.map((entry) => entry.rule)).toEqual([
      "required_fields",
      "additional_properties",
      "enums",
      "array_cardinality",
      "uniqueness",
      "patterns",
      "string_lengths",
      "reference_closure",
      "section_scope",
      "coverage_and_fidelity",
      "meaning_locale_budget",
    ]);
    for (const entry of CARE_CONTRACT_RECONCILIATION) {
      expect(entry.localValidator).toBe("ENFORCED");
      expect(["REPRESENTED", "NOT_EXPRESSIBLE"]).toContain(entry.providerSchema);
      expect(entry.providerEnforcement).toBe("UNDOCUMENTED");
    }
  });

  it("represents required fields and closed objects at every level", () => {
    for (const node of [schema, payload, section, bullet]) {
      expect(node.additionalProperties).toBe(false);
      expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
    }
    expect(zodAccepts((output) => delete output.payload.sections[0].sectionRef)).toBe(false);
    expect(zodAccepts((output) => (output.payload.sections[0].extra = 1))).toBe(false);
  });

  it("represents the envelope enums exactly as the contract and bundle require", () => {
    expect(schema.properties.taskType.enum).toEqual(["DRAFT_CARE_PREPARATION_SUMMARY"]);
    expect(schema.properties.locale.enum).toEqual(["en-SG"]);
    expect(schema.properties.outcome.enum).toEqual(["SUCCESS", "ABSTAIN"]);
    expect(schema.properties.schemaVersion.enum).toEqual(["ai-output.draft-care-preparation-summary@11a.1"]);
    expect(zodAccepts((output) => (output.locale = "fr-FR"))).toBe(false);
  });

  it("represents the same array cardinality the contract enforces", () => {
    expect([payload.properties.sections.minItems, payload.properties.sections.maxItems]).toEqual([1, 8]);
    expect([section.properties.bullets.minItems, section.properties.bullets.maxItems]).toEqual([1, 32]);
    expect([bullet.properties.factRefs.minItems, bullet.properties.factRefs.maxItems]).toEqual([1, 32]);
    expect(schema.properties.inputRefsUsed.maxItems).toBe(64);
    expect(zodAccepts((output) => (output.payload.sections = []))).toBe(false);
    expect(zodAccepts((output) => (output.payload.sections[0].bullets = []))).toBe(false);
    expect(zodAccepts((output) => (output.payload.sections[0].bullets = Array.from({ length: 33 }, () => output.payload.sections[0].bullets[0])))).toBe(false);
    expect(zodAccepts((output) => (output.payload.sections[0].bullets = Array.from({ length: 32 }, () => output.payload.sections[0].bullets[0])))).toBe(true);
  });

  it("represents uniqueness exactly where the contract enforces it, and not on bullets", () => {
    expect(payload.properties.sections.uniqueItems).toBe(true);
    expect(bullet.properties.factRefs.uniqueItems).toBe(true);
    expect(schema.properties.inputRefsUsed.uniqueItems).toBe(true);
    expect(section.properties.bullets.uniqueItems).toBeUndefined();
    expect(zodAccepts((output) => (output.payload.sections[0].bullets[0].factRefs = ["fact-1", "fact-1"]))).toBe(false);
    expect(zodAccepts((output) => (output.payload.sections = [output.payload.sections[0], output.payload.sections[0]]))).toBe(false);
    expect(zodAccepts((output) => (output.inputRefsUsed = [...output.inputRefsUsed, output.inputRefsUsed[0]]))).toBe(false);
  });

  it("represents patterns and string lengths", () => {
    expect(section.properties.sectionRef.pattern).toBe("^section-[1-9][0-9]{0,2}$");
    expect(bullet.properties.factRefs.items.pattern).toBe("^fact-[1-9][0-9]{0,2}$");
    expect([bullet.properties.text.minLength, bullet.properties.text.maxLength]).toEqual([1, 400]);
    expect(zodAccepts((output) => (output.payload.sections[0].bullets[0].text = "x".repeat(401)))).toBe(false);
    expect(zodAccepts((output) => (output.payload.sections[0].sectionRef = "section-x"))).toBe(false);
  });

  it("enforces the rules the JSON Schema cannot express locally, after parsing", () => {
    expect(localReason(() => undefined)).toBe("ACCEPTED");
    // Reference closure: an unsupplied section, or a cited section/fact missing from inputRefsUsed.
    expect(localReason((output) => (output.payload.sections[1].sectionRef = "section-9"))).toBe("REFERENCE_MISMATCH");
    expect(localReason((output) => (output.inputRefsUsed = output.inputRefsUsed.filter((ref: string) => ref !== "section-1")))).toBe("REFERENCE_MISMATCH");
    // Section scope: a bullet citing another section's fact.
    expect(localReason((output) => (output.payload.sections[0].bullets[0].factRefs = ["fact-2"]))).toBe("REFERENCE_MISMATCH");
    // Coverage and fidelity: every supplied section and fact kept; numbers and units unchanged.
    expect(localReason((output) => (output.payload.sections = [output.payload.sections[0]]))).toBe("FACT_FIDELITY_FAILED");
    expect(localReason((output) => (output.payload.sections[0].bullets[0].text = "A reading of 9.9 mmol/L was recorded."))).toBe("FACT_FIDELITY_FAILED");
    // Meaning, locale and budget.
    expect(localReason((output) => (output.payload.sections[0].bullets[0].text = "A reading of 6.2 mmol/L was recorded and is dangerous."))).toBe("CLINICAL_MEANING_VIOLATION");
    expect(localReason((output) => (output.payload.sections[0].bullets[0].text = "记录了一个 6.2 mmol/L 的读数。"))).toBe("LOCALE_INVALID");
  });
});
