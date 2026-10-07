import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { AI_ACTIVATION_MANIFEST, resolveAiTaskActivation, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { resolveAiTaskBundle, type AiTaskRuntimeBundle } from "@/application/ai/ai-runtime-bundles";
import type { ProviderInvocationResult } from "@/application/ai/ai-provider-port";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { providerTaskRequestSchema, type AiReasonCode, type AiTaskRequest, type ProviderTaskRequest } from "@/domain/ai";
import { PACKET_11_REMOTE_TASKS } from "@/ai/prompts/packet-11-prompts";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { readKieToken, resolveProductKieRoute } from "@/ai/kie/kie-route-config";
import { createKieResponsesProvider, readLimitedUtf8 } from "@/ai/kie/kie-responses-provider";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";

/**
 * Closed same-origin AI task route (Packet 11B Task 3; design Sections 5–7).
 *
 * The client submits one detached provider request and nothing else: no
 * prompt, model, endpoint, tools or instructions. The server independently
 * rechecks the compiled profile, the two remote-eligible tasks, activation,
 * the exact runtime bundle, the field allowlist, identifier redaction and
 * budgets, then makes one bounded Kie call. It returns only the untrusted
 * normalised candidate and bounded usage for client-side whole-result
 * validation and audit, or a closed reason. The shipped manifest is
 * deterministic-only and no bundle pins a model, so the product route never
 * calls Kie in 11B.
 */

export const AI_TASK_MAX_BODY_BYTES = 32_768;
const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 10, windowMs: 60_000 });

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Body = { kind: "COMPLETED"; candidate: unknown; usage: { inputTokens: number | null; outputTokens: number | null; credits: number | null } } | { kind: "UNAVAILABLE"; reason: AiReasonCode };

function reply(body: Body, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
const unavailable = (reason: AiReasonCode, status = 200) => reply({ kind: "UNAVAILABLE", reason }, status);

export type AiTaskHandlerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  fetcher?: Fetcher;
  now?: () => Date;
  activationManifest?: AiActivationManifest;
  /** The compiled release profile; defaults to the storage profile identity. */
  releaseProfile?: unknown;
  /** Test seam: the model for a bundle. Production uses only the bundle's pinned snapshot (none in 11B). */
  resolveModel?: (bundle: AiTaskRuntimeBundle) => KieModelSnapshot | null;
  rateLimit?: { maxRequests: number; windowMs: number };
};

/** The server's own projection of the submitted payload must reproduce it exactly. */
function serverRecheck(request: ProviderTaskRequest, bundle: AiTaskRuntimeBundle, now: Date): AiReasonCode | null {
  // Option B: an EXPLAIN_PATTERN provider payload carries the approved claim meaning and no limitations. The
  // internal request is rebuilt without the client's meaning (the projector re-derives it from the registry)
  // and with one approved placeholder limitation, which never crosses the boundary; any client-altered meaning
  // or field therefore fails the byte-for-byte comparison below.
  const taskPayload =
    request.taskType === "EXPLAIN_PATTERN"
      ? { claim: { ref: request.taskPayload.claim.ref, family: request.taskPayload.claim.family, factRefs: request.taskPayload.claim.factRefs }, limitations: [{ ref: "limitation-1", code: "DOES_NOT_ESTABLISH_CAUSE" }] }
      : request.taskPayload;
  const internal = {
    ...request,
    taskPayload,
    requestId: crypto.randomUUID(),
    requestedAt: now.toISOString(),
    releaseProfile: "HACKATHON_DEMO",
    facts: request.facts.map((fact) => ({ ...fact, sources: [] })),
  } as unknown as AiTaskRequest;
  const projected = projectProviderTaskPayload(internal, bundle);
  if (projected.kind === "FALLBACK") return projected.reason;
  // Any difference means the client sent text that local redaction would have changed.
  return canonicalizeJson(projected.payload) === canonicalizeJson(request) ? null : "PRIVACY_REJECTED";
}

