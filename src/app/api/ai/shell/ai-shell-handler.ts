import { AI_ACTIVATION_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { PROVIDER_FAILURE_REASONS, type ProviderInvocationResult, type ProviderUsage, type ShellStructuralRejectionReason } from "@/application/ai/ai-provider-port";
import { AI_SHELL_MAX_BODY_BYTES, aiShellRouteResponseSchema, type AiShellRouteResponse } from "@/application/ai/ai-shell-route-contract";
import { isApprovedShellTaskRequest, shellPlanView } from "@/application/ai/language/shell-projector";
import { validateShellCandidate, type ShellValidationReason } from "@/application/ai/language/shell-validator";
import { FIXED_FIELD_BUDGETS, type FieldKind } from "@/application/ai/language/slot-planner";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { shellOutputSchema, shellTaskRequestSchema, type AiReasonCode, type ShellTaskRequest } from "@/domain/ai";
import { DEEPSEEK_DOCUMENTED_MODELS, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { readLimitedUtf8 } from "@/ai/kie/kie-responses-provider";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";

/**
 * The value-blind shell route POST /api/ai/shell (Packet 11C Addendum B, Task B2a; B-boundary, D1, D2, D6). Server-only.
 *
 * The client submits exactly one approved `ShellTaskRequest`: slot identifiers, atom kinds, approved glosses and headings, the fixed field
 * budgets and the versioned bundle key; never a fact, value, date, question, period summary, source or reference. In order, before any
 * credential read: method, content type, body cap, strict JSON, `shellTaskRequestSchema` (strict: an unknown field is refused),
 * `isApprovedShellTaskRequest`, the hybrid bundle key, the planner's fixed per-kind field shape (budget, sentences, atom-only), then the
 * server-side activation check with the compiled profile. Only then is the credential read and one bounded call made, through the Direct
 * DeepSeek deepseek-flash shell provider (D2; the shared Responses adapter builds the unchanged model-facing body), within the bundle's
 * per-call time ceiling and the route's request-rate ceiling. A response the provider does not explicitly report as not stored is refused.
 * The server shell gates (S1–S7b, validateShellCandidate over the plan view rebuilt from the request) then decide: a valid shell returns
 * the strictly parsed candidate; a rejected one returns the typed structural rejection (D6: closed reason, repairable flag, retention,
 * usage) and never the candidate. The route makes one call per request and never repairs; the single structural repair is the browser
 * hybrid service's, within the bundle's maxAttempts. Failures return a closed reason only. Nothing is activated here: the shipped manifest
 * is deterministic-only, so the shipped route refuses every request before the credential read.
 */

const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 10, windowMs: 60_000 });
/** D2: the route's fixed provider model. Not a production pin: runtime bundles keep `modelSnapshot: null` and nothing is activated. */
const SHELL_ROUTE_REQUEST_MODEL_ID = "deepseek-flash";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export type AiShellHandlerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  /** Test seam only: a fake transport for the fixed provider. */
  fetcher?: Fetcher;
  now?: () => Date;
  activationManifest?: AiActivationManifest;
  /** The compiled release profile; defaults to the storage profile identity. */
  releaseProfile?: unknown;
  rateLimit?: { maxRequests: number; windowMs: number };
};

function reply(body: AiShellRouteResponse, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
const failed = (reason: AiReasonCode, status = 200) => reply({ kind: "FAILED", reason }, status);

/** The route's model snapshot, built from the documented deepseek-flash entry exactly as the evaluated runners select it. */
function shellRouteModel(): KieModelSnapshot | null {
  const documented = DEEPSEEK_DOCUMENTED_MODELS.find((model) => model.requestModelId === SHELL_ROUTE_REQUEST_MODEL_ID);
  if (!documented) return null;
  return Object.freeze({
    requestModelId: documented.requestModelId,
    responseModelSnapshot: documented.responseModelSnapshot,
    provenance: documented.provenance,
    endpoint: documented.endpoint,
    contextWindow: null,
    defaultReasoningLevel: null,
    supportedReasoningLevels: documented.supportedReasoningLevels,
    retrievedAt: documented.documentedAt,
    documentationUrl: documented.documentationUrl,
  });
}

/** The planner's fixed field kind of a remote field path (EXPLAIN headline/evidence; care intro/bullet). */
function fieldKind(path: string): FieldKind | null {
  if (path === "headline" || path === "evidence") return path;
  if (/^sections\[\d\]\.intro$/.test(path)) return "intro";
  if (/^sections\[\d\]\.bullets\[\d+\]$/.test(path)) return "bullet";
  return null;
}

/**
 * Every remote field carries exactly the planner's fixed shape for its task, locale and kind: maxCodePoints from FIXED_FIELD_BUDGETS
 * (slot-planner.ts), one sentence, and atom-only allowed for a care bullet only. A client can neither widen nor narrow a budget.
 */
function fixedFieldShape(request: ShellTaskRequest): boolean {
  const budgets: Readonly<Partial<Record<FieldKind, number>>> = FIXED_FIELD_BUDGETS[request.taskType][request.locale];
  return request.fields.every((field) => {
    const kind = fieldKind(field.path);
    return kind !== null && budgets[kind] !== undefined && field.maxCodePoints === budgets[kind] && field.maxSentences === 1 && field.mayBeAtomOnly === (kind === "bullet");
  });
}

const bounded = (value: unknown, max: number): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null);
const boundedUsage = (usage: ProviderUsage) => ({ inputTokens: bounded(usage.inputTokens, 100_000), outputTokens: bounded(usage.outputTokens, 100_000), costMicroUsd: bounded(usage.costMicroUsd, 10_000_000) });
/** Compile-time check: every shell-gate reason is a closed structural-rejection reason of the port (D6). */
const asRejectionReason = (reason: ShellValidationReason): ShellStructuralRejectionReason => reason;

