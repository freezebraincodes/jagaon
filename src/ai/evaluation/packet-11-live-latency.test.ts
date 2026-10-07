// @vitest-environment node
import { describe, expect, it } from "vitest";
import { discoverKieModels } from "@/ai/kie/kie-model-catalogue";
import { createKieResponsesProvider } from "@/ai/kie/kie-responses-provider";
import { readKieToken, selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { LATENCY_PROBE_PLAN, latencyRunVerdict, runLatencyProbes } from "./packet-11-latency";

/**
 * Packet 11B explicit live latency characterisation. CREDIT-CONSUMING.
 *
 * Skipped unless RUN_LIVE_KIE_LATENCY=1. Requires KIE_API_KEY (from the
 * ignored .env.local via `npm run evaluate:packet11:latency`),
 * KIE_EVALUATION_CANDIDATES naming exactly one candidate,
 * KIE_EVALUATION_MAX_CREDITS no higher than the plan ceiling, and
 * KIE_LATENCY_CONFIRM_MAX_CALLS equal to the plan's three calls, all before
 * any request. Prints only the plan and the redacted latency report. The
 * command fails unless latencyRunVerdict passes: every probe completed with the
 * exact snapshot and was accepted by every validator gate.
 */

const env = process.env;
const LIVE = env.RUN_LIVE_KIE_LATENCY === "1";

describe.skipIf(!LIVE)("Packet 11 live Kie latency probes (explicit, credit-consuming)", () => {
  it(
    "runs exactly the confirmed three evaluation-only probes",
    async () => {
      const token = readKieToken(env);
      if (token.kind !== "CONFIGURED") throw new Error("KIE_API_KEY is not configured");
      const maxCredits = Number(env.KIE_EVALUATION_MAX_CREDITS);
      if (!Number.isFinite(maxCredits) || maxCredits <= 0 || maxCredits > LATENCY_PROBE_PLAN.maxCredits) throw new Error(`KIE_EVALUATION_MAX_CREDITS must be > 0 and ≤ ${LATENCY_PROBE_PLAN.maxCredits}`);
      console.log(JSON.stringify({ packet11LatencyPlan: { ...LATENCY_PROBE_PLAN, maxCredits, candidates: env.KIE_EVALUATION_CANDIDATES ?? null } }));
      // No request of any kind before the operator confirms the exact call count.
      if (env.KIE_LATENCY_CONFIRM_MAX_CALLS !== String(LATENCY_PROBE_PLAN.maxCalls)) throw new Error(`Set KIE_LATENCY_CONFIRM_MAX_CALLS=${LATENCY_PROBE_PLAN.maxCalls} to confirm`);

      const listing = await discoverKieModels({ token: token.token, signal: AbortSignal.timeout(15_000) });
      const selection = selectEvaluationCandidates({ requested: env.KIE_EVALUATION_CANDIDATES, listing, now: () => new Date().toISOString() });
      if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("LATENCY_RUN_FAILED: exactly one approved candidate is required");
      const model = selection.candidates[0]!;
      const report = await runLatencyProbes({ model, createProvider: (onDiagnostic) => createKieResponsesProvider({ token: token.token, model, onDiagnostic }), maxCredits });
      const verdict = latencyRunVerdict(report, { maxCredits, responseModelSnapshot: model.responseModelSnapshot });
      console.log(JSON.stringify({ packet11LatencyReport: report, packet11LatencyVerdict: verdict }));
      if (verdict.kind === "FAIL") throw new Error(`LATENCY_RUN_FAILED: ${verdict.failures.join(",")}`);
      expect(verdict).toEqual({ kind: "PASS" });
    },
    5 * 60_000,
  );
});