export function createAiTaskHandler(options: AiTaskHandlerOptions): (request: Request) => Promise<Response> {
  const manifest = options.activationManifest ?? AI_ACTIVATION_MANIFEST;
  const profile = "releaseProfile" in options ? options.releaseProfile : HACKATHON_STORAGE_PROFILE.profileId;
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const admitted: number[] = [];
  const resolveModel =
    options.resolveModel ??
    ((bundle: AiTaskRuntimeBundle) => {
      const route = resolveProductKieRoute(bundle, options.environment);
      return route.kind === "CONFIGURED" ? route.model : null;
    });

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return unavailable("PAYLOAD_INVALID", 405);
    if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return unavailable("PAYLOAD_INVALID", 415);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > AI_TASK_MAX_BODY_BYTES) return unavailable("BUDGET_EXCEEDED", 413);

    let text: string | null;
    try {
      text = await readLimitedUtf8(request.body, AI_TASK_MAX_BODY_BYTES);
    } catch {
      return unavailable(request.signal.aborted ? "REQUEST_CANCELLED" : "PAYLOAD_INVALID", request.signal.aborted ? 200 : 400);
    }
    if (text === null) return unavailable("BUDGET_EXCEEDED", 413);
    let parsed;
    try {
      parsed = providerTaskRequestSchema.safeParse(toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: AI_TASK_MAX_BODY_BYTES })));
    } catch {
      return unavailable("PAYLOAD_INVALID", 400);
    }
    if (!parsed.success) return unavailable("PAYLOAD_INVALID", 400);
    const payload = parsed.data as ProviderTaskRequest;

    // Only the two approved tasks can ever leave the server, whatever a manifest says.
    if (!(PACKET_11_REMOTE_TASKS as readonly string[]).includes(payload.taskType)) return unavailable("TASK_DISABLED", 403);
    const activation = resolveAiTaskActivation(payload.taskType, profile, manifest);
    if (activation.state !== "SYNTHETIC_REMOTE_ENABLED") return unavailable(activation.reason);
    const bundle = resolveAiTaskBundle(payload.taskType, payload.locale);
    if (payload.runtimeBundleKey !== bundle.bundleKey) return unavailable("PAYLOAD_INVALID", 400);
    const recheck = serverRecheck(payload, bundle, now());
    if (recheck) return unavailable(recheck);

    const token = readKieToken(options.environment);
    if (token.kind === "MISSING_CONFIGURATION") return unavailable("MISSING_CONFIGURATION");
    const model = resolveModel(bundle);
    if (!model) return unavailable("MISSING_CONFIGURATION");

    const at = now().getTime();
    while (admitted.length > 0 && admitted[0]! <= at - limit.windowMs) admitted.shift();
    if (admitted.length >= limit.maxRequests) return unavailable("PROVIDER_RATE_LIMITED");
    admitted.push(at);

    // One bounded call: the bundle's per-call ceiling or client cancellation aborts the fetch,
    // and a result arriving after either is discarded.
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
      const provider = createKieResponsesProvider({ token: token.token, model, fetcher: options.fetcher });
      const aborted = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null)));
      const result: ProviderInvocationResult | null = controller.signal.aborted
        ? null
        : await Promise.race([provider.invoke(payload, controller.signal).catch((): ProviderInvocationResult => ({ kind: "FAILED", reason: "TRANSPORT_FAILED" })), aborted]);
      if (stopped || !result) return unavailable(stopped ?? "TRANSPORT_FAILED");
      if (result.kind === "FAILED") return unavailable(result.reason);
      // Fail closed: only a response Kie explicitly reports as not stored may reach the client.
      if (result.retention !== "CONFIRMED_NOT_STORED") return unavailable("PROVIDER_FAILED");
      return reply({ kind: "COMPLETED", candidate: result.candidate, usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits ?? null } });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onCancel);
    }
  };
}