export function createAiShellHandler(options: AiShellHandlerOptions): (request: Request) => Promise<Response> {
  const manifest = options.activationManifest ?? AI_ACTIVATION_MANIFEST;
  const profile = "releaseProfile" in options ? options.releaseProfile : HACKATHON_STORAGE_PROFILE.profileId;
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const admitted: number[] = [];

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return failed("PAYLOAD_INVALID", 405);
    if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return failed("PAYLOAD_INVALID", 415);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > AI_SHELL_MAX_BODY_BYTES) return failed("BUDGET_EXCEEDED", 413);

    let text: string | null;
    try {
      text = await readLimitedUtf8(request.body, AI_SHELL_MAX_BODY_BYTES);
    } catch {
      return failed(request.signal.aborted ? "REQUEST_CANCELLED" : "PAYLOAD_INVALID", request.signal.aborted ? 200 : 400);
    }
    if (text === null) return failed("BUDGET_EXCEEDED", 413);
    let value: unknown;
    try {
      value = toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: AI_SHELL_MAX_BODY_BYTES }));
    } catch {
      return failed("PAYLOAD_INVALID", 400);
    }
    // Strict schema (no unknown field: facts, values, dates, questions, periodSummary, sources, refs or provider settings are refused),
    // then approval (approved glosses and headings only, no digit, unit or reference), then the exact hybrid bundle and fixed field shape.
    const parsed = shellTaskRequestSchema.safeParse(value);
    if (!parsed.success || !isApprovedShellTaskRequest(parsed.data)) return failed("PAYLOAD_INVALID", 400);
    const shellRequest = parsed.data;
    const bundle = AI_HYBRID_RUNTIME_BUNDLES[shellRequest.taskType];
    if (shellRequest.runtimeBundleKey !== bundle.bundleKey || !fixedFieldShape(shellRequest)) return failed("PAYLOAD_INVALID", 400);
    const plan = shellPlanView(shellRequest);

    // Activation is checked on the server too; the shipped manifest is deterministic-only, so the shipped route stops here.
    const activation = resolveAiTaskActivation(shellRequest.taskType, profile, manifest);
    if (activation.state !== "SYNTHETIC_REMOTE_ENABLED") return failed(activation.reason);

    // The credential is read only now, after every request check.
    const token = readDeepSeekToken(options.environment);
    if (token.kind === "MISSING_CONFIGURATION") return failed("MISSING_CONFIGURATION");
    const model = shellRouteModel();
    if (!model) return failed("MISSING_CONFIGURATION");

    const at = now().getTime();
    while (admitted.length > 0 && admitted[0]! <= at - limit.windowMs) admitted.shift();
    if (admitted.length >= limit.maxRequests) return failed("PROVIDER_RATE_LIMITED");
    admitted.push(at);

    // One bounded call: the bundle's per-call ceiling or client cancellation aborts the provider request, and a result arriving after
    // either is discarded.
    const controller = new AbortController();
    let stopped: "PROVIDER_TIMEOUT" | "REQUEST_CANCELLED" | null = null;
    const stop = (reason: "PROVIDER_TIMEOUT" | "REQUEST_CANCELLED") => {
      stopped ??= reason;
      controller.abort();
    };
    const onCancel = () => stop("REQUEST_CANCELLED");
    const timer = setTimeout(() => stop("PROVIDER_TIMEOUT"), bundle.executionBudget.perCallTimeoutMs);
    request.signal.addEventListener("abort", onCancel);
    if (request.signal.aborted) onCancel();
    try {
      const provider = createDeepSeekShellResponsesProvider({ token: token.token, model, fetcher: options.fetcher });
      const aborted = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null)));
      const result: ProviderInvocationResult | null = controller.signal.aborted
        ? null
        : await Promise.race([provider.invoke(shellRequest, controller.signal).catch((): ProviderInvocationResult => ({ kind: "FAILED", reason: "TRANSPORT_FAILED" })), aborted]);
      if (stopped || !result) return failed(stopped ?? "TRANSPORT_FAILED");
      if (result.kind === "FAILED") return failed((PROVIDER_FAILURE_REASONS as readonly string[]).includes(result.reason) ? result.reason : "PROVIDER_FAILED");
      // Fail closed: only a completed response the provider explicitly reports as not stored is gated and answered. A completed (billed)
      // response refused for retention reports only its bounded usage (Packet 11C B2b), so the browser service counts the spend.
      if (result.kind !== "COMPLETED") return failed("PROVIDER_FAILED");
      const usage = boundedUsage(result.usage);
      if (result.retention !== "CONFIRMED_NOT_STORED") return reply({ kind: "FAILED", reason: "PROVIDER_FAILED", usage });

      // The server shell gates over the value-blind plan view. A rejection returns the closed reason only (never the candidate or a
      // gate detail); the browser makes the one structural repair, if any.
      const gates = validateShellCandidate(plan, bundle, result.candidate);
      const body: AiShellRouteResponse =
        gates.kind === "REJECTED"
          ? { kind: "STRUCTURALLY_REJECTED", reason: asRejectionReason(gates.reason), repairable: gates.repairable, retention: "CONFIRMED_NOT_STORED", usage }
          : { kind: "CANDIDATE", candidate: shellOutputSchema(shellRequest.taskType).parse(typeof result.candidate === "string" ? toPlainData(parseStrictJson(result.candidate, { maxDepth: 16, maxLength: 65_536 })) : result.candidate) as never, retention: "CONFIRMED_NOT_STORED", usage };
      return aiShellRouteResponseSchema.safeParse(body).success ? reply(body) : failed("PROVIDER_FAILED");
    } catch {
      return failed("PROVIDER_FAILED");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onCancel);
    }
  };
}
