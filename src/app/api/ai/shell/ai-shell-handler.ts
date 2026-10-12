import { AI_ACTIVATION_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { PROVIDER_FAILURE_REASONS, type ProviderInvocationResult, type ProviderUsage, type ShellStructuralRejectionReason } from "@/application/ai/ai-provider-port";
import { AI_SHELL_MAX_BODY_BYTES, aiShellRouteResponseSchema, shellRouteCallUpperBound, type AiShellAccessProbeResponse, type AiShellRouteRefusalReason, type AiShellRouteResponse } from "@/application/ai/ai-shell-route-contract";
import { isApprovedShellTaskRequest, shellPlanView } from "@/application/ai/language/shell-projector";
import { validateShellCandidate, type ShellValidationReason } from "@/application/ai/language/shell-validator";
import { FIXED_FIELD_BUDGETS, type FieldKind } from "@/application/ai/language/slot-planner";
import { SHIPPED_REQUEST_CLASS_GATE, type AiRequestClassGate } from "@/application/ai/request-class-qualification";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { shellOutputSchema, shellTaskRequestSchema, type AiReasonCode, type ShellTaskRequest } from "@/domain/ai";
import { DEEPSEEK_DOCUMENTED_MODELS, readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { readLimitedUtf8 } from "@/ai/kie/kie-responses-provider";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";
import { accessGranted, originAllowed, parseAiShellDeploymentConfig, type AiShellDeploymentConfig } from "./ai-shell-deployment-config";
import { InMemoryDailySpendLedger, type SpendLedger, type SpendReservationToken } from "./ai-spend-ledger";

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
 * Packet 11C Addendum C, Task C5: every FAILED after the provider call started (a potentially billed call) carries that call's usage:
 * the reported usage (also for a candidate that fails the re-parse), else the adapter's exact-body upper bound, else (no result: the
 * timeout, a cancellation) the route's pre-send upper bound for the request, with its basis. A FAILED decided before the call carries
 * none. Result handling only: the model-facing body is unchanged.
 * Packet 11C Addendum C, Task C1: after the activation check and BEFORE the credential read, the received request's class (its canonical
 * digest bound to the current contract) must be QUALIFIED by the injected request-class gate (production: the shipped records, all
 * PENDING). Otherwise the answer is the closed `REFUSED` REQUEST_CLASS_NOT_QUALIFIED (HTTP 403, no usage): nothing is read or sent.
 * Packet 11C Addendum C, Task C6 (owner approval of Addendum C; C6 amendment): the deployment configuration (ai-shell-deployment-config.ts;
 * parsed once per route instance, no value has a code default) and the spend ledger (ai-spend-ledger.ts). The full order, every step
 * before the credential read:
 *   1. method, content type, body cap, strict JSON, schema, approval, bundle key, fixed field shape (unchanged);
 *   2. the server-side remote-AI switch (off, missing or invalid: REFUSED REMOTE_AI_DISABLED);
 *   3. origin protection: Origin in the configured allow-list AND `Sec-Fetch-Site: same-origin` (else ORIGIN_REJECTED);
 *   4. access authorization: the demo passcode header, compared in constant time (else ACCESS_DENIED);
 *   5. server activation (unchanged closed FAILED);
 *   6. request-class qualification (C1: REQUEST_CLASS_NOT_QUALIFIED);
 *   7. the spend reservation of the request's pre-send upper bound (`shellRouteCallUpperBound`) against the per-instance daily guard
 *      (SPEND_NOT_CONFIGURED, SPEND_CEILING_REACHED, SPEND_LEDGER_UNAVAILABLE);
 *   8. the credential read, the rate limit (unchanged), the one bounded call, then the settlement: a call that was never transmitted
 *      (an answer without usage) releases the whole reservation; a transmitted call commits its reported cost, or the full reserved upper
 *      bound when its usage is missing or unreadable (never zero), and releases only the unused remainder.
 * Every refusal in steps 2–4, 6 and 7 is HTTP 403 `REFUSED` with the explicit `notSentToProvider: true` marker and no usage. Origin
 * protection is not authentication, and the per-instance ledger is a best-effort guard, not a global cap. A settlement error never
 * changes the answer (the reservation then stays held, which only over-counts).
 * C6 fix round 1: every closed FAILED decided before the provider call (steps 1, 5 and 8 before the invoke: request checks, activation,
 * missing credential or model, the rate limit, a cancellation before the call, an adapter failure reported as not transmitted) also
 * carries `notSentToProvider: true` and no usage; a FAILED after the call may have started carries usage and no marker (C5).
 * Owner decision 2026-10-12 (optional passcodes): step 4 grants without a passcode when the deployment configures none
 * (`accessGranted`); the order and every other step are unchanged. `GET` on the same route is the passcode probe: it answers
 * `{ passcodeRequired }` only (the parsed configuration's boolean). It reads no body, never the credential, reserves nothing and calls
 * no provider; a request the browser marks cross-site gets the conservative `true`; it has its own per-instance window with the POST's
 * limit (429, `true`). Any other method stays 405.
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
  /**
   * Packet 11C Addendum C (C1): which request classes may be sent. Absent means the shipped gate (the generated definitions and the
   * shipped qualification records, all PENDING); route.ts passes none. Test seam only: tests inject test-only QUALIFIED records.
   */
  requestClassGate?: AiRequestClassGate;
  /**
   * Packet 11C Addendum C (C6): the spend ledger. Absent means the shipped one: one `InMemoryDailySpendLedger` per route instance over the
   * configured daily limit (route.ts passes none). Test seam only: tests inject fake or spying ledgers.
   */
  spendLedger?: SpendLedger;
};

