import { describe, expect, it } from "vitest";
import * as domainIndex from "./index";
import { BARE_SLOT_ID, localFields, remoteFields, remoteTokenInventory, SHELL_INPUT_VERSIONS, SHELL_MAX_OUTPUT_TOKENS, SHELL_PROVIDER_REQUEST_VERSION, SHELL_TEMPERATURE, shellMaxOutputTokens, SHELL_OUTPUT_VERSIONS, shellOutputSchema, shellTaskRequestSchema, SLOT_PLAN_VERSION, slotToken, slotTokenMatcher } from "./ai-language-shell-contracts";

// Observation ownership (@11b.8): the EXPLAIN request carries the model's fields only (headline, evidence); slot ids keep the plan
// numbering, so the application-owned observation slot S2 is a gap.
const explainRequest = () => ({
  shellInputVersion: "ai-shell-input.explain-pattern@11b.8",
  shellSchemaVersion: "ai-shell.explain-pattern@11b.8",
  slotPlanVersion: "ai-slot-plan.11b.9",
  taskType: "EXPLAIN_PATTERN", locale: "en-SG", runtimeBundleKey: "ai.explain-pattern@11b.20", claimFamily: "COMPARABLE_SLOT_TREND",
  tokenInventory: ["S1", "S3"],
  fields: [
    { path: "headline", requiredSlots: ["S1"], maxCodePoints: 60, maxSentences: 1, mayBeAtomOnly: false },
    { path: "evidence", requiredSlots: ["S3"], maxCodePoints: 80, maxSentences: 1, mayBeAtomOnly: false },
  ],
  slots: [{ slotId: "S1", atomKind: "MEANING", gloss: "g" }, { slotId: "S3", atomKind: "COUNT", gloss: "g" }],
  sections: [],
});
const careRequest = () => ({
  shellInputVersion: "ai-shell-input.draft-care-preparation-summary@11b.7",
  shellSchemaVersion: "ai-shell.draft-care-preparation-summary@11b.7",
  slotPlanVersion: "ai-slot-plan.11b.9",
  taskType: "DRAFT_CARE_PREPARATION_SUMMARY", locale: "zh-SG", runtimeBundleKey: "ai.draft-care-preparation-summary@11b.20", claimFamily: null,
  tokenInventory: ["S1"],
  fields: [
    { path: "sections[0].intro", requiredSlots: [], maxCodePoints: 40, maxSentences: 1, mayBeAtomOnly: false },
    { path: "sections[0].bullets[0]", requiredSlots: ["S1"], maxCodePoints: 30, maxSentences: 1, mayBeAtomOnly: true },
  ],
  slots: [{ slotId: "S1", atomKind: "DECIMAL", gloss: "g" }],
  sections: [{ sectionSlot: "C1", heading: "h", introPath: "sections[0].intro", bulletPaths: ["sections[0].bullets[0]"] }],
});

