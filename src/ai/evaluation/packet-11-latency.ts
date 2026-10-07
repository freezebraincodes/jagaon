import { validateAiTaskOutput } from "@/application/ai/ai-output-validator";
import type { AiProviderPort } from "@/application/ai/ai-provider-port";
import { AI_TASK_RUNTIME_BUNDLES } from "@/application/ai/ai-runtime-bundles";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import type { KieContentTypeClass, KieDiagnosticCode, KieProviderDiagnostic } from "@/ai/kie/kie-responses-provider";
import { AI_EVALUATION_HARD_GATE_REASONS, conformsToStrictSchema } from "./packet-11-evaluation";
import { fixturesForPhase } from "./packet-11-fixtures";
import { diagnoseReferenceClosure, type ReferenceClosureDiagnostic } from "./packet-11-reference-diagnostics";
import { diagnoseSchemaFailure, type SchemaFailureDiagnostic } from "./packet-11-schema-diagnostics";
import { diagnoseMeaningFailure, type MeaningFailureDiagnostic } from "./packet-11-meaning-diagnostics";

/**
 * Packet 11B evaluation-only latency characterisation (owner instruction
 * 2026-10-05). Exactly three sequential calls of the DIAGNOSTIC fixture
 * (EXPLAIN_PATTERN / en-SG / ordinary) with the same request, a 20 s timeout
 * that exists only in this harness, no retry and no repair. The production
 * bundles, task timeouts and overall timeouts are not read for the call and
 * are not changed. A timeout is measurement data; the run stops early only on
 * a model mismatch, a malformed response, a schema or validator failure, a
 * clinical hard-gate failure, other unexpected provider behaviour or the
 * reported-credit ceiling. The report holds closed codes and numbers only.
 */

const BUNDLE = AI_TASK_RUNTIME_BUNDLES.EXPLAIN_PATTERN;

export const LATENCY_PROBE_PLAN = Object.freeze({
  fixtureId: "p11.explain-pattern.en-sg.ordinary",
  probes: 3,
  timeoutMs: 20_000,
  productionLimitMs: BUNDLE.executionBudget.perCallTimeoutMs,
  maxCredits: 0.25,
  maxCalls: 3,
});

export type LatencyStop = "RESPONSE_MODEL_MISMATCH" | "MALFORMED_RESPONSE" | "SCHEMA_OR_VALIDATOR_FAILURE" | "HARD_GATE" | "UNEXPECTED_PROVIDER_BEHAVIOUR" | "CREDIT_CEILING";

export type LatencyProbe = Readonly<{
  probe: number;
  outcome: "COMPLETED" | "TIMEOUT" | "FAILED";
  latencyMs: number;
  httpStatus: number | null;
  contentTypeClass: KieContentTypeClass | null;
  diagnosticCode: KieDiagnosticCode | null;
  responseModel: string | null;
  schemaConformant: boolean | null;
  validator: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  credits: number | null;
  withinProductionLimit: boolean;
  /** Value-free reference-closure diagnostic, present only for a REFERENCE_MISMATCH probe. */
  referenceDiagnostic: ReferenceClosureDiagnostic | null;
  /** Value-free schema diagnostic, present only for a SCHEMA_INVALID probe. */
  schemaDiagnostic: SchemaFailureDiagnostic | null;
  /** Value-free meaning diagnostic, present only for a meaning-gate probe. */
  meaningDiagnostic: MeaningFailureDiagnostic | null;
}>;

export type LatencyProbeReport = Readonly<{
  reportVersion: "packet11-latency.1";
  generatedAt: string;
  model: Readonly<{ requestModelId: string; responseModelSnapshot: string; provenance: string }>;
  plan: typeof LATENCY_PROBE_PLAN;
  stoppedReason: LatencyStop | null;
  probes: readonly LatencyProbe[];
  summary: Readonly<{ calls: number; completed: number; timeouts: number; failed: number; completedWithinProductionLimit: number; completedWithinTimeout: number; credits: number }>;
}>;

