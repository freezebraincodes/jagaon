import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import type { ProviderUsage } from "@/application/ai/ai-provider-port";
import {
  SHIPPED_TRANSCRIPT_EXTRACTION_GATE,
  transcriptExtractionActivation,
  type TranscriptExtractionGate,
} from "@/application/transcript-extraction/transcript-extraction-qualification";
import { transcriptRedirect } from "@/application/transcript-extraction/transcript-extraction-redirect";
import { gateRemoteTranscriptExtraction } from "@/domain/voice/voice-remote-extraction-gate";
import {
  TRANSCRIPT_EXTRACTION_MAX_BODY_BYTES,
  transcriptExtractionResponseSchema,
  type TranscriptExtractionFailureReason,
  type TranscriptExtractionRefusalReason,
  type TranscriptExtractionResponse,
} from "@/application/transcript-extraction/transcript-extraction-route-contract";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { extractionRequestSchema, type ExtractionRequest } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { validateExtraction } from "@/domain/transcript-extraction/transcript-extraction-validator";
import { readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import { readLimitedUtf8 } from "@/ai/kie/kie-responses-provider";
import { invokeTranscriptExtraction, type ExtractionProviderResult } from "@/ai/transcript-extraction/transcript-extraction-provider";
import {
  buildTranscriptExtractionBody,
  transcriptExtractionCallUpperBound,
  transcriptExtractionContractDigest,
  transcriptExtractionModel,
} from "@/ai/transcript-extraction/transcript-extraction-request";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";
import { AI_SHELL_DEPLOYMENT_ENV, accessGranted, originAllowed, parseAiShellDeploymentConfig, type AiShellDeploymentConfig } from "../shell/ai-shell-deployment-config";
import { InMemoryDailySpendLedger, type SpendLedger, type SpendReservationToken } from "../shell/ai-spend-ledger";

/**
 * Packet 13 (P13X): POST /api/ai/transcript, the bounded DeepSeek transcript extraction (EXTRACT_VOICE_FACTS). Server-only.
 *
 * Order (every step before the credential read; same order and refusal shape as /api/ai/shell):
 *   1. method, content type, body cap, strict JSON, `extractionRequestSchema` (strict: only transcript, locale, allowed kinds);
 *   2. the voice slice's frozen gate `gateRemoteTranscriptExtraction` plus this task's redirect check over the WHOLE transcript
 *      (REDIRECT_REQUIRED: a dose, treatment or health question never reaches the model; another withheld transcript is invalid);
 *   3. the shared remote-AI switch `JAGAON_REMOTE_AI` AND this task's own switch `JAGAON_AI_TRANSCRIPT_EXTRACTION` (both exactly `on`);
 *   4. origin protection and 5. the demo passcode (the shared C6 deployment configuration, read-only reuse);
 *   6. server activation of EXTRACT_VOICE_FACTS (NOT_REGISTERED / DETERMINISTIC_ONLY refuse: the shipped state);
 *   7. this task's own qualification gate over the extraction contract digest (shipped PENDING: refuses);
 *   8. the spend reservation of this exact body's upper bound against THIS route's own per-instance daily ledger, whose limit is this
 *      task's own `JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD` (owner #5; same format as the shell's `JAGAON_AI_DAILY_SPEND_LIMIT_USD`: a
 *      positive USD decimal with at most 6 decimals; missing or malformed refuses SPEND_NOT_CONFIGURED);
 *   9. the credential read, the rate limit, ONE bounded call (no retry, no repair), the settlement, then the r-rules over the output.
 * Refusals are HTTP 403 REFUSED with `notSentToProvider: true`. The transcript lives in memory for this request only: it is never logged,
 * stored, echoed or put in an error, and no response but EXTRACTED carries any transcript text (as validated verbatim spans).
 *
 * Spend (owner #5): the shell's wording route and this extraction route keep TWO SEPARATE counters with two separate limits. They are
 * NOT one shared cap: the most a deployment can spend per day is the sum of both limits. Both counters are best-effort and per server
 * instance (in memory): they reset on a restart or a new instance, and several instances each count on their own. The provider-side
 * account limit remains the only hard cap.
 */
export const TRANSCRIPT_EXTRACTION_ENV = Object.freeze({ switch: "JAGAON_AI_TRANSCRIPT_EXTRACTION", dailySpendLimitUsd: "JAGAON_AI_TRANSCRIPT_DAILY_SPEND_LIMIT_USD" } as const);

/** This route's own daily limit in whole micro-USD, parsed with the shell's exact USD format (read-only reuse); null when missing or malformed. */
export function transcriptExtractionDailySpendLimitMicroUsd(environment: Readonly<Record<string, string | undefined>>): number | null {
  let value: string | undefined;
  try {
    value = environment[TRANSCRIPT_EXTRACTION_ENV.dailySpendLimitUsd];
  } catch {
    return null;
  }
  return parseAiShellDeploymentConfig({ [AI_SHELL_DEPLOYMENT_ENV.dailySpendLimitUsd]: value }).dailySpendLimitMicroUsd;
}
const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 10, windowMs: 60_000 });
export const TRANSCRIPT_EXTRACTION_TIMEOUT_MS = 15_000;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export type TranscriptExtractionHandlerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  /** Test seams only. */
  fetcher?: Fetcher;
  now?: () => Date;
  activationManifest?: AiActivationManifest;
  releaseProfile?: unknown;
  rateLimit?: { maxRequests: number; windowMs: number };
  gate?: TranscriptExtractionGate;
  spendLedger?: SpendLedger;
  timeoutMs?: number;
};

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (body: TranscriptExtractionResponse, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const refused = (reason: TranscriptExtractionRefusalReason) => reply({ kind: "REFUSED", reason, notSentToProvider: true }, 403);
const notSent = (reason: TranscriptExtractionFailureReason, status = 200) => reply({ kind: "FAILED", reason, notSentToProvider: true }, status);

const bounded = (value: number | null | undefined) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null);
const usageOf = (usage: ProviderUsage, basis: "REPORTED" | "UPPER_BOUND") => ({ inputTokens: bounded(usage.inputTokens), outputTokens: bounded(usage.outputTokens), costMicroUsd: bounded(usage.costMicroUsd), basis });