describe("contract versions (observation ownership: EXPLAIN @11b.8, care @11b.7; slot plan 11b.9 since Packet 11C phase 2)", () => {
  it("pins the shell input, shell output and slot plan versions", () => {
    expect(SHELL_INPUT_VERSIONS).toEqual({ EXPLAIN_PATTERN: "ai-shell-input.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell-input.draft-care-preparation-summary@11b.7" });
    expect(SHELL_OUTPUT_VERSIONS).toEqual({ EXPLAIN_PATTERN: "ai-shell.explain-pattern@11b.8", DRAFT_CARE_PREPARATION_SUMMARY: "ai-shell.draft-care-preparation-summary@11b.7" });
    expect(SLOT_PLAN_VERSION).toBe("ai-slot-plan.11b.9");
  });
  it("the field owner helpers: remote fields and the remote token inventory in plan order, local fields apart", () => {
    const plan = { fields: [
      { path: "headline", requiredSlots: ["S1"], maxCodePoints: 60, maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE" },
      { path: "observation", requiredSlots: ["S2", "S3"], maxCodePoints: 120, maxSentences: 2, mayBeAtomOnly: false, owner: "LOCAL" },
      { path: "evidence", requiredSlots: ["S4"], maxCodePoints: 80, maxSentences: 1, mayBeAtomOnly: false, owner: "REMOTE" },
    ] } as never;
    expect(remoteFields(plan).map((field) => field.path)).toEqual(["headline", "evidence"]);
    expect(localFields(plan).map((field) => field.path)).toEqual(["observation"]);
    expect(remoteTokenInventory(plan)).toEqual(["S1", "S4"]);
  });
});

describe("value-blind shell request contract", () => {
  it("accepts a closed EXPLAIN request and a closed care request", () => {
    expect(shellTaskRequestSchema.safeParse(explainRequest()).success).toBe(true);
    expect(shellTaskRequestSchema.safeParse(careRequest()).success).toBe(true);
  });
  it("rejects any extra key, including a smuggled value", () => {
    const request = explainRequest();
    (request.slots[1] as Record<string, unknown>).value = "6.2";
    expect(shellTaskRequestSchema.safeParse(request).success).toBe(false);
  });
  it.each([
    ["a slot required by two fields", (r: any) => r.fields[1].requiredSlots.push("S1")],
    ["a required slot that is not defined", (r: any) => r.fields[1].requiredSlots.push("S4")],
    // Observation ownership (@11b.8): the application-owned observation never appears in an EXPLAIN request.
    ["an EXPLAIN observation field", (r: any) => { r.fields.splice(1, 0, { path: "observation", requiredSlots: ["S2"], maxCodePoints: 120, maxSentences: 2, mayBeAtomOnly: false }); r.slots.splice(1, 0, { slotId: "S2", atomKind: "DECIMAL_LIST", gloss: "g" }); r.tokenInventory = ["S1", "S2", "S3"]; }],
    ["the 11b.7 EXPLAIN input version", (r: any) => (r.shellInputVersion = "ai-shell-input.explain-pattern@11b.7")],
    ["the 11b.7 EXPLAIN output version", (r: any) => (r.shellSchemaVersion = "ai-shell.explain-pattern@11b.7")],
    ["the 11b.7 slot plan version", (r: any) => (r.slotPlanVersion = "ai-slot-plan.11b.7")],
    ["a defined slot that no field requires", (r: any) => r.slots.push({ slotId: "S4", atomKind: "DATE", gloss: "g" })],
    ["EXPLAIN fields out of order", (r: any) => r.fields.reverse()],
    ["EXPLAIN with a section", (r: any) => r.sections.push({ sectionSlot: "C1", heading: "h", introPath: "sections[0].intro", bulletPaths: ["sections[0].bullets[0]"] })],
    ["EXPLAIN without a claim family", (r: any) => (r.claimFamily = null)],
    ["the care input version on an EXPLAIN request", (r: any) => (r.shellInputVersion = "ai-shell-input.draft-care-preparation-summary@11b.7")],
    ["the 11b.6 input version", (r: any) => (r.shellInputVersion = "ai-shell-input.explain-pattern@11b.6")],
    ["the care output version on an EXPLAIN request", (r: any) => (r.shellSchemaVersion = "ai-shell.draft-care-preparation-summary@11b.7")],
    ["the 11b.6 output version", (r: any) => (r.shellSchemaVersion = "ai-shell.explain-pattern@11b.6")],
    ["no output version", (r: any) => delete r.shellSchemaVersion],
    ["the 11b.6 slot plan version", (r: any) => (r.slotPlanVersion = "ai-slot-plan.11b.6")],
    ["no slot plan version", (r: any) => delete r.slotPlanVersion],
    ["no token inventory", (r: any) => delete r.tokenInventory],
    ["a reordered token inventory", (r: any) => (r.tokenInventory = ["S3", "S1"])],
    ["a token inventory missing a required slot", (r: any) => (r.tokenInventory = ["S1"])],
    ["a token inventory with an extra slot", (r: any) => (r.tokenInventory = ["S1", "S3", "S4"])],
    ["a token inventory with the application-owned observation slot", (r: any) => (r.tokenInventory = ["S1", "S2", "S3"])],
    ["a token inventory with a duplicate slot", (r: any) => (r.tokenInventory = ["S1", "S3", "S3"])],
    ["a token inventory entry that is not a slot id", (r: any) => (r.tokenInventory = ["S1", "{{S3}}"])],
  ])("rejects %s", (_label, mutate) => {
    const request = explainRequest();
    mutate(request);
    expect(shellTaskRequestSchema.safeParse(request).success).toBe(false);
  });
  it("requires the care token inventory to list every required slot in field order", () => {
    const request = careRequest() as any;
    request.fields.push({ path: "sections[0].bullets[1]", requiredSlots: ["S2", "S3"], maxCodePoints: 24, maxSentences: 1, mayBeAtomOnly: true });
    request.sections[0].bulletPaths.push("sections[0].bullets[1]");
    request.slots.push({ slotId: "S2", atomKind: "LABEL", gloss: "g" }, { slotId: "S3", atomKind: "DATE", gloss: "g" });
    request.tokenInventory = ["S1", "S2", "S3"];
    expect(shellTaskRequestSchema.safeParse(request).success).toBe(true);
    request.tokenInventory = ["S1", "S3", "S2"];
    expect(shellTaskRequestSchema.safeParse(request).success).toBe(false);
  });
  it("rejects care fields that do not match the section layout", () => {
    const request = careRequest();
    request.sections[0]!.bulletPaths = ["sections[0].bullets[1]"];
    expect(shellTaskRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("slot token grammar", () => {
  it("matches only well-formed tokens S1..S32 and returns a fresh matcher each call", () => {
    const text = "{{S1}} {{S32}} {{S33}} {{S01}} {{s1}} {{ S1 }} {S1} {{S1}}}";
    expect([...text.matchAll(slotTokenMatcher())].map((match) => match[1])).toEqual(["S1", "S32", "S1"]);
    expect(slotTokenMatcher()).not.toBe(slotTokenMatcher());
    expect(slotToken("S7")).toBe("{{S7}}");
    expect(BARE_SLOT_ID.test("see S3 here")).toBe(true);
    expect(BARE_SLOT_ID.test("S33 or SS1")).toBe(false);
  });
});

describe("shell output contract", () => {
  const success = { schemaVersion: "ai-shell.explain-pattern@11b.8", slotPlanVersion: "ai-slot-plan.11b.9", tokenInventory: ["S1", "S3"], taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcome: "SUCCESS", abstentionReason: null, shells: { headline: "A look at {{S1}}.", evidence: "Based on {{S3}}." } };
  it("enforces the exclusive outcome contract and the exact version", () => {
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse(success).success).toBe(true);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, abstentionReason: "AMBIGUOUS_INPUT" }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, outcome: "ABSTAIN", abstentionReason: "AMBIGUOUS_INPUT" }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, outcome: "ABSTAIN", abstentionReason: "AMBIGUOUS_INPUT", shells: null }).success).toBe(true);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, schemaVersion: "ai-shell.explain-pattern@11b.5" }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, schemaVersion: "ai-shell.explain-pattern@11b.6" }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, shells: { ...success.shells, extra: "x" } }).success).toBe(false);
    // Observation ownership (@11b.8): a model-provided observation is an unknown key, and the @11b.7 three-field output is refused.
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, shells: { ...success.shells, observation: "Values: {{S2}}." } }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, schemaVersion: "ai-shell.explain-pattern@11b.7" }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, slotPlanVersion: "ai-slot-plan.11b.7" }).success).toBe(false);
    expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...success, shells: { headline: "A look at {{S1}}." } }).success).toBe(false);
  });
  it("requires the slot plan version and token inventory echo on both outcomes", () => {
    const abstain = { ...success, outcome: "ABSTAIN", abstentionReason: "AMBIGUOUS_INPUT", shells: null };
    for (const output of [success, abstain]) {
      const { slotPlanVersion: _version, ...noVersion } = output;
      const { tokenInventory: _inventory, ...noInventory } = output;
      expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse(noVersion).success).toBe(false);
      expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse(noInventory).success).toBe(false);
      expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...output, slotPlanVersion: "ai-slot-plan.11b.6" }).success).toBe(false);
      expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...output, tokenInventory: ["S1", "{{S2}}"] }).success).toBe(false);
      expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...output, tokenInventory: ["S33"] }).success).toBe(false);
      expect(shellOutputSchema("EXPLAIN_PATTERN").safeParse({ ...output, tokenInventory: [] }).success).toBe(false);
    }
  });
  it("has no reference property anywhere in either shell schema", () => {
    const keys = JSON.stringify([shellOutputSchema("EXPLAIN_PATTERN"), shellOutputSchema("DRAFT_CARE_PREPARATION_SUMMARY")].map((schema) => Object.keys((schema as any)._def.options[0].shape)));
    expect(keys).not.toMatch(/Refs|inputRefsUsed|sectionRef/);
  });
});

