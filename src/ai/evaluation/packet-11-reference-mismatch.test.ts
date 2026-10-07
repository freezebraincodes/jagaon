import { describe, expect, it, vi } from "vitest";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { createAiTaskService } from "@/application/ai/ai-task-service";
import { payloadReferences } from "@/domain/ai";
import { outputFixture } from "@/domain/ai/ai-test-fixtures";
import { conformsToStrictSchema } from "./packet-11-evaluation";
import { fixturesForPhase } from "./packet-11-fixtures";

/**
 * Packet 11B forensic regression for latency probe 3 (2026-10-05):
 * strict-schema conformant output rejected with REFERENCE_MISMATCH on
 * EXPLAIN_PATTERN / en-SG / ordinary. The provider output was not retained
 * (by design), so the exact failing field is unknown. These are all and only
 * the validator paths that produce that observed signature for this fixture.
 */

const FIXTURE = fixturesForPhase("DIAGNOSTIC")[0]!;
const BUNDLE = AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
// Option B (11b.1): limitation references stay local, so the provider-visible references are the claim and facts.
const PERMITTED = ["claim-1", "fact-1", "fact-2", "fact-3"];

/** A faithful output for this exact fixture, citing every permitted reference. */
function faithful(): Record<string, any> {
  const output = structuredClone(outputFixture("EXPLAIN_PATTERN")) as Record<string, any>;
  output.inputRefsUsed = [...PERMITTED];
  output.payload.evidence.factRefs = ["fact-1", "fact-2", "fact-3"];
  return output;
}

type Mutation = (output: Record<string, any>) => void;
const without = (ref: string): Mutation => (output) => (output.inputRefsUsed = output.inputRefsUsed.filter((entry: string) => entry !== ref));
const PATHS: Array<[string, "INVENTED_REFERENCE" | "CITED_NOT_LISTED", Mutation]> = [
  ["inputRefsUsed lists an unsupplied reference", "INVENTED_REFERENCE", (output) => output.inputRefsUsed.push("fact-4")],
  ["headline cites an unsupplied claim", "INVENTED_REFERENCE", (output) => ((output.payload.headline.claimRefs = ["claim-2"]), output.inputRefsUsed.push("claim-2"))],
  ["evidence cites an unsupplied fact", "INVENTED_REFERENCE", (output) => ((output.payload.evidence.factRefs = ["fact-1", "fact-4"]), output.inputRefsUsed.push("fact-4"))],
  ["inputRefsUsed lists a limitation reference the provider never receives", "INVENTED_REFERENCE", (output) => output.inputRefsUsed.push("limitation-1")],
  ["claim-1 is cited but not listed in inputRefsUsed", "CITED_NOT_LISTED", without("claim-1")],
  ["a cited fact is not listed in inputRefsUsed", "CITED_NOT_LISTED", without("fact-3")],
];

describe("REFERENCE_MISMATCH forensic regression (EXPLAIN_PATTERN / en-SG / ordinary)", () => {
  it("pins the permitted request-local references of the probed fixture", () => {
    // Declared as the provider sees them: Option B drops limitations from the detached payload.
    const declared = payloadReferences(FIXTURE.taskType, { claim: (FIXTURE.request.taskPayload as { claim: unknown }).claim }).declared;
    expect([...new Set([...FIXTURE.request.facts.map((fact) => fact.ref), ...declared])].sort()).toEqual(PERMITTED);
  });

  it("accepts the faithful control output", () => {
    expect(conformsToStrictSchema(FIXTURE, faithful())).toBe(true);
    expect(validateAiTaskOutput(FIXTURE.request, BUNDLE, faithful())).toEqual({ kind: "ACCEPTED", output: faithful() });
  });

  it.each(PATHS)("reproduces the observed signature when %s (%s)", (_label, _category, mutate) => {
    const output = faithful();
    mutate(output);
    // Observed: strict-schema conformant, then rejected for reference closure, never repairable.
    expect(conformsToStrictSchema(FIXTURE, output)).toBe(true);
    expect(validateAiTaskOutput(FIXTURE.request, BUNDLE, output)).toEqual({ kind: "REJECTED", reason: "REFERENCE_MISMATCH", repairable: false });
  });

  it("is deterministic: the same output fails identically after a fresh module load", async () => {
    vi.resetModules();
    const fresh = await import("@/application/ai/ai-output-validator");
    for (const [, , mutate] of PATHS) {
      const output = faithful();
      mutate(output);
      expect(fresh.validateAiTaskOutput(FIXTURE.request, BUNDLE, JSON.stringify(output))).toEqual(validateAiTaskOutput(FIXTURE.request, BUNDLE, output));
    }
  });

  it("selects the deterministic fallback and exposes no rejected fragment through the service", async () => {
    const output = faithful();
    without("claim-1")(output);
    output.payload.observation.text = "SENTINEL-REJECTED-FRAGMENT recorded 6.2 and 7.1 mmol/L.";
    const service = createAiTaskService({
      releaseProfile: "HACKATHON_DEMO",
      manifest: { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } },
      provider: { providerModel: { providerKey: "kie", modelSnapshot: "deepseek-v4-1-flash-260910" }, invoke: async () => ({ kind: "COMPLETED", candidate: output, usage: { inputTokens: 644, outputTokens: 201, costMicroUsd: null } }) },
      audit: { append: async () => undefined },
      now: () => "2026-10-05T03:00:00.000Z",
      monotonicMs: () => 0,
    });
    const result = await service.execute(FIXTURE.request);
    expect(result).toMatchObject({ kind: "FALLBACK", fallback: { reason: "REFERENCE_MISMATCH", presentation: { kind: "TEMPLATE_PATTERN_CARD" } } });
    expect(JSON.stringify(result)).not.toContain("SENTINEL-REJECTED-FRAGMENT");
  });
});
