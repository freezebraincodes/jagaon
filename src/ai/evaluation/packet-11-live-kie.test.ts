// @vitest-environment node
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverKieModels } from "@/ai/kie/kie-model-catalogue";
import { createKieResponsesProvider, type KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { readKieToken, selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { DEEPSEEK_DOCUMENTED_MODELS, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { APPROVED_SMOKE_CONTRACT, contractMismatches, evaluateModelSnapshot, evaluationPlan, liveRunVerdict } from "./packet-11-evaluation";
import { fixturesForPhase } from "./packet-11-fixtures";
import { createPacket11LiveTracer, rawTraceRequested } from "./packet-11-live-trace";

/**
 * Packet 11B explicit live Kie evaluation. CREDIT-CONSUMING.
 *
 * Skipped unless RUN_LIVE_KIE_EVALUATION=1. Requires, before the first
 * request: KIE_API_KEY (server environment, loaded from the ignored
 * .env.local by `npm run evaluate:packet11`), KIE_EVALUATION_CANDIDATES (exact
 * identifiers), KIE_EVALUATION_PHASE (diagnostic|care_diagnostic|smoke|full), KIE_EVALUATION_MAX_CREDITS
 * (positive run ceiling, enforced between calls) and
 * KIE_EVALUATION_CONFIRM_MAX_CALLS equal to the printed maximum call count.
 * Optional KIE_EVALUATION_NO_LISTING=1 skips the listing request.
 * PACKET11_EVALUATION_PROVIDER selects the provider: `kie` (default) or `deepseek` (evaluation-only direct
 * DeepSeek Responses API, owner instruction 2026-10-06). For `deepseek` the credential is DEEPSEEK_API_KEY, the
 * ceiling is DEEPSEEK_EVALUATION_MAX_USD (an upper-bound USD estimate per call, harness packet11-eval.4), no
 * Kie listing request is made and candidates come only from the documented DeepSeek registry. Any other
 * provider value is refused before any request.
 * Optional KIE_EVALUATION_FIXTURE_ID (DIAGNOSTIC phase only) runs that one live fixture instead of the
 * default diagnostic fixture; any other phase, an unknown fixture or an offline negative is refused.
 * Optional KIE_EVALUATION_RAW_TRACE=1 writes the exact request (Authorization
 * redacted) and raw response for each synthetic fixture call to a fresh
 * private directory under the Git-ignored test-results/packet-11-live-trace/;
 * only the file paths and closed codes are printed.
 * Synthetic fixtures only, concurrency 1, no tools. Prints only the plan and
 * the redacted report; never the key, prompt, payload or provider response.
 * The command fails unless liveRunVerdict passes: an operational stop, partial
 * run, repair, provider failure or model mismatch fails it, not only a
 * clinical hard-gate failure.
 */

const env = process.env;
const LIVE = env.RUN_LIVE_KIE_EVALUATION === "1";

describe.skipIf(!LIVE)("Packet 11 live Kie evaluation (explicit, credit-consuming)", () => {
  it(
    "runs only the explicitly confirmed phase and candidates",
    async () => {
      const provider = (env.PACKET11_EVALUATION_PROVIDER ?? "kie") as string;
      if (provider !== "kie" && provider !== "deepseek") throw new Error("PACKET11_EVALUATION_PROVIDER_INVALID: kie or deepseek");
      const token = provider === "deepseek" ? readDeepSeekToken(env) : readKieToken(env);
      if (token.kind !== "CONFIGURED") throw new Error(provider === "deepseek" ? "DEEPSEEK_API_KEY is not configured" : "KIE_API_KEY is not configured");
      const phase = env.KIE_EVALUATION_PHASE === "full" ? "FULL" : env.KIE_EVALUATION_PHASE === "smoke" ? "SMOKE" : env.KIE_EVALUATION_PHASE === "diagnostic" ? "DIAGNOSTIC" : env.KIE_EVALUATION_PHASE === "care_diagnostic" ? "CARE_DIAGNOSTIC" : null;
      if (!phase) throw new Error("KIE_EVALUATION_PHASE must be diagnostic, care_diagnostic, smoke or full");
      const ceilingName = provider === "deepseek" ? "DEEPSEEK_EVALUATION_MAX_USD" : "KIE_EVALUATION_MAX_CREDITS";
      const spendUnit = provider === "deepseek" ? "USD_UPPER_BOUND_ESTIMATE" : "KIE_CREDITS";
      const maxCredits = Number(provider === "deepseek" ? env.DEEPSEEK_EVALUATION_MAX_USD : env.KIE_EVALUATION_MAX_CREDITS);
      if (!Number.isFinite(maxCredits) || maxCredits <= 0) throw new Error(`${ceilingName} must be a positive number`);

      const fixtures = fixturesForPhase(phase, env.KIE_EVALUATION_FIXTURE_ID);
      const plan = evaluationPlan(fixtures, phase);
      console.log(JSON.stringify({ packet11LivePlan: { ...plan, provider, maxCredits, spendUnit, candidates: env.KIE_EVALUATION_CANDIDATES ?? null } }));
      // No request of any kind before the operator confirms the exact maximum call count.
      if (env.KIE_EVALUATION_CONFIRM_MAX_CALLS !== String(plan.maxCalls)) throw new Error(`Set KIE_EVALUATION_CONFIRM_MAX_CALLS=${plan.maxCalls} to confirm this phase`);

      // KIE_EVALUATION_NO_LISTING=1 makes no listing request: only the owner-approved documented candidates are selectable.
      const listing = provider === "deepseek" ? [] : env.KIE_EVALUATION_NO_LISTING === "1" ? [] : await discoverKieModels({ token: token.token, signal: AbortSignal.timeout(15_000) });
      const selection =
        provider === "deepseek"
          ? selectEvaluationCandidates({ requested: env.KIE_EVALUATION_CANDIDATES, listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: () => new Date().toISOString() })
          : selectEvaluationCandidates({ requested: env.KIE_EVALUATION_CANDIDATES, listing, now: () => new Date().toISOString() });
      if (selection.kind !== "SELECTED") throw new Error(`Candidate selection rejected: ${selection.reason}`);
      console.log(JSON.stringify({ packet11Listing: listing.map((model) => model.requestModelId), packet11Candidates: selection.candidates }));
      // Smoke evaluates exactly one candidate; checked before any model call.
      if (phase !== "FULL" && selection.candidates.length !== 1) throw new Error("LIVE_RUN_FAILED: SMOKE_CANDIDATE_COUNT");

      for (const model of selection.candidates) {
        // Before any model call: the exact approved model pair and contract versions.
        const mismatches = contractMismatches(model);
        if (mismatches.length > 0) throw new Error(`LIVE_RUN_FAILED: CONTRACT_MISMATCH:${mismatches.join(",")}`);
        // Closed version strings only (no key, prompt, payload or model output), printed before any model call.
        console.log(JSON.stringify({ packet11Contract: { ...APPROVED_SMOKE_CONTRACT, explainPatternBundle: AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey, careSummaryBundle: AI_TASK_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey, provider, endpoint: model.endpoint, spendUnit } }));
        // Evaluation-only redacted diagnostic: closed codes and property names, never values.
        let lastDiagnostic: KieProviderDiagnostic | null = null;
        const tracer = rawTraceRequested(env) ? await createPacket11LiveTracer({ fetcher: (url, init) => fetch(url, init) }) : null;
        const providerConfig = { token: token.token, model, fetcher: tracer?.fetcher, onDiagnostic: (diagnostic: KieProviderDiagnostic) => (lastDiagnostic = diagnostic) };
        const port = provider === "deepseek" ? createDeepSeekResponsesProvider(providerConfig) : createKieResponsesProvider(providerConfig);
        const takeDiagnostic = () => {
          const taken = lastDiagnostic;
          lastDiagnostic = null;
          return taken;
        };
        let report: Awaited<ReturnType<typeof evaluateModelSnapshot>>;
        try {
          report = await evaluateModelSnapshot({ model, provider: port, fixtures, concurrency: 1, phase, limits: { maxCalls: plan.maxCalls, maxCredits, allowRepair: plan.allowRepair }, takeDiagnostic, observer: tracer?.observer });
        } finally {
          // Paths and closed codes only; the trace contents stay in the files.
          if (tracer) console.log(JSON.stringify({ packet11Trace: { directory: relative(process.cwd(), tracer.directory), files: tracer.files(), calls: tracer.summary(), failure: tracer.failure() } }));
        }
        const verdict = liveRunVerdict(report, plan, { maxCredits, candidateCount: selection.candidates.length, requestModelId: model.requestModelId, responseModelSnapshot: model.responseModelSnapshot });
        console.log(JSON.stringify({ packet11Report: report, packet11Verdict: verdict }));
        if (verdict.kind === "FAIL") throw new Error(`LIVE_RUN_FAILED: ${verdict.failures.join(",")}`);
        expect(verdict).toEqual({ kind: "PASS" });
      }
    },
    30 * 60_000,
  );
});
