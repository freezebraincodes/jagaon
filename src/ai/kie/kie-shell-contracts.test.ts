import { describe, expect, it } from "vitest";
import { MAX_SLOTS, SHELL_MAX_OUTPUT_TOKENS, SHELL_PROVIDER_REQUEST_VERSION as DOMAIN_SHELL_REQUEST_VERSION, SHELL_OUTPUT_VERSIONS, SLOT_PLAN_VERSION, shellOutputSchema } from "@/domain/ai";
import { SHELL_PROVIDER_REQUEST_VERSION, SHELL_PROVIDER_SCHEMA_VERSION, shellOutputJsonSchema, shellOutputSchemaName } from "./kie-shell-contracts";

describe("strict shell provider schema kie-schema.11b.6", () => {
  it("pins the version and names", () => {
    // Observation ownership: kie-schema.11b.6 (EXPLAIN shells { headline, evidence }); 11b.5 had the model observation.
    expect(SHELL_PROVIDER_SCHEMA_VERSION).toBe("kie-schema.11b.6");
    expect(SHELL_PROVIDER_SCHEMA_VERSION).not.toBe("kie-schema.11b.5");
    expect(shellOutputSchemaName("DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG")).toBe("draft_care_preparation_summary_shell_zh_sg");
  });
  it("is a closed object with every property required and the exact shell version", () => {
    const schema = shellOutputJsonSchema("EXPLAIN_PATTERN", "en-SG") as any;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["schemaVersion", "slotPlanVersion", "tokenInventory", "taskType", "outcome", "locale", "abstentionReason", "shells"] });
    expect(schema.properties.schemaVersion.enum).toEqual(["ai-shell.explain-pattern@11b.8"]);
    expect(schema.properties.slotPlanVersion).toEqual({ type: "string", enum: ["ai-slot-plan.11b.8"] });
    expect(schema.properties.shells.anyOf[0]).toEqual({ type: "object", additionalProperties: false, required: ["headline", "evidence"], properties: { headline: { type: "string", minLength: 1, maxLength: 400 }, evidence: { type: "string", minLength: 1, maxLength: 400 } } });
    expect((shellOutputJsonSchema("DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG") as any).properties.schemaVersion.enum).toEqual(["ai-shell.draft-care-preparation-summary@11b.7"]);
    expect(schema.properties.tokenInventory).toEqual({ type: "array", minItems: 1, maxItems: 32, items: { type: "string", pattern: "^S([1-9]|[12][0-9]|3[0-2])$" } });
    expect(schema.properties.locale.enum).toEqual(["en-SG"]);
    expect(Object.isFrozen(schema)).toBe(true);
  });
  it("has no reference property anywhere", () => {
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) expect(JSON.stringify(shellOutputJsonSchema(task, "en-SG"))).not.toMatch(/Refs|inputRefsUsed|sectionRef|fact-|claim-/);
  });
  it("describes exactly what the domain shell schema accepts", () => {
    const sample = { schemaVersion: "ai-shell.explain-pattern@11b.8", slotPlanVersion: "ai-slot-plan.11b.8", tokenInventory: ["S1", "S3"], taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcome: "SUCCESS", abstentionReason: null, shells: { headline: "A look at {{S1}}.", evidence: "Based on {{S3}}." } };
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...sample, shells: { ...sample.shells, observation: "Values: {{S2}}." } }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse(sample).success).toBe(true);
    const required = (shellOutputJsonSchema("EXPLAIN_PATTERN", "en-SG") as any).properties.shells.anyOf[0].required;
    expect(required).toEqual(Object.keys(sample.shells));
    expect([...(shellOutputJsonSchema("EXPLAIN_PATTERN", "en-SG") as any).required].sort()).toEqual(Object.keys(sample).sort());
    const pattern = new RegExp((shellOutputJsonSchema("EXPLAIN_PATTERN", "en-SG") as any).properties.tokenInventory.items.pattern);
    for (const id of ["S1", "S9", "S10", "S29", "S32"]) expect(pattern.test(id) && shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...sample, tokenInventory: [id] }).success, id).toBe(true);
    for (const id of ["S0", "S01", "S33", "s1", "{{S1}}", " S1"]) expect(pattern.test(id) || shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...sample, tokenInventory: [id] }).success, id).toBe(false);
  });
  it("kie-schema.11b.6 keeps parity with the domain echo fields for both tasks and locales", () => {
    for (const task of ["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"] as const) {
      for (const locale of ["en-SG", "zh-SG"] as const) {
        const schema = shellOutputJsonSchema(task, locale) as any;
        expect(schema.properties.slotPlanVersion).toEqual({ type: "string", enum: [SLOT_PLAN_VERSION] });
        expect(schema.properties.tokenInventory).toEqual({ type: "array", minItems: 1, maxItems: MAX_SLOTS, items: { type: "string", pattern: "^S([1-9]|[12][0-9]|3[0-2])$" } });
        expect(schema.properties.schemaVersion.enum).toEqual([SHELL_OUTPUT_VERSIONS[task]]);
      }
    }
    const sample = { schemaVersion: "ai-shell.explain-pattern@11b.7", slotPlanVersion: "ai-slot-plan.11b.7", tokenInventory: ["S1"], taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcome: "SUCCESS", abstentionReason: null, shells: { headline: "A look at {{S1}}.", observation: "Values here.", evidence: "Based on records." } };
    for (const slotPlanVersion of ["ai-slot-plan.11b.6", "ai-slot-plan.11b.7 ", ""]) expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...sample, slotPlanVersion }).success, slotPlanVersion).toBe(false);
    for (const tokenInventory of [[], Array.from({ length: MAX_SLOTS + 1 }, () => "S1")]) expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...sample, tokenInventory }).success).toBe(false);
  });
});

describe("shell request profile ai-shell-request.11b.11", () => {
  it("is re-exported from the provider contracts as the one domain literal (strict text.format + per-task caps 512 / 1024 + r7 temperature 0.2)", () => {
    expect(SHELL_PROVIDER_REQUEST_VERSION).toBe("ai-shell-request.11b.11");
    expect(SHELL_PROVIDER_REQUEST_VERSION).toBe(DOMAIN_SHELL_REQUEST_VERSION);
    expect(SHELL_MAX_OUTPUT_TOKENS).toEqual({ EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 });
  });
});
