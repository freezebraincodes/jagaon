import { describe, expect, it } from "vitest";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { createDeterministicFallback } from "@/application/ai/ai-fallbacks";
import { approvedClaimMeaning, AI_MEANING_REGISTRY_REVISION, renderExplainLimitations } from "@/application/ai/ai-meaning-registry";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES, resolveAiTaskBundle } from "@/application/ai/ai-runtime-bundles";
import { createAiTaskService } from "@/application/ai/ai-task-service";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { aiTaskOutputSchema, providerTaskRequestSchema, type AiTaskRequest } from "@/domain/ai";
import { outputFixture, requestFixture } from "@/domain/ai/ai-test-fixtures";
import { KIE_PROVIDER_SCHEMA_VERSION, providerOutputJsonSchema } from "@/ai/kie/kie-responses-contracts";
import { PACKET_11_PROMPT_VERSION, promptFor } from "@/ai/prompts/packet-11-prompts";
import { APPROVED_SMOKE_CONTRACT, KIE_ROUTE_VERSION, VALIDATOR_RULES_REVISION, evaluationPlan, liveRunVerdict } from "./packet-11-evaluation";
import { fixturesForPhase, PACKET_11_FIXTURES } from "./packet-11-fixtures";

/**
 * Packet 11B.5 Option B contract (owner approval 2026-10-05). The application
 * renders limitation text from the immutable bilingual registry
 * ai-meaning-registry.11b.1; the model receives only the approved claim-family
 * meaning and factual input, never limitation codes or text, and writes only
 * headline, observation and evidence. Approval covers the synthetic hackathon
 * scope only — it is not clinical validation or independent professional
 * linguistic certification.
 */

const request = (locale: "en-SG" | "zh-SG" = "en-SG") => ({ ...requestFixture("EXPLAIN_PATTERN"), locale }) as AiTaskRequest;
const bundle = () => resolveAiTaskBundle("EXPLAIN_PATTERN", "en-SG");
const projected = (value: AiTaskRequest) => {
  const result = projectProviderTaskPayload(value, bundle());
  if (result.kind !== "PROJECTED") throw new Error(result.reason);
  return result.payload as unknown as { taskPayload: Record<string, unknown> & { claim: Record<string, unknown> }; facts: { field: string }[] };
};
const OPTION_B_OUTPUT = {
  schemaVersion: "ai-output.explain-pattern@11b.1",
  taskType: "EXPLAIN_PATTERN",
  outcome: "SUCCESS",
  locale: "en-SG",
  inputRefsUsed: ["claim-1", "fact-1", "fact-2", "fact-3"],
  payload: {
    headline: { text: "Recent recorded values were 6.2 and 7.1 mmol/L.", claimRefs: ["claim-1"] },
    observation: { text: "Recent recorded values were 6.2 and 7.1 mmol/L.", claimRefs: ["claim-1"] },
    evidence: { text: "This uses 10 recorded readings.", factRefs: ["fact-1", "fact-2", "fact-3"] },
  },
};
const verdict = (candidate: unknown, value: AiTaskRequest = request()) => {
  const result = validateAiTaskOutput(value, bundle(), candidate);
  return result.kind === "ACCEPTED" ? "ACCEPTED" : result.reason;
};

