import type { ProviderFailureReason, ProviderUsage } from "@/application/ai/ai-provider-port";
import {
  MEDICINE_INFO_MAX_BODY_BYTES,
  medicineInfoRouteResponseSchema,
  type MedicineInfoRouteResponse,
  type MedicineInfoUnavailableReason,
} from "@/application/medicine-info/medicine-info-route-contract";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { medicineInfoRequestSchema, type MedicineInfoRequest } from "@/domain/medicine-info/medicine-info-contract";
import { validateMedicineInfoReply } from "@/domain/medicine-info/medicine-info-validator";
import { readDeepSeekToken } from "@/ai/deepseek/deepseek-catalogue";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { readLimitedUtf8 } from "@/ai/kie/kie-responses-provider";
import { invokeMedicineInfo, type MedicineInfoProviderResult } from "@/ai/medicine-info/medicine-info-provider";
import { buildMedicineInfoBody, medicineInfoCallUpperBound, medicineInfoModel } from "@/ai/medicine-info/medicine-info-request";
import { AI_SHELL_DEPLOYMENT_ENV, accessGranted, originAllowed, parseAiShellDeploymentConfig, type AiShellDeploymentConfig } from "../shell/ai-shell-deployment-config";
import { InMemoryDailySpendLedger, type SpendLedger, type SpendReservationToken } from "../shell/ai-spend-ledger";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): POST /api/ai/medicine-info, one bounded DeepSeek call per
 * lookup of general information about one medicine name. Server-only. Modelled on POST /api/ai/feelings (same order, vocabulary and
 * settlement).
 *
 * Order (every step before the credential read):
 *   1. method, content type, body cap, strict JSON, `medicineInfoRequestSchema` (strict: only task and medicineName, 1–60 characters
 *      of letters, digits, spaces, hyphens, periods and parentheses; any other field is refused, so directions, readings, names, dates
 *      or IDs cannot be sent);
 *   2. the shared remote-AI switch `JAGAON_REMOTE_AI` AND this task's own switch `JAGAON_AI_MEDICINE_INFO` (both exactly `on`; else
 *      DISABLED);
 *   3. origin protection and 4. the demo passcode (the shared C6 deployment configuration, read-only reuse, with its optional-passcode
 *      rule);
 *   5. the spend reservation of this exact body's upper bound against THIS route's own per-instance daily ledger, whose limit is
 *      `JAGAON_AI_MEDICINE_INFO_DAILY_SPEND_LIMIT_USD` (the shared USD format; missing or malformed is NOT_CONFIGURED);
 *   6. the credential read, the rate limit, ONE bounded call (no retry, no repair), the settlement, then the validator
 *      (medicine-info-validator.1) over the parsed output.
 * The medicine name lives in memory for this request only: it is never logged, stored or put in an error. Only OK carries text (the
 * validated general information); NOT_FOUND, REJECTED and UNAVAILABLE carry closed codes only.
 *
 * Spend: this route keeps its OWN counter and limit, separate from the other routes'. The counters are best-effort and per server
 * instance (in memory); the provider-side account limit remains the only hard cap.
 */
export const MEDICINE_INFO_ENV = Object.freeze({ switch: "JAGAON_AI_MEDICINE_INFO", dailySpendLimitUsd: "JAGAON_AI_MEDICINE_INFO_DAILY_SPEND_LIMIT_USD" } as const);

/** This route's own daily limit in whole micro-USD, parsed with the shared USD format (read-only reuse); null when missing or malformed. */
export function medicineInfoDailySpendLimitMicroUsd(environment: Readonly<Record<string, string | undefined>>): number | null {
  let value: string | undefined;
  try {
    value = environment[MEDICINE_INFO_ENV.dailySpendLimitUsd];
  } catch {
    return null;
  }
  return parseAiShellDeploymentConfig({ [AI_SHELL_DEPLOYMENT_ENV.dailySpendLimitUsd]: value }).dailySpendLimitMicroUsd;
}

