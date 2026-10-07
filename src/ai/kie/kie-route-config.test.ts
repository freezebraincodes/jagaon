import { describe, expect, it } from "vitest";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { KIE_GROK_RESPONSES_URL, KIE_RESPONSES_URL, type KieModelSnapshot } from "./kie-model-catalogue";
import { minimumReasoningEffort, readKieToken, resolveProductKieRoute, selectEvaluationCandidates } from "./kie-route-config";

/** Packet 11B Task 1: explicit evaluation-candidate selection and server route configuration. */

const NOW = "2026-10-05T01:00:00.000Z";
const listed = (requestModelId: string, levels = ["low", "medium", "high"]): KieModelSnapshot => ({ requestModelId, responseModelSnapshot: requestModelId, provenance: "LISTED", endpoint: KIE_RESPONSES_URL, contextWindow: 272000, defaultReasoningLevel: "medium", supportedReasoningLevels: levels, retrievedAt: NOW, documentationUrl: null });
const LISTING = [listed("gpt-5.4"), listed("gpt-5.5")];
const select = (requested: string | undefined) => selectEvaluationCandidates({ requested, listing: LISTING, now: () => NOW });

describe("server-only token configuration", () => {
  it("reads KIE_API_KEY only, trimmed, and reports absence as a typed fallback reason", () => {
    expect(readKieToken({ KIE_API_KEY: "  secret  " })).toEqual({ kind: "CONFIGURED", token: "secret" });
    expect(readKieToken({})).toEqual({ kind: "MISSING_CONFIGURATION" });
    expect(readKieToken({ KIE_API_KEY: "   " })).toEqual({ kind: "MISSING_CONFIGURATION" });
    expect(readKieToken({ NEXT_PUBLIC_KIE_API_KEY: "secret" })).toEqual({ kind: "MISSING_CONFIGURATION" });
  });
});

describe("explicit evaluation candidates", () => {
  it("accepts an exact listed identifier", () => {
    expect(select("gpt-5.4")).toEqual({ kind: "SELECTED", candidates: [listed("gpt-5.4")] });
  });

  it("accepts the documented-unlisted candidate only as evaluation-only, stamped with this retrieval", () => {
    const result = select("grok-4-7");
    expect(result).toMatchObject({ kind: "SELECTED", candidates: [{ requestModelId: "grok-4-7", responseModelSnapshot: "grok-4-7", provenance: "DOCUMENTED_UNLISTED_EVALUATION_ONLY", endpoint: KIE_GROK_RESPONSES_URL, contextWindow: null, retrievedAt: NOW, documentationUrl: "https://docs.kie.ai/market/grok/grok-4-7.md" }] });
  });

  it("prefers the live listing when a documented model is also listed", () => {
    const result = selectEvaluationCandidates({ requested: "grok-4-7", listing: [listed("grok-4-7")], now: () => NOW });
    expect(result).toMatchObject({ kind: "SELECTED", candidates: [{ provenance: "LISTED" }] });
  });

  it.each([
    [undefined, "NO_CANDIDATES"],
    ["", "NO_CANDIDATES"],
    ["gpt-5-4", "UNKNOWN_MODEL"],
    ["kimi-k3", "EXCLUDED_MODEL"],
    ["deepseek-v4-1-flash", "EXCLUDED_MODEL"],
    ["GPT-5.4", "UNKNOWN_MODEL"],
    ["gpt-5.4,gpt-5.4", "DUPLICATE_CANDIDATE"],
    ["latest", "FLOATING_ALIAS"],
    ["gpt-5.4-latest", "FLOATING_ALIAS"],
    ["deepseek-flash", "FLOATING_ALIAS"],
    ["gpt-5", "FLOATING_ALIAS"],
  ])("rejects %s as %s", (requested, reason) => {
    expect(select(requested)).toEqual({ kind: "REJECTED", reason });
  });

  it("accepts a comma-separated exact list in the given order", () => {
    expect(select(" gpt-5.5 , gpt-5.4 ")).toMatchObject({ kind: "SELECTED", candidates: [{ requestModelId: "gpt-5.5" }, { requestModelId: "gpt-5.4" }] });
  });
});

describe("reasoning compatibility", () => {
  it("always uses the lowest documented level that disables or minimises reasoning", () => {
    expect(minimumReasoningEffort(listed("x", ["none", "minimal", "low"]))).toBe("none");
    expect(minimumReasoningEffort(listed("x", ["minimal", "low"]))).toBe("minimal");
    expect(minimumReasoningEffort(listed("x", ["low", "medium"]))).toBe("low");
    expect(minimumReasoningEffort(listed("x", ["medium", "high"]))).toBeNull();
    expect(minimumReasoningEffort(listed("x", []))).toBeNull();
  });
});

describe("product route configuration", () => {
  it("never routes a product request while bundles carry no approved model snapshot", () => {
    for (const bundle of Object.values(AI_TASK_RUNTIME_BUNDLES)) {
      expect(resolveProductKieRoute(bundle, { KIE_API_KEY: "secret" })).toEqual({ kind: "MISSING_CONFIGURATION" });
    }
  });

  it("keeps every production bundle unactivated with no pinned model, even for the evaluated pair", () => {
    for (const bundle of Object.values(AI_TASK_RUNTIME_BUNDLES)) {
      expect(bundle.modelSnapshot).toBeNull();
      expect(bundle.routeProfile).toBe("deterministic-only.11a.1");
    }
  });

  it("does not select by the response snapshot: the request alias is the only selectable identifier", () => {
    expect(select("deepseek-v4-1-flash-260910")).toMatchObject({ kind: "REJECTED" });
  });

  it("reports a missing key before anything else", () => {
    expect(resolveProductKieRoute(AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN, {})).toEqual({ kind: "MISSING_CONFIGURATION" });
  });
});