describe("Option B versions", () => {
  it("pins candidate deepseek-flash, prompt 11b.11, route packet11-responses.11b.6, schema kie-schema.11b.3, rules r7 and registry ai-meaning-registry.11b.1", () => {
    expect([PACKET_11_PROMPT_VERSION, KIE_ROUTE_VERSION, KIE_PROVIDER_SCHEMA_VERSION, VALIDATOR_RULES_REVISION, AI_MEANING_REGISTRY_REVISION]).toEqual(["11b.11", "packet11-responses.11b.6", "kie-schema.11b.3", "11b.2-meaning-r7", "ai-meaning-registry.11b.1"]);
    expect(APPROVED_SMOKE_CONTRACT).toEqual({ requestModelId: "deepseek-flash", responseModelSnapshot: "deepseek-flash", promptVersion: "11b.11", providerSchemaVersion: "kie-schema.11b.3", routeVersion: "packet11-responses.11b.6", validatorRulesRevision: "11b.2-meaning-r7", approvedMeaningRegistryRevision: "ai-meaning-registry.11b.1", fixtureSetRevision: "packet11-fixtures.11b.3", evaluationReportVersion: "packet11-eval.4" });
  });

  it("versions every EXPLAIN_PATTERN bundle component it changed and leaves the care bundle alone", () => {
    const explain = AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
    // Fixture-set corrections (11b.2, then 11b.3) are component changes, so the bundle version moves with them.
    expect(explain.bundleKey).toBe("ai.explain-pattern@11b.3");
    expect(explain.fixtureSet).toEqual({ id: "ai-fixtures.explain-pattern", version: "11b.3" });
    for (const component of [explain.inputSchema, explain.outputSchema, explain.validatorProfile, explain.fallbackProfile, explain.localePack["en-SG"], explain.localePack["zh-SG"]]) expect(component.version).toBe("11b.1");
    // Fixture set 11b.3 is the care summary's only component change: bundle and fixture set 11b.3, every other component 11a.1.
    const careBundle = AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY;
    expect(careBundle.bundleKey).toBe("ai.draft-care-preparation-summary@11b.3");
    expect(careBundle.fixtureSet).toEqual({ id: "ai-fixtures.draft-care-preparation-summary", version: "11b.3" });
    for (const component of [careBundle.inputSchema, careBundle.outputSchema, careBundle.validatorProfile, careBundle.fallbackProfile, careBundle.localePack["en-SG"], careBundle.localePack["zh-SG"]]) expect(component.version).toBe("11a.1");
  });

  it("evidence under the earlier prompt, route, schema, rules or a missing registry revision cannot qualify", () => {
    const plan = evaluationPlan(fixturesForPhase("SMOKE"), "SMOKE");
    const report = {
      reportVersion: "packet11-eval.4",
      phase: "SMOKE",
      promptVersion: "11b.11",
      providerSchemaVersion: "kie-schema.11b.3",
      routeVersion: "packet11-responses.11b.6",
      validatorRulesRevision: "11b.2-meaning-r7",
      approvedMeaningRegistryRevision: "ai-meaning-registry.11b.1",
      fixtureSetRevision: "packet11-fixtures.11b.3",
      model: { requestModelId: "deepseek-v4-1-flash", responseModelSnapshot: "deepseek-v4-1-flash-260910" },
      completed: true,
      stoppedReason: null,
      hardGatePassed: true,
      totals: { fixtures: 4, calls: 4, repairs: 0, credits: 0 },
      fixtures: [],
    };
    const failures = (patch: Record<string, unknown>) => {
      const result = liveRunVerdict({ ...report, ...patch } as never, plan, { maxCredits: 1, candidateCount: 1, requestModelId: "deepseek-v4-1-flash", responseModelSnapshot: "deepseek-v4-1-flash-260910" });
      return result.kind === "FAIL" ? result.failures.filter((failure) => failure.startsWith("CONTRACT_VERSION_MISMATCH")) : [];
    };
    expect(failures({})).toEqual([]);
    expect(failures({ promptVersion: "11b.10" })).toEqual(["CONTRACT_VERSION_MISMATCH:promptVersion"]);
    expect(failures({ promptVersion: "11b.9" })).toEqual(["CONTRACT_VERSION_MISMATCH:promptVersion"]);
    expect(failures({ promptVersion: "11b.8" })).toEqual(["CONTRACT_VERSION_MISMATCH:promptVersion"]);
    expect(failures({ promptVersion: "11b.7" })).toEqual(["CONTRACT_VERSION_MISMATCH:promptVersion"]);
    expect(failures({ promptVersion: "11b.6" })).toEqual(["CONTRACT_VERSION_MISMATCH:promptVersion"]);
    expect(failures({ promptVersion: "11b.5" })).toEqual(["CONTRACT_VERSION_MISMATCH:promptVersion"]);
    expect(failures({ routeVersion: "kie-responses.11b.5" })).toEqual(["CONTRACT_VERSION_MISMATCH:routeVersion"]);
    expect(failures({ routeVersion: "kie-responses.11b.4" })).toEqual(["CONTRACT_VERSION_MISMATCH:routeVersion"]);
    expect(failures({ routeVersion: "kie-responses.11b.3" })).toEqual(["CONTRACT_VERSION_MISMATCH:routeVersion"]);
    expect(failures({ providerSchemaVersion: "kie-schema.11b.2" })).toEqual(["CONTRACT_VERSION_MISMATCH:providerSchemaVersion"]);
    expect(failures({ validatorRulesRevision: "11b.2-meaning-r6" })).toEqual(["CONTRACT_VERSION_MISMATCH:validatorRulesRevision"]);
    expect(failures({ validatorRulesRevision: "11b.2-meaning-r5" })).toEqual(["CONTRACT_VERSION_MISMATCH:validatorRulesRevision"]);
    expect(failures({ validatorRulesRevision: "11b.2-meaning-r4" })).toEqual(["CONTRACT_VERSION_MISMATCH:validatorRulesRevision"]);
    expect(failures({ approvedMeaningRegistryRevision: undefined })).toEqual(["CONTRACT_VERSION_MISMATCH:approvedMeaningRegistryRevision"]);
    expect(failures({ reportVersion: "packet11-eval.3" })).toEqual(["CONTRACT_VERSION_MISMATCH:evaluationReportVersion"]);
    expect(failures({ reportVersion: "packet11-eval.2" })).toEqual(["CONTRACT_VERSION_MISMATCH:evaluationReportVersion"]);
    expect(failures({ reportVersion: "packet11-eval.1" })).toEqual(["CONTRACT_VERSION_MISMATCH:evaluationReportVersion"]);
    expect(failures({ fixtureSetRevision: "packet11-fixtures.11b.2" })).toEqual(["CONTRACT_VERSION_MISMATCH:fixtureSetRevision"]);
    expect(failures({ fixtureSetRevision: "packet11-fixtures.11b.1" })).toEqual(["CONTRACT_VERSION_MISMATCH:fixtureSetRevision"]);
    expect(failures({ fixtureSetRevision: undefined })).toEqual(["CONTRACT_VERSION_MISMATCH:fixtureSetRevision"]);
  });
});