function reply(body: AiShellRouteResponse | AiShellAccessProbeResponse, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
/** C6 fix round 1: a FAILED decided before the provider call: the closed reason with the explicit "not sent to provider" marker. */
const failed = (reason: AiReasonCode, status = 200) => reply({ kind: "FAILED", reason, notSentToProvider: true }, status);
/** Packet 11C Addendum C (C1, C6): a closed refusal before any credential read or provider call, explicitly marked as not sent. */
const refused = (reason: AiShellRouteRefusalReason) => reply({ kind: "REFUSED", reason, notSentToProvider: true }, 403);
type Answer = Readonly<{ body: AiShellRouteResponse; status: number }>;
const answer = (body: AiShellRouteResponse, status = 200): Answer => ({ body, status });

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
/** Packet 11C Addendum C (C5): a potentially billed FAILED call's usage, with its basis (the provider's report, or a pre-send bound). */
const failedUsage = (usage: ProviderUsage) => ({ ...boundedUsage(usage), basis: usage.basis === "UPPER_BOUND" ? ("UPPER_BOUND" as const) : ("REPORTED" as const) });
/** Compile-time check: every shell-gate reason is a closed structural-rejection reason of the port (D6). */
const asRejectionReason = (reason: ShellValidationReason): ShellStructuralRejectionReason => reason;

export function createAiShellHandler(options: AiShellHandlerOptions): (request: Request) => Promise<Response> {
  const manifest = options.activationManifest ?? AI_ACTIVATION_MANIFEST;
  const profile = "releaseProfile" in options ? options.releaseProfile : HACKATHON_STORAGE_PROFILE.profileId;
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const requestClassGate = options.requestClassGate ?? SHIPPED_REQUEST_CLASS_GATE;
  const admitted: number[] = [];
  // Owner decision 2026-10-12 (optional passcodes): the passcode probe's own per-instance window (never the provider-call window).
  const probed: number[] = [];
  // Packet 11C Addendum C (C6): the deployment configuration is parsed once, when the first request passes the request checks (the
  // deployment environment does not change while an instance runs); the shipped ledger is created once over the configured daily limit.
  let config: AiShellDeploymentConfig | null = null;
  const deploymentConfig = () => (config ??= parseAiShellDeploymentConfig(options.environment));
  let instanceLedger: SpendLedger | null = null;
  const spendLedger = (dailyLimitMicroUsd: number): SpendLedger => options.spendLedger ?? (instanceLedger ??= new InMemoryDailySpendLedger({ dailyLimitMicroUsd }));

  async function handle(request: Request): Promise<Response> {
    // Owner decision 2026-10-12 (optional passcodes): the passcode probe (no body, no credential, no reservation, no provider call).
    if (request.method === "GET") {
      const at = now().getTime();
      while (probed.length > 0 && probed[0]! <= at - limit.windowMs) probed.shift();
      if (probed.length >= limit.maxRequests) return reply({ passcodeRequired: true }, 429);
      probed.push(at);
      const site = request.headers.get("Sec-Fetch-Site");
      if (site !== null && site !== "same-origin") return reply({ passcodeRequired: true });
      return reply({ passcodeRequired: deploymentConfig().passcodeRequired });
    }
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

    // Packet 11C Addendum C (C6): the server-side switch, origin protection and access authorization, each with its own closed refusal.
    const deployment = deploymentConfig();
    if (!deployment.remoteAiEnabled) return refused("REMOTE_AI_DISABLED");
    if (!originAllowed(deployment, request.headers)) return refused("ORIGIN_REJECTED");
    if (!accessGranted(deployment, request.headers)) return refused("ACCESS_DENIED");

    // Activation is checked on the server too; the shipped manifest is deterministic-only, so the shipped route stops here.
    const activation = resolveAiTaskActivation(shellRequest.taskType, profile, manifest);
    if (activation.state !== "SYNTHETIC_REMOTE_ENABLED") return failed(activation.reason);

    // Packet 11C Addendum C (C1): the received request's own class, under the current contract, must be QUALIFIED; otherwise the closed
    // refusal (HTTP 403, no usage), still before the credential read. A gate that throws refuses.
    let classQualified = false;
    try {
      classQualified = requestClassGate.admit(shellRequest).admitted === true;
    } catch {
      classQualified = false;
    }
    if (!classQualified) return refused("REQUEST_CLASS_NOT_QUALIFIED");

    // Packet 11C Addendum C (C6): reserve the request's pre-send upper bound (the last check before the credential read). Not configured,
    // refused, a ledger error or an answer that is not a reservation: the closed refusal (fail closed).
    if (deployment.dailySpendLimitMicroUsd === null) return refused("SPEND_NOT_CONFIGURED");
    const upperBoundMicroUsd = shellRouteCallUpperBound(shellRequest).costMicroUsd;
    let ledger: SpendLedger;
    let reservation: SpendReservationToken;
    try {
      ledger = spendLedger(deployment.dailySpendLimitMicroUsd);
      const reserved = await ledger.reserve(upperBoundMicroUsd, now());
      if (reserved?.kind === "REFUSED" && (reserved.reason === "SPEND_CEILING_REACHED" || reserved.reason === "SPEND_LEDGER_UNAVAILABLE")) return refused(reserved.reason);
      if (reserved?.kind !== "RESERVED" || typeof reserved.token !== "object" || reserved.token === null) return refused("SPEND_LEDGER_UNAVAILABLE");
      reservation = reserved.token;
    } catch {
      return refused("SPEND_LEDGER_UNAVAILABLE");
    }

    let result: Answer;
    try {
      result = await callProvider(request, shellRequest, plan, bundle);
    } catch {
      result = answer({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: failedUsage(shellRouteCallUpperBound(shellRequest)) });
    }
    // The settlement: an answer without usage was never transmitted (release all); a transmitted call commits its reported cost, or the
    // full reserved upper bound when its usage is missing or unreadable. Best effort: a ledger error never changes the answer.
    const usage = result.body.kind === "REFUSED" ? undefined : result.body.usage;
    try {
      if (!usage) await ledger.release(reservation);
      else if (usage.basis !== "UPPER_BOUND" && usage.costMicroUsd !== null) await ledger.commit(reservation, usage.costMicroUsd, "REPORTED");
      else await ledger.commit(reservation, upperBoundMicroUsd, "UPPER_BOUND");
    } catch {
      // The reservation stays held: it only over-counts.
    }
    return reply(result.body, result.status);
  }

  /** Steps after the reservation: the credential read, the rate limit and the one bounded call. Never throws a refusal of its own. */
  async function callProvider(request: Request, shellRequest: ShellTaskRequest, plan: ReturnType<typeof shellPlanView>, bundle: (typeof AI_HYBRID_RUNTIME_BUNDLES)[ShellTaskRequest["taskType"]]): Promise<Answer> {
    // C6 fix round 1: every answer through `failed` here is decided before the provider call (no credential or model, the rate limit,
    // a stop before invoke, or an adapter failure it reports as not transmitted): marked not sent, never with usage. Every answer after
    // the call may have started goes through `failedAfterCall` (usage, no marker).
    const failed = (reason: AiReasonCode) => answer({ kind: "FAILED", reason, notSentToProvider: true });
    // The credential is read only now, after every request check and the spend reservation.
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
    // Packet 11C Addendum C (C5): once the provider call has started it may be billed. From then on every FAILED carries usage: the
    // call's reported usage when known, else the provider's own pre-send bound for the exact body, else (no result at all: the route's
    // timeout, a cancellation, a provider that ignored the abort) the route's pre-send upper bound for this request. Never zero.
    let called = false;
    // C5 fix round 1: the provider threw (possibly after transmitting), so the call counts at the route's upper bound, never zero.
    let threw = false;
    let billed: ProviderUsage | null = null;
    const failedAfterCall = (reason: AiReasonCode) => answer({ kind: "FAILED", reason, usage: failedUsage(billed ?? shellRouteCallUpperBound(shellRequest)) });
    try {
      const provider = createDeepSeekShellResponsesProvider({ token: token.token, model, fetcher: options.fetcher });
      const aborted = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null)));
      let result: ProviderInvocationResult | null = null;
      if (!controller.signal.aborted) {
        called = true;
        result = await Promise.race([
          provider.invoke(shellRequest, controller.signal).catch((): ProviderInvocationResult => {
            threw = true;
            return { kind: "FAILED", reason: "TRANSPORT_FAILED" };
          }),
          aborted,
        ]);
      }
      if (!called) return failed(stopped ?? "TRANSPORT_FAILED");
      if (stopped || !result) return failedAfterCall(stopped ?? "TRANSPORT_FAILED");
      if (result.usage) billed = result.usage;
      if (result.kind === "FAILED") {
        const reason = (PROVIDER_FAILURE_REASONS as readonly string[]).includes(result.reason) ? result.reason : "PROVIDER_FAILED";
        // The adapter gives every failure after transmission its usage; one without usage was never transmitted (nothing billed), unless
        // the adapter threw, which counts at the route's upper bound (consistent with the hybrid service).
        return result.usage || threw ? failedAfterCall(reason) : failed(reason);
      }
      // Fail closed: only a completed response the provider explicitly reports as not stored is gated and answered. A completed (billed)
      // response refused for retention reports only its bounded usage (Packet 11C B2b), so the browser service counts the spend.
      if (result.kind !== "COMPLETED") return failedAfterCall("PROVIDER_FAILED");
      const usage = boundedUsage(result.usage);
      if (result.retention !== "CONFIRMED_NOT_STORED") return failedAfterCall("PROVIDER_FAILED");

      // The server shell gates over the value-blind plan view. A rejection returns the closed reason only (never the candidate or a
      // gate detail); the browser makes the one structural repair, if any.
      const gates = validateShellCandidate(plan, bundle, result.candidate);
      const body: AiShellRouteResponse =
        gates.kind === "REJECTED"
          ? { kind: "STRUCTURALLY_REJECTED", reason: asRejectionReason(gates.reason), repairable: gates.repairable, retention: "CONFIRMED_NOT_STORED", usage }
          : { kind: "CANDIDATE", candidate: shellOutputSchema(shellRequest.taskType).parse(typeof result.candidate === "string" ? toPlainData(parseStrictJson(result.candidate, { maxDepth: 16, maxLength: 65_536 })) : result.candidate) as never, retention: "CONFIRMED_NOT_STORED", usage };
      return aiShellRouteResponseSchema.safeParse(body).success ? answer(body) : failedAfterCall("PROVIDER_FAILED");
    } catch {
      // C5: a candidate that fails the re-parse above (after a completed, billed call) keeps that call's usage.
      return called ? failedAfterCall("PROVIDER_FAILED") : failed("PROVIDER_FAILED");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onCancel);
    }
  }

  return handle;
}
