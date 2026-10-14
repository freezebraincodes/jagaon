import type { ProviderFailureReason, ProviderUsage } from "@/application/ai/ai-provider-port";
import {
  FEELINGS_CHAT_MAX_BODY_BYTES,
  feelingsChatRouteResponseSchema,
  type FeelingsChatRouteResponse,
  type FeelingsChatUnavailableReason,
} from "@/application/feelings-chat/feelings-chat-route-contract";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { feelingsChatRequestSchema, type FeelingsChatRequest } from "@/domain/feelings-chat/feelings-chat-contract";
import { validateFeelingsChatReply } from "@/domain/feelings-chat/feelings-chat-validator";
import { readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { readLimitedUtf8 } from "@/ai/kie/kie-responses-provider";
import { invokeFeelingsChat, type FeelingsChatProviderResult } from "@/ai/feelings-chat/feelings-chat-provider";
import { buildFeelingsChatBody, feelingsChatCallUpperBound, feelingsChatModel } from "@/ai/feelings-chat/feelings-chat-request";
import { AI_SHELL_DEPLOYMENT_ENV, accessGranted, originAllowed, parseAiShellDeploymentConfig, type AiShellDeploymentConfig } from "../shell/ai-shell-deployment-config";
import { InMemoryDailySpendLedger, type SpendLedger, type SpendReservationToken } from "../shell/ai-spend-ledger";

/**
 * Tell JagaOn understands more (design §3.8): POST /api/ai/feelings, one bounded DeepSeek call per feelings-chat turn. Server-only.
 * Modelled on POST /api/ai/transcript.
 *
 * Order (every step before the credential read):
 *   1. method, content type, body cap, strict JSON, `feelingsChatRequestSchema` (strict: only task, turn, maxTurns and messages of
 *      role and text; any other field is refused, so readings, medicines, names, dates or IDs cannot be sent);
 *   2. the shared remote-AI switch `JAGAON_REMOTE_AI` AND this task's own switch `JAGAON_AI_FEELINGS_CHAT` (both exactly `on`; else
 *      DISABLED);
 *   3. origin protection and 4. the demo passcode (the shared C6 deployment configuration, read-only reuse, with its optional-passcode
 *      rule);
 *   5. the spend reservation of this exact body's upper bound against THIS route's own per-instance daily ledger, whose limit is this
 *      task's own `JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD` (same format as the other routes' limits: a positive USD decimal with at
 *      most 6 decimals; missing or malformed is NOT_CONFIGURED);
 *   6. the credential read, the rate limit, ONE bounded call (no retry, no repair), the settlement, then the validator
 *      (feelings-chat-validator.1) over the parsed output.
 * There is no activation-manifest or qualification step: this task is not one of the 11C shell tasks, and its two switches (off by
 * default) plus its own spend limit are the owner's gate (design §3.8).
 *
 * The chat text lives in memory for this request only: it is never logged, stored, echoed or put in an error. Only OK carries text (the
 * validated reply); REJECTED and UNAVAILABLE carry closed codes only.
 *
 * Spend: this route keeps its OWN counter and limit, separate from the wording route's and the transcript route's. The counters are
 * best-effort and per server instance (in memory); the provider-side account limit remains the only hard cap.
 */
export const FEELINGS_CHAT_ENV = Object.freeze({ switch: "JAGAON_AI_FEELINGS_CHAT", dailySpendLimitUsd: "JAGAON_AI_FEELINGS_DAILY_SPEND_LIMIT_USD" } as const);

/** This route's own daily limit in whole micro-USD, parsed with the shared USD format (read-only reuse); null when missing or malformed. */
export function feelingsChatDailySpendLimitMicroUsd(environment: Readonly<Record<string, string | undefined>>): number | null {
  let value: string | undefined;
  try {
    value = environment[FEELINGS_CHAT_ENV.dailySpendLimitUsd];
  } catch {
    return null;
  }
  return parseAiShellDeploymentConfig({ [AI_SHELL_DEPLOYMENT_ENV.dailySpendLimitUsd]: value }).dailySpendLimitMicroUsd;
}

/** Up to four calls per chat; a person chatting at a normal pace stays far below it. */
const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 10, windowMs: 60_000 });
export const FEELINGS_CHAT_TIMEOUT_MS = 15_000;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export type FeelingsChatHandlerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  /** Test seams only. */
  fetcher?: Fetcher;
  now?: () => Date;
  rateLimit?: { maxRequests: number; windowMs: number };
  spendLedger?: SpendLedger;
  timeoutMs?: number;
};

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (body: FeelingsChatRouteResponse, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const unavailable = (reason: FeelingsChatUnavailableReason, status = 200) => reply({ kind: "UNAVAILABLE", reason }, status);

/** The provider's closed failure reasons, in this route's vocabulary. */
function unavailableFor(reason: ProviderFailureReason | "REQUEST_CANCELLED"): FeelingsChatUnavailableReason {
  switch (reason) {
    case "MISSING_CONFIGURATION":
      return "NOT_CONFIGURED";
    case "PROVIDER_TIMEOUT":
      return "TIMEOUT";
    case "PROVIDER_RATE_LIMITED":
      return "RATE_LIMITED";
    case "OPERATIONAL_SPEND_LOCKED":
      return "OPERATIONAL_SPEND_LOCKED";
    case "REQUEST_CANCELLED":
      return "CANCELLED";
    default:
      return "UPSTREAM_ERROR";
  }
}

type CallOutcome = Readonly<{ body: FeelingsChatRouteResponse; usage: ProviderUsage | null }>;

export function createFeelingsChatHandler(options: FeelingsChatHandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const timeoutMs = options.timeoutMs ?? FEELINGS_CHAT_TIMEOUT_MS;
  const admitted: number[] = [];
  let config: AiShellDeploymentConfig | null = null;
  let spendLimit: { microUsd: number | null } | null = null;
  let instanceLedger: SpendLedger | null = null;
  const spendLedger = (dailyLimitMicroUsd: number): SpendLedger => options.spendLedger ?? (instanceLedger ??= new InMemoryDailySpendLedger({ dailyLimitMicroUsd }));

  return async function handle(request: Request): Promise<Response> {
    // 1. Request checks.
    if (request.method !== "POST") return unavailable("BAD_REQUEST", 405);
    if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return unavailable("BAD_REQUEST", 415);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > FEELINGS_CHAT_MAX_BODY_BYTES) return unavailable("BAD_REQUEST", 413);
    let text: string | null;
    try {
      text = await readLimitedUtf8(request.body, FEELINGS_CHAT_MAX_BODY_BYTES);
    } catch {
      return request.signal.aborted ? unavailable("CANCELLED") : unavailable("BAD_REQUEST", 400);
    }
    if (text === null) return unavailable("BAD_REQUEST", 413);
    let chat: FeelingsChatRequest;
    try {
      const parsed = feelingsChatRequestSchema.safeParse(toPlainData(parseStrictJson(text, { maxDepth: 4, maxLength: FEELINGS_CHAT_MAX_BODY_BYTES })));
      if (!parsed.success) return unavailable("BAD_REQUEST", 400);
      chat = parsed.data;
    } catch {
      return unavailable("BAD_REQUEST", 400);
    }

    // 2–4. Switches, origin, passcode (shared C6 configuration; this task adds its own switch, which can only restrict).
    const deployment = (config ??= parseAiShellDeploymentConfig(options.environment));
    if (!deployment.remoteAiEnabled) return unavailable("DISABLED", 403);
    if (options.environment[FEELINGS_CHAT_ENV.switch] !== "on") return unavailable("DISABLED", 403);
    if (!originAllowed(deployment, request.headers)) return unavailable("ORIGIN_REJECTED", 403);
    if (!accessGranted(deployment, request.headers)) return unavailable("ACCESS_DENIED", 403);

    // 5. Spend reservation of this exact body's upper bound against this route's OWN limit and ledger.
    const dailyLimitMicroUsd = (spendLimit ??= { microUsd: feelingsChatDailySpendLimitMicroUsd(options.environment) }).microUsd;
    if (dailyLimitMicroUsd === null) return unavailable("NOT_CONFIGURED", 403);
    const model = feelingsChatModel();
    const built = model ? buildFeelingsChatBody(chat, model) : null;
    if (!model || !built) return unavailable("NOT_CONFIGURED");
    const upperBound = feelingsChatCallUpperBound(new TextEncoder().encode(built.bodyText).byteLength);
    let ledger: SpendLedger;
    let reservation: SpendReservationToken;
    try {
      ledger = spendLedger(dailyLimitMicroUsd);
      const reserved = await ledger.reserve(upperBound.costMicroUsd, now());
      if (reserved?.kind === "REFUSED" && (reserved.reason === "SPEND_CEILING_REACHED" || reserved.reason === "SPEND_LEDGER_UNAVAILABLE")) return unavailable(reserved.reason, 403);
      if (reserved?.kind !== "RESERVED" || typeof reserved.token !== "object" || reserved.token === null) return unavailable("SPEND_LEDGER_UNAVAILABLE", 403);
      reservation = reserved.token;
    } catch {
      return unavailable("SPEND_LEDGER_UNAVAILABLE", 403);
    }

    // 6. Credential (read only now), rate limit, one bounded call.
    let outcome: CallOutcome;
    let transmitted = false;
    const token = readDeepSeekToken(options.environment);
    const at = now().getTime();
    while (admitted.length > 0 && admitted[0]! <= at - limit.windowMs) admitted.shift();
    if (token.kind === "MISSING_CONFIGURATION") outcome = { body: { kind: "UNAVAILABLE", reason: "NOT_CONFIGURED" }, usage: null };
    else if (admitted.length >= limit.maxRequests) outcome = { body: { kind: "UNAVAILABLE", reason: "RATE_LIMITED" }, usage: null };
    else if (request.signal.aborted) outcome = { body: { kind: "UNAVAILABLE", reason: "CANCELLED" }, usage: null };
    else {
      admitted.push(at);
      transmitted = true;
      outcome = await callOnce(chat, token.token, model, request.signal, upperBound);
    }
    // Settlement: never transmitted (or failed before sending) releases all; a transmitted call commits its reported cost, else the
    // full upper bound (never zero).
    try {
      const usage = outcome.usage;
      if (!transmitted || !usage) await ledger.release(reservation);
      else if (usage.basis !== "UPPER_BOUND" && usage.costMicroUsd !== null) await ledger.commit(reservation, usage.costMicroUsd, "REPORTED");
      else await ledger.commit(reservation, upperBound.costMicroUsd, "UPPER_BOUND");
    } catch {
      // The reservation stays held: it only over-counts.
    }
    return feelingsChatRouteResponseSchema.safeParse(outcome.body).success ? reply(outcome.body) : unavailable("UPSTREAM_ERROR");
  };

  async function callOnce(chat: FeelingsChatRequest, token: string, model: KieModelSnapshot, clientSignal: AbortSignal, upperBound: ProviderUsage): Promise<CallOutcome> {
    const controller = new AbortController();
    let stopped: "PROVIDER_TIMEOUT" | "REQUEST_CANCELLED" | null = null;
    const stop = (reason: "PROVIDER_TIMEOUT" | "REQUEST_CANCELLED") => {
      stopped ??= reason;
      controller.abort();
    };
    const onCancel = () => stop("REQUEST_CANCELLED");
    const timer = setTimeout(() => stop("PROVIDER_TIMEOUT"), timeoutMs);
    clientSignal.addEventListener("abort", onCancel);
    const failed = (reason: ProviderFailureReason | "REQUEST_CANCELLED", usage: ProviderUsage | null): CallOutcome => ({ body: { kind: "UNAVAILABLE", reason: unavailableFor(reason) }, usage });
    try {
      const aborted = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null)));
      const result: FeelingsChatProviderResult | null = await Promise.race([
        // A thrown invoke may have transmitted: it counts at the upper bound, never zero.
        invokeFeelingsChat({ request: chat, token, model, signal: controller.signal, fetcher: options.fetcher }).catch((): FeelingsChatProviderResult => ({ kind: "FAILED", reason: "TRANSPORT_FAILED", usage: upperBound })),
        aborted,
      ]);
      if (stopped || result === null) return failed(stopped ?? "TRANSPORT_FAILED", upperBound);
      // A failure the transport reports without usage was decided before sending (nothing billed).
      if (result.kind === "FAILED") return failed(result.reason, result.usage ?? null);
      if (result.retention !== "CONFIRMED_NOT_STORED") return failed("PROVIDER_FAILED", result.usage);
      const validation = validateFeelingsChatReply(result.candidate, chat);
      const body: FeelingsChatRouteResponse = validation.ok
        ? { kind: "OK", reply: { ...validation.value, themes: [...validation.value.themes] } }
        : { kind: "REJECTED", reasons: [...validation.reasons] };
      return { body, usage: result.usage };
    } catch {
      return failed("PROVIDER_FAILED", upperBound);
    } finally {
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onCancel);
    }
  }
}