describe("the detached payload carries the approved claim meaning and never limitation data", () => {
  it.each(["en-SG", "zh-SG"] as const)("%s: claim.approvedMeaning is the registry text; no limitations are sent", (locale) => {
    const payload = projected(request(locale));
    expect(payload.taskPayload.claim.approvedMeaning).toBe(approvedClaimMeaning("COMPARABLE_SLOT_TREND", locale));
    expect(payload.taskPayload).not.toHaveProperty("limitations");
    expect(JSON.stringify(payload)).not.toMatch(/DOES_NOT_ESTABLISH_CAUSE|limitation-\d|PATTERN_LIMITATION/);
  });

  it("a limitation fact cannot cross the boundary as a fact either", () => {
    const value = request();
    (value.facts as unknown[]).push({ ref: "fact-4", field: "PATTERN_LIMITATION", value: { kind: "TEXT", text: "Readings varied.", language: "en-SG" }, sources: [] });
    expect(projectProviderTaskPayload(value, bundle())).toEqual({ kind: "FALLBACK", reason: "PRIVACY_REJECTED" });
  });

  it("fails closed before any provider call when a supplied limitation code has no approved registry entry", () => {
    const value = request();
    (value.taskPayload as unknown as { limitations: { ref: string; code: string }[] }).limitations = [{ ref: "limitation-1", code: "HIGH_VARIABILITY" }];
    expect(projectProviderTaskPayload(value, bundle())).toEqual({ kind: "FALLBACK", reason: "PAYLOAD_INVALID" });
  });

  it("the provider request schema requires approvedMeaning and rejects limitation data", () => {
    const payload = structuredClone(projected(request())) as { taskPayload: Record<string, unknown> & { claim: Record<string, unknown> } };
    expect(providerTaskRequestSchema.safeParse(payload).success).toBe(true);
    const missing = structuredClone(payload);
    delete missing.taskPayload.claim.approvedMeaning;
    expect(providerTaskRequestSchema.safeParse(missing).success).toBe(false);
    const withLimitations = structuredClone(payload);
    withLimitations.taskPayload.limitations = [{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }];
    expect(providerTaskRequestSchema.safeParse(withLimitations).success).toBe(false);
  });
});