const MALFORMED = new Set<string>(["BODY_NOT_JSON", "CONTENT_TYPE_EVENT_STREAM", "BODY_MISSING", "BODY_NOT_UTF8", "BODY_OVERSIZED", "UNKNOWN_PROVIDER_ENVELOPE", "OUTPUT_SHAPE_INVALID", "OUTPUT_TEXT_MISSING", "USAGE_MISSING_OR_INVALID", "CREDITS_INVALID", "STATUS_NOT_COMPLETED"]);
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export async function runLatencyProbes(options: {
  model: KieModelSnapshot;
  createProvider: (onDiagnostic: (diagnostic: KieProviderDiagnostic) => void) => AiProviderPort;
  maxCredits: number;
  monotonicMs?: () => number;
  now?: () => string;
}): Promise<LatencyProbeReport> {
  const fixture = fixturesForPhase("DIAGNOSTIC")[0]!;
  if (fixture.id !== LATENCY_PROBE_PLAN.fixtureId) throw new Error("LATENCY_FIXTURE_MISMATCH");
  const projected = projectProviderTaskPayload(fixture.request, BUNDLE);
  if (projected.kind !== "PROJECTED") throw new Error("LATENCY_FIXTURE_NOT_PROJECTABLE");
  const monotonic = options.monotonicMs ?? (() => performance.now());

  const probes: LatencyProbe[] = [];
  let credits = 0;
  let stop: LatencyStop | null = null;
  for (let index = 1; index <= LATENCY_PROBE_PLAN.probes; index += 1) {
    if (credits >= options.maxCredits) {
      stop = "CREDIT_CEILING";
      break;
    }
    let diagnostic: KieProviderDiagnostic | null = null;
    const provider = options.createProvider((value) => (diagnostic = value));
    const controller = new AbortController();
    let timedOut = false;
    const started = monotonic();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LATENCY_PROBE_PLAN.timeoutMs);
    const aborted = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null)));
    let result;
    try {
      result = await Promise.race([provider.invoke(projected.payload, controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = timedOut ? LATENCY_PROBE_PLAN.timeoutMs : Math.round(monotonic() - started);
    const observed = diagnostic as KieProviderDiagnostic | null;
    const completed = !timedOut && result?.kind === "COMPLETED" ? result : null;
    const verdict = completed ? validateAiTaskOutput(fixture.request, BUNDLE, completed.candidate) : null;
    const usage = observed?.reportedUsage ?? null;
    const outcome: LatencyProbe["outcome"] = timedOut ? "TIMEOUT" : completed ? "COMPLETED" : "FAILED";
    probes.push({
      probe: index,
      outcome,
      latencyMs,
      httpStatus: observed?.httpStatus ?? null,
      contentTypeClass: observed?.contentTypeClass ?? null,
      diagnosticCode: timedOut ? "REQUEST_TIMEOUT" : (observed?.code ?? null),
      responseModel: completed ? (completed.responseModel ?? null) : (observed?.modelIdentity?.returned ?? null),
      schemaConformant: completed ? conformsToStrictSchema(fixture, completed.candidate) : null,
      validator: verdict ? (verdict.kind === "ACCEPTED" ? "ACCEPTED" : verdict.reason) : null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      credits: usage?.credits ?? null,
      withinProductionLimit: outcome === "COMPLETED" && latencyMs <= LATENCY_PROBE_PLAN.productionLimitMs,
      referenceDiagnostic: completed && verdict?.kind === "REJECTED" && verdict.reason === "REFERENCE_MISMATCH" ? diagnoseReferenceClosure(fixture, completed.candidate) : null,
      schemaDiagnostic: completed && verdict?.kind === "REJECTED" && verdict.reason === "SCHEMA_INVALID" ? diagnoseSchemaFailure(fixture, completed.candidate) : null,
      meaningDiagnostic: completed && verdict?.kind === "REJECTED" && (verdict.reason === "CLINICAL_MEANING_VIOLATION" || verdict.reason === "AUTHORITY_BOUNDARY_VIOLATION") ? diagnoseMeaningFailure(fixture, completed.candidate) : null,
    });
    credits = round(credits + (usage?.credits ?? 0));

    if (timedOut) continue;
    if (!completed) {
      const code = observed?.code ?? null;
      stop = code === "RESPONSE_MODEL_MISMATCH" || code === "RESPONSE_MODEL_MISSING" ? "RESPONSE_MODEL_MISMATCH" : code && MALFORMED.has(code) ? "MALFORMED_RESPONSE" : "UNEXPECTED_PROVIDER_BEHAVIOUR";
      break;
    }
    if (verdict?.kind === "REJECTED") {
      stop = (AI_EVALUATION_HARD_GATE_REASONS as readonly string[]).includes(verdict.reason) ? "HARD_GATE" : "SCHEMA_OR_VALIDATOR_FAILURE";
      break;
    }
  }
  if (stop === null && probes.length < LATENCY_PROBE_PLAN.probes && credits >= options.maxCredits) stop = "CREDIT_CEILING";

  const finished = probes.filter((entry) => entry.outcome === "COMPLETED");
  return Object.freeze({
    reportVersion: "packet11-latency.1",
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    model: Object.freeze({ requestModelId: options.model.requestModelId, responseModelSnapshot: options.model.responseModelSnapshot, provenance: options.model.provenance }),
    plan: LATENCY_PROBE_PLAN,
    stoppedReason: stop,
    probes,
    summary: Object.freeze({
      calls: probes.length,
      completed: finished.length,
      timeouts: probes.filter((entry) => entry.outcome === "TIMEOUT").length,
      failed: probes.filter((entry) => entry.outcome === "FAILED").length,
      completedWithinProductionLimit: finished.filter((entry) => entry.withinProductionLimit).length,
      completedWithinTimeout: finished.length,
      credits,
    }),
  });
}

export type LatencyRunVerdict = { kind: "PASS" } | { kind: "FAIL"; failures: string[] };

/**
 * Owner completion condition for the live latency command (2026-10-05). It
 * passes only when every requested probe ran exactly once, completed within
 * the evaluation timeout, returned the exact approved snapshot, matched the
 * strict schema and was ACCEPTED by every validator gate, with no stop and
 * reported credits within the ceiling. Any timeout, failure, rejection,
 * abstention, missing probe or incomplete count fails it.
 */
export function latencyRunVerdict(report: LatencyProbeReport, approved: { maxCredits: number; responseModelSnapshot: string }): LatencyRunVerdict {
  const failures: string[] = [];
  if (report.stoppedReason !== null) failures.push(`STOPPED:${report.stoppedReason}`);
  if (report.model.responseModelSnapshot !== approved.responseModelSnapshot) failures.push("MODEL_MISMATCH");
  if (report.summary.calls !== LATENCY_PROBE_PLAN.probes || report.probes.length !== LATENCY_PROBE_PLAN.probes) failures.push("CALL_COUNT");
  for (let index = 1; index <= LATENCY_PROBE_PLAN.probes; index += 1) {
    const matches = report.probes.filter((entry) => entry.probe === index);
    if (matches.length !== 1) {
      failures.push(`PROBE_MISSING:${index}`);
      continue;
    }
    const entry = matches[0]!;
    if (entry.outcome === "TIMEOUT") failures.push(`TIMEOUT:${index}`);
    else if (entry.outcome !== "COMPLETED") failures.push(`FAILED:${index}`);
    else {
      if (entry.responseModel !== approved.responseModelSnapshot) failures.push(`RESPONSE_MODEL_MISMATCH:${index}`);
      if (entry.schemaConformant !== true) failures.push(`SCHEMA_INVALID:${index}`);
      else if (entry.validator !== "ACCEPTED") failures.push(`VALIDATOR:${index}:${entry.validator ?? "MISSING"}`);
    }
  }
  if (!(report.summary.credits <= approved.maxCredits)) failures.push("CREDITS_OVER_CEILING");
  return failures.length === 0 ? { kind: "PASS" } : { kind: "FAIL", failures };
}