/** A person looks up a medicine at a time; ten a minute is far above normal use. */
const DEFAULT_RATE_LIMIT = Object.freeze({ maxRequests: 10, windowMs: 60_000 });
export const MEDICINE_INFO_TIMEOUT_MS = 15_000;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export type MedicineInfoHandlerOptions = {
  environment: Readonly<Record<string, string | undefined>>;
  /** Test seams only. */
  fetcher?: Fetcher;
  now?: () => Date;
  rateLimit?: { maxRequests: number; windowMs: number };
  spendLedger?: SpendLedger;
  timeoutMs?: number;
};

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (body: MedicineInfoRouteResponse, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const unavailable = (reason: MedicineInfoUnavailableReason, status = 200) => reply({ kind: "UNAVAILABLE", reason }, status);

/** The provider's closed failure reasons, in this route's vocabulary. */
function unavailableFor(reason: ProviderFailureReason | "REQUEST_CANCELLED"): MedicineInfoUnavailableReason {
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

type CallOutcome = Readonly<{ body: MedicineInfoRouteResponse; usage: ProviderUsage | null }>;

export function createMedicineInfoHandler(options: MedicineInfoHandlerOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => new Date());
  const limit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  const timeoutMs = options.timeoutMs ?? MEDICINE_INFO_TIMEOUT_MS;
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
    if (Number.isFinite(declared) && declared > MEDICINE_INFO_MAX_BODY_BYTES) return unavailable("BAD_REQUEST", 413);
    let text: string | null;
    try {
      text = await readLimitedUtf8(request.body, MEDICINE_INFO_MAX_BODY_BYTES);
    } catch {
      return request.signal.aborted ? unavailable("CANCELLED") : unavailable("BAD_REQUEST", 400);
    }
    if (text === null) return unavailable("BAD_REQUEST", 413);
    let lookup: MedicineInfoRequest;
    try {
      const parsed = medicineInfoRequestSchema.safeParse(toPlainData(parseStrictJson(text, { maxDepth: 2, maxLength: MEDICINE_INFO_MAX_BODY_BYTES })));
      if (!parsed.success) return unavailable("BAD_REQUEST", 400);
      lookup = parsed.data;
    } catch {
      return unavailable("BAD_REQUEST", 400);
    }

    // 2–4. Switches, origin, passcode (shared C6 configuration; this task adds its own switch, which can only restrict).
    const deployment = (config ??= parseAiShellDeploymentConfig(options.environment));
    if (!deployment.remoteAiEnabled) return unavailable("DISABLED", 403);
    if (options.environment[MEDICINE_INFO_ENV.switch] !== "on") return unavailable("DISABLED", 403);
    if (!originAllowed(deployment, request.headers)) return unavailable("ORIGIN_REJECTED", 403);
    if (!accessGranted(deployment, request.headers)) return unavailable("ACCESS_DENIED", 403);

    // 5. Spend reservation of this exact body's upper bound against this route's OWN limit and ledger.
    const dailyLimitMicroUsd = (spendLimit ??= { microUsd: medicineInfoDailySpendLimitMicroUsd(options.environment) }).microUsd;
    if (dailyLimitMicroUsd === null) return unavailable("NOT_CONFIGURED", 403);
    const model = medicineInfoModel();
    const built = model ? buildMedicineInfoBody(lookup, model) : null;
    if (!model || !built) return unavailable("NOT_CONFIGURED");
    const upperBound = medicineInfoCallUpperBound(new TextEncoder().encode(built.bodyText).byteLength);
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
      outcome = await callOnce(lookup, token.token, model, request.signal, upperBound);
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
    return medicineInfoRouteResponseSchema.safeParse(outcome.body).success ? reply(outcome.body) : unavailable("UPSTREAM_ERROR");
  };

  async function callOnce(lookup: MedicineInfoRequest, token: string, model: KieModelSnapshot, clientSignal: AbortSignal, upperBound: ProviderUsage): Promise<CallOutcome> {
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
      const result: MedicineInfoProviderResult | null = await Promise.race([
        // A thrown invoke may have transmitted: it counts at the upper bound, never zero.
        invokeMedicineInfo({ request: lookup, token, model, signal: controller.signal, fetcher: options.fetcher }).catch((): MedicineInfoProviderResult => ({ kind: "FAILED", reason: "TRANSPORT_FAILED", usage: upperBound })),
        aborted,
      ]);
      if (stopped || result === null) return failed(stopped ?? "TRANSPORT_FAILED", upperBound);
      // A failure the transport reports without usage was decided before sending (nothing billed).
      if (result.kind === "FAILED") return failed(result.reason, result.usage ?? null);
      if (result.retention !== "CONFIRMED_NOT_STORED") return failed("PROVIDER_FAILED", result.usage);
      const validation = validateMedicineInfoReply(result.candidate, lookup);
      const body: MedicineInfoRouteResponse = !validation.ok
        ? { kind: "REJECTED", reasons: [...validation.reasons] }
        : validation.value.kind === "NOT_FOUND"
          ? { kind: "NOT_FOUND" }
          : { kind: "OK", info: { ...validation.value.info } };
      return { body, usage: result.usage };
    } catch {
      return failed("PROVIDER_FAILED", upperBound);
    } finally {
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onCancel);
    }
  }
}