describe("the model writes only headline, observation and evidence", () => {
  it("accepts the Option B output and rejects any model-written limitations field", () => {
    expect(verdict(OPTION_B_OUTPUT)).toBe("ACCEPTED");
    const withLimitations = structuredClone(OPTION_B_OUTPUT) as Record<string, any>;
    withLimitations.payload.limitations = [{ limitationRef: "limitation-1", text: "This does not explain why the readings differed." }];
    expect(aiTaskOutputSchema.safeParse(withLimitations).success).toBe(false);
    expect(verdict(withLimitations)).toBe("SCHEMA_INVALID");
  });

  it("rejects a limitation reference or a model-supplied approvedMeaning", () => {
    expect(verdict({ ...OPTION_B_OUTPUT, inputRefsUsed: [...OPTION_B_OUTPUT.inputRefsUsed, "limitation-1"] })).toBe("REFERENCE_MISMATCH");
    const meaning = structuredClone(OPTION_B_OUTPUT) as Record<string, any>;
    meaning.payload.headline.approvedMeaning = "Readings are fine.";
    expect(verdict(meaning)).toBe("SCHEMA_INVALID");
  });

  it("rejects the previous output schema version", () => {
    expect(verdict({ ...OPTION_B_OUTPUT, schemaVersion: "ai-output.explain-pattern@11a.1" })).toBe("SCHEMA_INVALID");
  });

  it("the provider JSON schema has no limitations property and pins the 11b.1 output version", () => {
    const schema = providerOutputJsonSchema("EXPLAIN_PATTERN", "en-SG") as { properties: { schemaVersion: { enum: string[] }; payload: { anyOf: Array<{ properties?: Record<string, unknown> }> } } };
    expect(Object.keys(schema.properties.payload.anyOf[0]!.properties ?? {}).sort()).toEqual(["evidence", "headline", "observation"]);
    expect(schema.properties.schemaVersion.enum).toEqual(["ai-output.explain-pattern@11b.1"]);
  });

  it.each(["en-SG", "zh-SG"] as const)("the %s prompt makes the application the only author of limitation copy", (locale) => {
    const text = promptFor("EXPLAIN_PATTERN", locale)!.text;
    expect(text).toContain("The application shows every limitation itself. Do not write, restate, paraphrase, strengthen or weaken any limitation.");
    expect(text).toContain("claim.approvedMeaning is the only meaning of the claim; the family code is a label only. Do not infer any meaning from a code.");
    for (const removed of ["Include every supplied limitation exactly once", "limitations[].limitationRef", "limitation codes supplied in the input"]) expect(text).not.toContain(removed);
  });
});

describe("result and fallback show the same reviewed limitation copy", () => {
  const limitations = () => (request().taskPayload as unknown as { limitations: { ref: string; code: string }[] }).limitations;

  it("the deterministic fallback renders the registry copy", () => {
    const presentation = createDeterministicFallback(request(), "PROVIDER_FAILED").presentation as Record<string, unknown>;
    expect(presentation).toMatchObject({ kind: "TEMPLATE_PATTERN_CARD", limitationCopyComplete: true, limitations: renderExplainLimitations(limitations(), "en-SG").limitations });
  });

  it("an accepted result carries exactly the fallback's limitation copy (parity)", async () => {
    const service = createAiTaskService({
      releaseProfile: "HACKATHON_DEMO",
      manifest: { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } },
      provider: { providerModel: { providerKey: "kie", modelSnapshot: "deepseek-v4-1-flash-260910" }, invoke: async () => ({ kind: "COMPLETED", candidate: OPTION_B_OUTPUT, usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: null }, retention: "CONFIRMED_NOT_STORED" }) },
      audit: { append: async () => undefined },
      now: () => "2026-10-05T10:00:00.000Z",
      monotonicMs: () => 0,
    });
    const result = await service.execute(request());
    const fallback = createDeterministicFallback(request(), "PROVIDER_FAILED").presentation as Record<string, unknown>;
    expect(result).toMatchObject({ kind: "ACCEPTED", limitationCopyComplete: true });
    expect((result as { limitations?: unknown }).limitations).toEqual(fallback.limitations);
  });
});

describe("qualification fixtures use only approved codes", () => {
  it("every EXPLAIN_PATTERN fixture family and limitation code has an approved entry in its locale", () => {
    for (const fixture of PACKET_11_FIXTURES.filter((value) => value.taskType === "EXPLAIN_PATTERN")) {
      const payload = fixture.request.taskPayload as { claim: { family: string }; limitations: { ref: string; code: string }[] };
      expect(approvedClaimMeaning(payload.claim.family, fixture.locale), fixture.id).not.toBeNull();
      expect(renderExplainLimitations(payload.limitations, fixture.locale).complete, fixture.id).toBe(true);
      expect(fixture.request.runtimeBundleKey).toBe("ai.explain-pattern@11b.3");
    }
  });
});