describe("hybrid shell request profile ai-shell-request.11b.11 (Packet 11B.10 per-task caps; r7 temperature)", () => {
  it("the per-task caps are a frozen literal map (EXPLAIN 512, care 1024) and the request profile is ai-shell-request.11b.11 (r7; 11b.10 before), exported via the domain index", () => {
    expect(SHELL_MAX_OUTPUT_TOKENS).toEqual({ EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 1024 });
    expect(Object.keys(SHELL_MAX_OUTPUT_TOKENS)).toEqual(["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"]);
    expect(Object.isFrozen(SHELL_MAX_OUTPUT_TOKENS)).toBe(true);
    expect(() => { (SHELL_MAX_OUTPUT_TOKENS as { EXPLAIN_PATTERN: number }).EXPLAIN_PATTERN = 4096; }).toThrow();
    expect(SHELL_PROVIDER_REQUEST_VERSION).toBe("ai-shell-request.11b.11");
    expect(domainIndex.SHELL_MAX_OUTPUT_TOKENS).toBe(SHELL_MAX_OUTPUT_TOKENS);
    expect(domainIndex.SHELL_PROVIDER_REQUEST_VERSION).toBe("ai-shell-request.11b.11");
    // Literal types: the map's values are the exact caps.
    const explain: 512 = SHELL_MAX_OUTPUT_TOKENS.EXPLAIN_PATTERN;
    const care: 1024 = SHELL_MAX_OUTPUT_TOKENS.DRAFT_CARE_PREPARATION_SUMMARY;
    expect([explain, care]).toEqual([512, 1024]);
  });
  it("shellMaxOutputTokens(task) returns the task's cap and throws on an unknown task", () => {
    expect(shellMaxOutputTokens("EXPLAIN_PATTERN")).toBe(512);
    expect(shellMaxOutputTokens("DRAFT_CARE_PREPARATION_SUMMARY")).toBe(1024);
    expect(domainIndex.shellMaxOutputTokens("DRAFT_CARE_PREPARATION_SUMMARY")).toBe(1024);
    for (const task of ["EXTRACT_CANDIDATE_FACTS", "explain_pattern", "", "toString", "__proto__", "constructor", undefined, null, 512]) {
      expect(() => shellMaxOutputTokens(task as never), String(task)).toThrow("UNKNOWN_SHELL_TASK");
    }
  });
});

/** Rules r7 (owner instruction 2026-10-06, offline only): the hybrid shell request samples at a fixed temperature of 0.2. */
describe("hybrid shell sampling temperature (ai-shell-request.11b.11, r7)", () => {
  it("SHELL_TEMPERATURE is the literal 0.2, a primitive constant exported via the domain index", () => {
    expect(SHELL_TEMPERATURE).toBe(0.2);
    expect(typeof SHELL_TEMPERATURE).toBe("number");
    expect(domainIndex.SHELL_TEMPERATURE).toBe(0.2);
    // Literal type: the constant is exactly 0.2.
    const temperature: 0.2 = SHELL_TEMPERATURE;
    expect(temperature).toBe(0.2);
    expect(SHELL_PROVIDER_REQUEST_VERSION).toBe("ai-shell-request.11b.11");
  });
  it("the module binding cannot be reassigned", () => {
    expect(() => {
      (domainIndex as { SHELL_TEMPERATURE: number }).SHELL_TEMPERATURE = 1;
    }).toThrow();
    expect(domainIndex.SHELL_TEMPERATURE).toBe(0.2);
  });
});