export function createTranscriptExtractionHandler(options: TranscriptExtractionHandlerOptions): (request: Request) => Promise<Response> {
  const manifest = options.activationManifest ?? AI_ACTIVATION_MANIFEST;
  const profile = "releaseProfile" in options ? options.releaseProfile : HACKATHON_STORAGE_PROFILE.profileId;
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const gate = options.gate ?? SHIPPED_TRANSCRIPT_EXTRACTION_GATE;
  const timeoutMs = options.timeoutMs ?? TRANSCRIPT_EXTRACTION_TIMEOUT_MS;
  const admitted: number[] = [];
  let config: AiShellDeploymentConfig | null = null;
  let spendLimit: { microUsd: number | null } | null = null;
  let instanceLedger: SpendLedger | null = null;
  const spendLedger = (dailyLimitMicroUsd: number): SpendLedger => options.spendLedger ?? (instanceLedger ??= new InMemoryDailySpendLedger({ dailyLimitMicroUsd }));

  return async function handle(request: Request): Promise<Response> {
    // 1. Request checks.
    if (request.method !== "POST") return notSent("PAYLOAD_INVALID", 405);
    if (!/^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return notSent("PAYLOAD_INVALID", 415);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > TRANSCRIPT_EXTRACTION_MAX_BODY_BYTES) return notSent("BUDGET_EXCEEDED", 413);
    let text: string | null;
    try {
      text = await readLimitedUtf8(request.body, TRANSCRIPT_EXTRACTION_MAX_BODY_BYTES);
    } catch {
      return request.signal.aborted ? notSent("REQUEST_CANCELLED") : notSent("PAYLOAD_INVALID", 400);
    }
    if (text === null) return notSent("BUDGET_EXCEEDED", 413);
    let extraction: ExtractionRequest;
    try {
      const parsed = extractionRequestSchema.safeParse(toPlainData(parseStrictJson(text, { maxDepth: 4, maxLength: TRANSCRIPT_EXTRACTION_MAX_BODY_BYTES })));
      if (!parsed.success) return notSent("PAYLOAD_INVALID", 400);
      extraction = parsed.data;
    } catch {
      return notSent("PAYLOAD_INVALID", 400);
    }
    const isRedirect = transcriptRedirect(extraction.locale);
    // 2. The voice slice's frozen pre-request gate (whole transcripts only), plus this task's own redirect check: a dose, treatment or
    //    health question never reaches the model; any other withheld transcript is an invalid request.
    const voiceGate = gateRemoteTranscriptExtraction(extraction.transcript, extraction.locale === "zh-SG" ? "zh" : "en");
    if ((voiceGate.kind === "WITHHOLD" && voiceGate.reason === "REDIRECT_CONTENT") || isRedirect(extraction.transcript)) return refused("REDIRECT_REQUIRED");
    if (voiceGate.kind === "WITHHOLD") return notSent("PAYLOAD_INVALID", 400);

    // 3–5. Switches, origin, passcode (shared C6 configuration; this task adds its own switch, which can only restrict).
    const deployment = (config ??= parseAiShellDeploymentConfig(options.environment));
    if (!deployment.remoteAiEnabled) return refused("REMOTE_AI_DISABLED");
    if (options.environment[TRANSCRIPT_EXTRACTION_ENV.switch] !== "on") return refused("EXTRACTION_DISABLED");
    if (!originAllowed(deployment, request.headers)) return refused("ORIGIN_REJECTED");
    if (!accessGranted(deployment, request.headers)) return refused("ACCESS_DENIED");

    // 6. Activation; 7. this task's own qualification.
    if (transcriptExtractionActivation(manifest, profile) !== "SYNTHETIC_REMOTE_ENABLED") return refused("TASK_NOT_ACTIVATED");
    let qualified = false;
    try {
      qualified = gate.admit(transcriptExtractionContractDigest()) === true;
    } catch {
      qualified = false;
    }
    if (!qualified) return refused("EXTRACTION_NOT_QUALIFIED");

    // 8. Spend reservation of this exact body's upper bound against this route's OWN limit and ledger (owner #5; not the shell's).
    const dailyLimitMicroUsd = (spendLimit ??= { microUsd: transcriptExtractionDailySpendLimitMicroUsd(options.environment) }).microUsd;
    if (dailyLimitMicroUsd === null) return refused("SPEND_NOT_CONFIGURED");
    const model = transcriptExtractionModel();
    const built = model ? buildTranscriptExtractionBody(extraction, model) : null;
    if (!model || !built) return notSent("MISSING_CONFIGURATION");
    const upperBound = transcriptExtractionCallUpperBound(new TextEncoder().encode(built.bodyText).byteLength);
    let ledger: SpendLedger;
    let reservation: SpendReservationToken;
    try {
      ledger = spendLedger(dailyLimitMicroUsd);
      const reserved = await ledger.reserve(upperBound.costMicroUsd, now());
      if (reserved?.kind === "REFUSED" && (reserved.reason === "SPEND_CEILING_REACHED" || reserved.reason === "SPEND_LEDGER_UNAVAILABLE")) return refused(reserved.reason);
      if (reserved?.kind !== "RESERVED" || typeof reserved.token !== "object" || reserved.token === null) return refused("SPEND_LEDGER_UNAVAILABLE");
      reservation = reserved.token;
    } catch {
      return refused("SPEND_LEDGER_UNAVAILABLE");
    }

    // 9. Credential (read only now), rate limit, one bounded call.
    let body: TranscriptExtractionResponse;
    let transmitted = false;
    const token = readDeepSeekToken(options.environment);
    const at = now().getTime();
    while (admitted.length > 0 && admitted[0]! <= at - limit.windowMs) admitted.shift();
    if (token.kind === "MISSING_CONFIGURATION") body = { kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true };
    else if (admitted.length >= limit.maxRequests) body = { kind: "FAILED", reason: "PROVIDER_RATE_LIMITED", notSentToProvider: true };
    else if (request.signal.aborted) body = { kind: "FAILED", reason: "REQUEST_CANCELLED", notSentToProvider: true };
    else {
      admitted.push(at);
      transmitted = true;
      body = await callOnce(extraction, token.token, model, request.signal, upperBound, isRedirect);
    }
    // Settlement: never transmitted releases all; a transmitted call commits its reported cost, else the full upper bound (never zero).
    try {
      const usage = body.kind === "FAILED" || body.kind === "EXTRACTED" || body.kind === "REJECTED" ? ("usage" in body ? body.usage : undefined) : undefined;
      if (!transmitted || !usage) await ledger.release(reservation);
      else if (usage.basis === "REPORTED" && usage.costMicroUsd !== null) await ledger.commit(reservation, usage.costMicroUsd, "REPORTED");
      else await ledger.commit(reservation, upperBound.costMicroUsd, "UPPER_BOUND");
    } catch {
      // The reservation stays held: it only over-counts.
    }
    return transcriptExtractionResponseSchema.safeParse(body).success ? reply(body) : reply({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: usageOf(upperBound, "UPPER_BOUND") });
  };

  async function callOnce(extraction: ExtractionRequest, token: string, model: NonNullable<ReturnType<typeof transcriptExtractionModel>>, clientSignal: AbortSignal, upperBound: ProviderUsage, isRedirect: (text: string) => boolean): Promise<TranscriptExtractionResponse> {
    const controller = new AbortController();
    let stopped: "PROVIDER_TIMEOUT" | "REQUEST_CANCELLED" | null = null;
    const stop = (reason: "PROVIDER_TIMEOUT" | "REQUEST_CANCELLED") => {
      stopped ??= reason;
      controller.abort();
    };
    const onCancel = () => stop("REQUEST_CANCELLED");
    const timer = setTimeout(() => stop("PROVIDER_TIMEOUT"), timeoutMs);
    clientSignal.addEventListener("abort", onCancel);
    const afterCall = (reason: TranscriptExtractionFailureReason, usage: ProviderUsage | undefined): TranscriptExtractionResponse => ({
      kind: "FAILED",
      reason,
      usage: usage ? usageOf(usage, usage.basis === "UPPER_BOUND" ? "UPPER_BOUND" : "REPORTED") : usageOf(upperBound, "UPPER_BOUND"),
    });
    try {
      const aborted = new Promise<null>((resolve) => controller.signal.addEventListener("abort", () => resolve(null)));
      const result: ExtractionProviderResult | null = await Promise.race([
        // A thrown invoke may have transmitted: it counts at the upper bound, never zero.
        invokeTranscriptExtraction({ request: extraction, token, model, signal: controller.signal, fetcher: options.fetcher }).catch((): ExtractionProviderResult => ({ kind: "FAILED", reason: "TRANSPORT_FAILED", usage: upperBound })),
        aborted,
      ]);
      if (stopped || result === null) return afterCall(stopped ?? "TRANSPORT_FAILED", undefined);
      // A failure the transport reports without usage was decided before sending (nothing billed).
      if (result.kind === "FAILED") return result.usage ? afterCall(result.reason, result.usage) : { kind: "FAILED", reason: result.reason, notSentToProvider: true };
      if (result.retention !== "CONFIRMED_NOT_STORED") return afterCall("PROVIDER_FAILED", result.usage);
      const usage = usageOf(result.usage, "REPORTED") as { inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null; basis: "REPORTED" };
      const validation = validateExtraction(extraction, result.candidate, { isRedirect });
      return validation.kind === "VALID"
        ? { kind: "EXTRACTED", output: validation.output, retention: "CONFIRMED_NOT_STORED", usage }
        : { kind: "REJECTED", reason: validation.reason, retention: "CONFIRMED_NOT_STORED", usage };
    } catch {
      return afterCall("PROVIDER_FAILED", undefined);
    } finally {
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onCancel);
    }
  }
}
