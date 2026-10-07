// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { resolveAiTaskBundle } from "@/application/ai/ai-runtime-bundles";
import { createAiTaskService } from "@/application/ai/ai-task-service";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { KIE_DOCUMENTED_MODELS, type KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { evaluateModelSnapshot } from "./packet-11-evaluation";
import { PACKET_11_FIXTURES, PACKET_11_OFFLINE_NEGATIVE_FIXTURES, fixturesForPhase } from "./packet-11-fixtures";
import { createPacket11LiveTracer } from "./packet-11-live-trace";

/**
 * Packet 11B offline negative fixtures (owner instruction 2026-10-05). The
 * original EXPLAIN_PATTERN AMBIGUOUS scenario named only HIGH_VARIABILITY and
 * LIMITED_COMPARISON, which have no approved meaning. It is preserved unchanged
 * here — never silently given another limitation — and must fall back before
 * any provider call. These fixtures are offline-only and can never enter a
 * live qualification phase.
 */

const MODEL: KieModelSnapshot = { ...KIE_DOCUMENTED_MODELS[0]!, contextWindow: null, defaultReasoningLevel: null, retrievedAt: "2026-10-05T12:00:00.000Z" };
const remote = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" as const } };

afterEach(() => vi.restoreAllMocks());

describe("offline negative fixture: AMBIGUOUS with only unsupported limitations", () => {
  it("preserves the original scenario exactly, in both locales, outside every live phase", () => {
    expect(PACKET_11_OFFLINE_NEGATIVE_FIXTURES.map((fixture) => fixture.id)).toEqual(["p11.explain-pattern.en-sg.ambiguous-unsupported-limitations", "p11.explain-pattern.zh-sg.ambiguous-unsupported-limitations"]);
    for (const fixture of PACKET_11_OFFLINE_NEGATIVE_FIXTURES) {
      expect(fixture).toMatchObject({ taskType: "EXPLAIN_PATTERN", category: "AMBIGUOUS" });
      expect(fixture.request.taskPayload).toMatchObject({ limitations: [{ ref: "limitation-1", code: "HIGH_VARIABILITY" }, { ref: "limitation-2", code: "LIMITED_COMPARISON" }] });
      expect(fixture.request.facts.map((fact) => fact.value)).toEqual([
        { kind: "DECIMAL", value: "6.5", unit: "MMOL_L" },
        { kind: "DECIMAL", value: "6.5", unit: "MMOL_L" },
        { kind: "COUNT", value: 4 },
      ]);
      expect(PACKET_11_FIXTURES).not.toContain(fixture);
      for (const phase of ["DIAGNOSTIC", "CARE_DIAGNOSTIC", "SMOKE", "FULL"] as const) expect(fixturesForPhase(phase).map((value) => value.id)).not.toContain(fixture.id);
    }
    expect(Object.isFrozen(PACKET_11_OFFLINE_NEGATIVE_FIXTURES)).toBe(true);
  });

  it.each(["en-SG", "zh-SG"] as const)("%s: falls back with PAYLOAD_INVALID before the provider, with no network and no generated or invented text", async (locale) => {
    const fixture = PACKET_11_OFFLINE_NEGATIVE_FIXTURES.find((value) => value.locale === locale)!;
    expect(projectProviderTaskPayload(fixture.request, resolveAiTaskBundle("EXPLAIN_PATTERN", locale))).toEqual({ kind: "FALLBACK", reason: "PAYLOAD_INVALID" });
    const network = vi.spyOn(globalThis, "fetch");
    const invoke = vi.fn();
    const service = createAiTaskService({ releaseProfile: "HACKATHON_DEMO", manifest: remote, provider: { providerModel: { providerKey: "kie", modelSnapshot: MODEL.responseModelSnapshot }, invoke }, audit: { append: async () => undefined }, now: () => "2026-10-05T12:00:00.000Z", monotonicMs: () => 0 });
    const result = await service.execute(fixture.request);
    expect(result).toMatchObject({ kind: "FALLBACK", fallback: { reason: "PAYLOAD_INVALID", presentation: { kind: "TEMPLATE_PATTERN_CARD", limitations: [], limitationCopyComplete: false } } });
    expect(result).not.toHaveProperty("output");
    expect(invoke).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("makes zero provider calls when run through the evaluator", async () => {
    const invoke = vi.fn();
    const report = await evaluateModelSnapshot({ model: MODEL, provider: { providerModel: { providerKey: "kie", modelSnapshot: MODEL.responseModelSnapshot }, invoke }, fixtures: PACKET_11_OFFLINE_NEGATIVE_FIXTURES, concurrency: 1, phase: "FULL", limits: { maxCalls: 2, maxCredits: 0.01, allowRepair: false }, now: () => "2026-10-05T12:00:00.000Z", monotonicMs: () => 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(report.totals).toMatchObject({ calls: 0, credits: 0, accepted: 0 });
    for (const evidence of report.fixtures) expect(evidence).toMatchObject({ outcome: "FALLBACK", reasonCode: "PAYLOAD_INVALID", attempts: 0 });
  });

  it("cannot be bound by the live trace facility", async () => {
    const tracer = await createPacket11LiveTracer({ fetcher: vi.fn(), now: () => "2026-10-05T12:00:00.000Z" });
    try {
      expect(() => tracer.observer.beginFixture(PACKET_11_OFFLINE_NEGATIVE_FIXTURES[0]!)).toThrow("TRACE_FIXTURE_NOT_REGISTERED");
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(tracer.directory, { recursive: true, force: true });
    }
  });
});
