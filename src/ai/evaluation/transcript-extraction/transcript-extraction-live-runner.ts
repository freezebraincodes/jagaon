import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, DEEPSEEK_RESPONSES_URL, deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import type { KieModelSnapshot } from "@/ai/kie/kie-model-catalogue";
import { invokeTranscriptExtraction, type ExtractionProviderResult } from "@/ai/transcript-extraction/transcript-extraction-provider";
import { TRANSCRIPT_EXTRACTION_PROMPT, TRANSCRIPT_EXTRACTION_PROMPT_VERSION } from "@/ai/transcript-extraction/transcript-extraction-prompt";
import {
  TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS,
  TRANSCRIPT_EXTRACTION_MODEL_ID,
  TRANSCRIPT_EXTRACTION_REQUEST_PROFILE,
  TRANSCRIPT_EXTRACTION_SCHEMA_NAME,
  TRANSCRIPT_EXTRACTION_TEMPERATURE,
  buildTranscriptExtractionBody,
  transcriptExtractionCallUpperBound,
  transcriptExtractionContractDigest,
} from "@/ai/transcript-extraction/transcript-extraction-request";
import { mapToVoiceCandidates } from "@/application/transcript-extraction/transcript-extraction-mapper";
import { transcriptRedirect } from "@/application/transcript-extraction/transcript-extraction-redirect";
import { TRANSCRIPT_EXTRACTION_CONTRACT_VERSION } from "@/domain/transcript-extraction/transcript-extraction-contract";
import { TRANSCRIPT_EXTRACTION_LEXICON_VERSION } from "@/domain/transcript-extraction/transcript-extraction-lexicon";
import { TRANSCRIPT_EXTRACTION_VALIDATOR_VERSION, validateExtraction } from "@/domain/transcript-extraction/transcript-extraction-validator";
import { gateRemoteTranscriptExtraction } from "@/domain/voice/voice-remote-extraction-gate";
import { TRANSCRIPT_EXTRACTION_FIXTURE_SET_VERSION, type ExtractionFixture } from "./transcript-extraction-fixtures";
import { TRANSCRIPT_EXTRACTION_FULL_POLICY, fixtureRequest, scoreFixture, summariseRun, type FixtureScore, type FullRunSummary } from "./transcript-extraction-harness";

/**
 * Packet 13 (P13X): the smallest live runner of the transcript-extraction evaluation (Proposal 3), evaluation-only and never imported
 * by the product. Owner, 2026-10-09: "I authorize preparation and offline verification of the smallest transcript-extraction live
 * runner needed for the existing proposal. This authorizes no live calls." Nothing here calls a provider by itself: the live block in
 * transcript-extraction-live.test.ts is skipped unless RUN_LIVE_TRANSCRIPT_EXTRACTION=1, and every check below refuses before any send.
 *
 * - Contract: the exact labels and the contract digest are compared with a frozen literal before the tracer exists.
 * - Plan: only EXTRACT fixtures that the voice gate PERMITs are sendable (one call each, no retry, no repair); WITHHELD and REDIRECT
 *   fixtures make zero calls, and the tracer refuses any body that is not one of the planned exact bodies.
 * - Preflight: every planned body is rebuilt and checked field by field (model, store/stream off, the exact prompt, the user message is
 *   exactly {locale, allowedFactKinds, transcript}, temperature 0, cap 1,536, strict schema).
 * - Tracer: a hard pre-send reservation per call (committed + this call's upper bound must stay within the ceiling), a call limit equal
 *   to the planned count, no second call for a fixture, the request record written (Authorization redacted, exclusive, 0600, in a 0700
 *   directory under the git-ignored test-results/) before the send, the raw response written with its SHA-256 after it. A refusal is
 *   sticky. Spend settles at the reported usage when readable, else at the call's upper bound (never zero).
 * - Stops: a tracer refusal; a stored, other-model, truncated or multi-output response; an accepted safety violation; three consecutive
 *   provider failures.
 * - Output: closed codes, counts, spend and paths only. Model output appears only on the private review page (accepted outputs as
 *   validated spans and mapped review fields; rejections and failures as closed codes).
 */
export const TRANSCRIPT_EXTRACTION_LIVE_RUNNER_VERSION = "transcript-extraction-live.13.1";
export const TRANSCRIPT_EXTRACTION_LIVE_ENV = Object.freeze({
  run: "RUN_LIVE_TRANSCRIPT_EXTRACTION",
  provider: "TRANSCRIPT_EXTRACTION_PROVIDER",
  model: "TRANSCRIPT_EXTRACTION_MODEL",
  confirmMaxCalls: "TRANSCRIPT_EXTRACTION_CONFIRM_MAX_CALLS",
  rawTrace: "TRANSCRIPT_EXTRACTION_RAW_TRACE",
  maxUsd: "TRANSCRIPT_EXTRACTION_MAX_USD",
} as const);
export const TRANSCRIPT_EXTRACTION_LIVE_TIMEOUT_MS = 15_000;
/** Consecutive provider failures that stop the run. */
export const TRANSCRIPT_EXTRACTION_LIVE_MAX_CONSECUTIVE_FAILURES = 3;
/** Mismatch codes that are a safety violation on an ACCEPTED output (the r-rules should make them impossible); any one stops the run. */
export const TRANSCRIPT_EXTRACTION_SAFETY_MISMATCHES = Object.freeze(["VOICE_NEGATION_LOST", "VOICE_UNCERTAINTY_LOST", "VOICE_GLUCOSE", "VOICE_MEDICATION", "VOICE_UNSUPPORTED_NOT_LISTED", "UNSUPPORTED_NOT_LISTED", "VOICE_SOURCE"]);
const TRACE_ROOT = "test-results/transcript-extraction-live";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every model-facing and acceptance-rule label of this run, read from the code. */
export function transcriptExtractionLiveContract() {
  return {
    contractVersion: TRANSCRIPT_EXTRACTION_CONTRACT_VERSION,
    contractDigest: transcriptExtractionContractDigest(),
    promptVersion: TRANSCRIPT_EXTRACTION_PROMPT_VERSION,
    promptSha256: sha256(TRANSCRIPT_EXTRACTION_PROMPT),
    requestProfile: TRANSCRIPT_EXTRACTION_REQUEST_PROFILE,
    schemaName: TRANSCRIPT_EXTRACTION_SCHEMA_NAME,
    model: TRANSCRIPT_EXTRACTION_MODEL_ID,
    temperature: TRANSCRIPT_EXTRACTION_TEMPERATURE,
    maxOutputTokens: TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS,
    validatorVersion: TRANSCRIPT_EXTRACTION_VALIDATOR_VERSION,
    lexiconVersion: TRANSCRIPT_EXTRACTION_LEXICON_VERSION,
    fixtureSet: TRANSCRIPT_EXTRACTION_FIXTURE_SET_VERSION,
    policy: TRANSCRIPT_EXTRACTION_FULL_POLICY.version,
    runner: TRANSCRIPT_EXTRACTION_LIVE_RUNNER_VERSION,
  };
}
export type TranscriptExtractionLiveContract = ReturnType<typeof transcriptExtractionLiveContract>;

/** Every key whose code value differs from the frozen literal. */
export function liveContractMismatches(required: Readonly<Record<string, unknown>>): string[] {
  const code = transcriptExtractionLiveContract() as Record<string, unknown>;
  const keys = new Set([...Object.keys(code), ...Object.keys(required)]);
  return [...keys].filter((key) => !same(code[key], required[key]));
}

export type LivePlan = Readonly<{
  fixtures: readonly ExtractionFixture[];
  /** EXTRACT fixtures the gate permits, in order: exactly one call each. */
  sent: readonly string[];
  /** Fixtures that must make zero calls (WITHHELD and REDIRECT). */
  notSent: readonly string[];
  bodies: ReadonlyMap<string, string>;
  upperBoundMicroUsd: ReadonlyMap<string, number>;
  maxCalls: number;
  minimumMicroUsd: number;
  maxPerCallMicroUsd: number;
}>;

/** The run plan from the exact bodies (offline; no credential). */
export function liveRunPlan(fixtures: readonly ExtractionFixture[], model: KieModelSnapshot): LivePlan {
  const sent: string[] = [];
  const notSent: string[] = [];
  const bodies = new Map<string, string>();
  const upper = new Map<string, number>();
  for (const fixture of fixtures) {
    if (fixture.expect !== "EXTRACT") {
      notSent.push(fixture.id);
      continue;
    }
    const built = buildTranscriptExtractionBody(fixtureRequest(fixture), model);
    if (!built) throw new Error("PLAN_BODY_NOT_BUILT");
    if (bodies.has(built.bodyText)) throw new Error("PLAN_DUPLICATE_BODY");
    sent.push(fixture.id);
    bodies.set(built.bodyText, fixture.id);
    upper.set(fixture.id, transcriptExtractionCallUpperBound(new TextEncoder().encode(built.bodyText).byteLength).costMicroUsd);
  }
  const amounts = [...upper.values()];
  return Object.freeze({ fixtures, sent, notSent, bodies, upperBoundMicroUsd: upper, maxCalls: sent.length, minimumMicroUsd: amounts.reduce((a, b) => a + b, 0), maxPerCallMicroUsd: Math.max(0, ...amounts) });
}

export type PreflightItem = Readonly<{ fixtureId: string; passed: boolean; violations: readonly string[] }>;

/** Rebuilds and checks every fixture offline: sendable bodies field by field, and that the gate holds back every non-EXTRACT fixture. */
export function livePreflight(plan: LivePlan, model: KieModelSnapshot): PreflightItem[] {
  return plan.fixtures.map((fixture) => {
    const violations: string[] = [];
    const gate = gateRemoteTranscriptExtraction(fixture.transcript, fixture.locale === "zh-SG" ? "zh" : "en");
    if (fixture.expect !== "EXTRACT") {
      if (gate.kind !== "WITHHOLD") violations.push("GATE_WOULD_SEND");
      return { fixtureId: fixture.id, passed: violations.length === 0, violations };
    }
    if (gate.kind !== "PERMIT" || gate.transcript !== fixture.transcript) violations.push("GATE_NOT_PERMIT");
    const built = buildTranscriptExtractionBody(fixtureRequest(fixture), model);
    if (!built) return { fixtureId: fixture.id, passed: false, violations: [...violations, "BODY_NOT_BUILT"] };
    const body = JSON.parse(built.bodyText) as Record<string, unknown>;
    if (plan.bodies.get(built.bodyText) !== fixture.id) violations.push("BODY_NOT_PLANNED");
    if (!same(Object.keys(body), ["model", "stream", "store", "instructions", "input", "reasoning", "text", "temperature", "max_output_tokens"])) violations.push("BODY_KEYS");
    if (body.model !== TRANSCRIPT_EXTRACTION_MODEL_ID || model.endpoint !== DEEPSEEK_RESPONSES_URL) violations.push("MODEL_OR_ENDPOINT");
    if (body.stream !== false || body.store !== false) violations.push("STREAM_OR_STORE");
    if (body.instructions !== TRANSCRIPT_EXTRACTION_PROMPT) violations.push("PROMPT");
    const expectedMessage = JSON.stringify({ locale: fixture.locale, allowedFactKinds: fixture.allowedFactKinds, transcript: fixture.transcript });
    if (!same(body.input, [{ role: "user", content: [{ type: "input_text", text: expectedMessage }] }])) violations.push("USER_MESSAGE");
    if (body.temperature !== TRANSCRIPT_EXTRACTION_TEMPERATURE || body.max_output_tokens !== TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS) violations.push("SAMPLING_OR_CAP");
    const format = (body.text as { format?: Record<string, unknown> } | undefined)?.format;
    if (format?.type !== "json_schema" || format.name !== TRANSCRIPT_EXTRACTION_SCHEMA_NAME || format.strict !== true) violations.push("SCHEMA_FORMAT");
    return { fixtureId: fixture.id, passed: violations.length === 0, violations };
  });
}

/**
 * The live gate (pure; closed codes). Any refusal stops the run before any request. This module never reads the environment or a
 * credential: the caller (the live test) passes the environment values and whether the provider credential is configured.
 */
export function liveGateRefusals(
  environment: Readonly<Record<string, string | undefined>>,
  plan: Pick<LivePlan, "maxCalls" | "minimumMicroUsd">,
  credential: Readonly<{ configured: boolean }>,
): { refusals: string[]; maxUsd: number | null } {
  const E = TRANSCRIPT_EXTRACTION_LIVE_ENV;
  const refusals: string[] = [];
  if (environment[E.provider] !== "deepseek") refusals.push(E.provider);
  if (environment[E.model] !== TRANSCRIPT_EXTRACTION_MODEL_ID) refusals.push(E.model);
  if (environment[E.confirmMaxCalls] !== String(plan.maxCalls)) refusals.push(E.confirmMaxCalls);
  if (environment[E.rawTrace] !== "1") refusals.push(E.rawTrace);
  const raw = environment[E.maxUsd];
  const maxUsd = raw !== undefined && /^\d+(?:\.\d{1,6})?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) refusals.push(E.maxUsd);
  else if (Math.round(maxUsd * 1_000_000) < plan.minimumMicroUsd) refusals.push(`${E.maxUsd}_BELOW_ONE_CALL_EACH_MINIMUM`);
  if (credential.configured !== true) refusals.push("PROVIDER_CREDENTIAL_NOT_CONFIGURED");
  if (Object.keys(environment).some((name) => name.startsWith("NEXT_PUBLIC_") && /KEY|TOKEN|SECRET/i.test(name))) refusals.push("PUBLIC_CREDENTIAL_NAME_PRESENT");
  return { refusals, maxUsd: refusals.length === 0 ? maxUsd : null };
}

// ---- Tracer --------------------------------------------------------------------------------------------------------------------
export type TraceRefusal = "TRACE_ENDPOINT" | "TRACE_UNEXPECTED_BODY" | "TRACE_DUPLICATE_CALL" | "TRACE_CALL_LIMIT" | "TRACE_SPEND_CEILING" | "TRACE_WRITE_FAILED";
export type ResponseClass = "OK" | "HTTP_ERROR" | "NOT_JSON" | "STORED" | "RETENTION_UNCONFIRMED" | "MODEL_MISMATCH" | "TRUNCATED" | "MULTI_OUTPUT" | "TRANSPORT_FAILED";
/** Response classes that stop the run (proposal 3 stop conditions). */
export const HARD_STOP_RESPONSE_CLASSES: readonly ResponseClass[] = Object.freeze(["STORED", "RETENTION_UNCONFIRMED", "MODEL_MISMATCH", "TRUNCATED", "MULTI_OUTPUT"]);
export type TracedCall = Readonly<{
  sequence: number;
  fixtureId: string;
  upperBoundMicroUsd: number;
  billedMicroUsd: number;
  billedFrom: "USAGE" | "UPPER_BOUND";
  latencyMs: number;
  responseClass: ResponseClass;
  httpStatus: number | null;
}>;

function classifyResponse(status: number, text: string): Readonly<{ responseClass: ResponseClass; usageMicroUsd: number | null }> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { responseClass: status === 200 ? "NOT_JSON" : "HTTP_ERROR", usageMicroUsd: null };
  }
  const usage = json?.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  const valid = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const usageMicroUsd = usage && valid(usage.input_tokens) && valid(usage.output_tokens) ? deepSeekCostMicroUsd(usage.input_tokens as number, usage.output_tokens as number) : null;
  if (status !== 200) return { responseClass: "HTTP_ERROR", usageMicroUsd };
  if (json.store === true) return { responseClass: "STORED", usageMicroUsd };
  if (json.store !== false) return { responseClass: "RETENTION_UNCONFIRMED", usageMicroUsd };
  if (json.model !== TRANSCRIPT_EXTRACTION_MODEL_ID) return { responseClass: "MODEL_MISMATCH", usageMicroUsd };
  const incomplete = Object.hasOwn(json, "incomplete_details") && json.incomplete_details !== null;
  const outputTokens = (usage?.output_tokens as number | undefined) ?? 0;
  if (json.status !== "completed" || incomplete || outputTokens >= TRANSCRIPT_EXTRACTION_MAX_OUTPUT_TOKENS) return { responseClass: "TRUNCATED", usageMicroUsd };
  const output = Array.isArray(json.output) ? (json.output as Array<{ type?: unknown; content?: unknown }>) : [];
  const messages = output.filter((item) => item.type === "message");
  if (messages.length !== 1 || !Array.isArray(messages[0]!.content) || (messages[0]!.content as unknown[]).length !== 1) return { responseClass: "MULTI_OUTPUT", usageMicroUsd };
  return { responseClass: "OK", usageMicroUsd };
}

export type ExtractionTracer = Readonly<{
  directory: string;
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  calls: () => readonly TracedCall[];
  files: () => readonly string[];
  failure: () => TraceRefusal | null;
  spend: () => Readonly<{ ceilingMicroUsd: number; committedMicroUsd: number; inFlightMicroUsd: number; billedFromUsage: number; billedFromUpperBound: number; boundExceeded: number }>;
  record: (name: string, value: unknown) => void;
  writePrivate: (name: string, text: string) => string;
}>;

/** Creates the private trace directory (0700) under the git-ignored test-results/ and the tracing fetcher. */
export function createExtractionTracer(options: { plan: LivePlan; ceilingMicroUsd: number; fetcher: (url: string, init: RequestInit) => Promise<Response>; now?: () => string; root?: string }): ExtractionTracer {
  const { plan } = options;
  if (!Number.isSafeInteger(options.ceilingMicroUsd) || options.ceilingMicroUsd <= 0) throw new Error("TRACE_SPEND_CEILING");
  const now = options.now ?? (() => new Date().toISOString());
  mkdirSync(options.root ?? TRACE_ROOT, { recursive: true });
  const directory = join(options.root ?? TRACE_ROOT, `${now().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const files: string[] = [];
  const calls: TracedCall[] = [];
  const sentIds = new Set<string>();
  let failure: TraceRefusal | null = null;
  let committed = 0;
  let inFlight = 0;
  let fromUsage = 0;
  let fromUpper = 0;
  let boundExceeded = 0;
  const writePrivate = (name: string, text: string) => {
    const path = join(directory, name);
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    files.push(path);
    return path;
  };
  const record = (name: string, value: unknown) => void writePrivate(name, `${JSON.stringify(value, null, 2)}\n`);
  const refuse = (code: TraceRefusal): never => {
    failure = code;
    throw new Error(code);
  };

  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    if (failure) throw new Error(failure);
    if (url !== DEEPSEEK_RESPONSES_URL) refuse("TRACE_ENDPOINT");
    const bodyText = String(init.body);
    const fixtureId = plan.bodies.get(bodyText);
    if (fixtureId === undefined) return refuse("TRACE_UNEXPECTED_BODY");
    if (sentIds.has(fixtureId)) refuse("TRACE_DUPLICATE_CALL");
    if (calls.length >= plan.maxCalls) refuse("TRACE_CALL_LIMIT");
    const upper = plan.upperBoundMicroUsd.get(fixtureId)!;
    if (committed + inFlight + upper > options.ceilingMicroUsd) refuse("TRACE_SPEND_CEILING");
    const sequence = calls.length + 1;
    const prefix = `${String(sequence).padStart(3, "0")}-${fixtureId}`;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key, key.toLowerCase() === "authorization" ? "Bearer [REDACTED]" : value]));
    try {
      record(`${prefix}.request.json`, { kind: "REQUEST", sequence, fixtureId, at: now(), url, headers, upperBoundMicroUsd: upper, bodySha256: sha256(bodyText), bodyText });
    } catch {
      refuse("TRACE_WRITE_FAILED");
    }
    sentIds.add(fixtureId);
    inFlight += upper;
    const started = Date.now();
    const settle = (billed: number, from: "USAGE" | "UPPER_BOUND") => {
      inFlight -= upper;
      committed += billed;
      if (from === "USAGE") fromUsage += 1;
      else fromUpper += 1;
    };
    let response: Response;
    try {
      response = await options.fetcher(url, init);
    } catch (error) {
      // Sent, but no response (and so no usage): billed at the upper bound, never zero.
      settle(upper, "UPPER_BOUND");
      calls.push({ sequence, fixtureId, upperBoundMicroUsd: upper, billedMicroUsd: upper, billedFrom: "UPPER_BOUND", latencyMs: Date.now() - started, responseClass: "TRANSPORT_FAILED", httpStatus: null });
      try {
        record(`${prefix}.response.json`, { kind: "RESPONSE", sequence, fixtureId, transportFailure: true, billedMicroUsd: upper, billedFrom: "UPPER_BOUND" });
      } catch {
        failure = "TRACE_WRITE_FAILED";
      }
      throw error;
    }
    let raw: string;
    try {
      raw = await response.text();
    } catch {
      raw = "";
    }
    const latencyMs = Date.now() - started;
    const { responseClass, usageMicroUsd } = classifyResponse(response.status, raw);
    const billed = usageMicroUsd ?? upper;
    if (usageMicroUsd !== null && usageMicroUsd > upper) boundExceeded += 1;
    settle(billed, usageMicroUsd !== null ? "USAGE" : "UPPER_BOUND");
    calls.push({ sequence, fixtureId, upperBoundMicroUsd: upper, billedMicroUsd: billed, billedFrom: usageMicroUsd !== null ? "USAGE" : "UPPER_BOUND", latencyMs, responseClass, httpStatus: response.status });
    try {
      record(`${prefix}.response.json`, { kind: "RESPONSE", sequence, fixtureId, httpStatus: response.status, latencyMs, responseClass, billedMicroUsd: billed, billedFrom: usageMicroUsd !== null ? "USAGE" : "UPPER_BOUND", rawSha256: sha256(raw), raw });
    } catch {
      failure = "TRACE_WRITE_FAILED";
    }
    return new Response(raw, { status: response.status, headers: { "content-type": "application/json" } });
  };

  return Object.freeze({
    directory,
    fetcher,
    calls: () => [...calls],
    files: () => [...files],
    failure: () => failure,
    spend: () => ({ ceilingMicroUsd: options.ceilingMicroUsd, committedMicroUsd: committed, inFlightMicroUsd: inFlight, billedFromUsage: fromUsage, billedFromUpperBound: fromUpper, boundExceeded }),
    record,
    writePrivate,
  });
}

/** No file holds the credential; every request record has a redacted Authorization; files 0600 and the directory 0700. */
export function verifyTraceRedaction(directory: string, files: readonly string[], token: string) {
  let secretAbsent = true;
  let authorizationRedacted = true;
  let filesPrivate = (statSync(directory).mode & 0o777) === 0o700;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (token.length > 0 && text.includes(token)) secretAbsent = false;
    if ((statSync(file).mode & 0o777) !== 0o600) filesPrivate = false;
    if (file.endsWith(".request.json")) {
      const headers = (JSON.parse(text) as { headers?: Record<string, string> }).headers ?? {};
      const auth = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1];
      if (auth !== "Bearer [REDACTED]") authorizationRedacted = false;
    }
  }
  return { filesChecked: files.length, secretAbsent, authorizationRedacted, filesPrivate };
}

/** Every request and response record's stored SHA-256 matches its stored text. */
export function verifyTraceHashes(files: readonly string[]) {
  let requestsVerified = 0;
  let responsesVerified = 0;
  let mismatches = 0;
  for (const file of files) {
    if (!/\.(request|response)\.json$/.test(file)) continue;
    const value = JSON.parse(readFileSync(file, "utf8")) as { kind: string; bodySha256?: string; bodyText?: string; rawSha256?: string; raw?: string; transportFailure?: boolean };
    if (value.kind === "REQUEST") {
      if (value.bodySha256 === sha256(value.bodyText ?? "")) requestsVerified += 1;
      else mismatches += 1;
    } else if (value.kind === "RESPONSE" && !value.transportFailure) {
      if (value.rawSha256 === sha256(value.raw ?? "")) responsesVerified += 1;
      else mismatches += 1;
    }
  }
  return { requestsVerified, responsesVerified, mismatches };
}

// ---- Run -----------------------------------------------------------------------------------------------------------------------
export type LiveStop = TraceRefusal | `RESPONSE_${ResponseClass}` | "ACCEPTED_SAFETY_VIOLATION" | "CONSECUTIVE_PROVIDER_FAILURES";
export type LiveRunResult = Readonly<{
  tracer: ExtractionTracer;
  scores: readonly FixtureScore[];
  summary: Readonly<{
    stoppedReason: LiveStop | null;
    fixturesScored: number;
    draft: FullRunSummary;
    transmissions: number;
    notSentCalls: number;
    callMap: Readonly<{ kind: "MAPPED"; entries: readonly (readonly [number, string])[] }> | Readonly<{ kind: "MISMATCH"; code: string }>;
    spend: ReturnType<ExtractionTracer["spend"]>;
    latency: Readonly<{ p95Ms: number | null; maxMs: number | null; overCeiling: number }>;
    responseClasses: Readonly<Record<string, number>>;
    outcomes: readonly (readonly [string, string, string, readonly string[]])[];
    verdict: Readonly<{ kind: "FAIL"; failures: readonly string[] }>;
    redaction: ReturnType<typeof verifyTraceRedaction>;
    hashes: ReturnType<typeof verifyTraceHashes>;
    trace: Readonly<{ directory: string; files: number; reviewPage: string }>;
  }>;
}>;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Runs every fixture once through the real harness, provider and tracer. The required contract is re-checked before the tracer exists. */
export async function runLiveTranscriptExtraction(options: {
  fixtures: readonly ExtractionFixture[];
  model: KieModelSnapshot;
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  token: string;
  ceilingMicroUsd: number;
  required: Readonly<Record<string, unknown>>;
  now?: () => string;
  timeoutMs?: number;
  onTracer?: (tracer: ExtractionTracer) => void;
}): Promise<LiveRunResult> {
  const mismatches = liveContractMismatches(options.required);
  if (mismatches.length > 0) throw new Error(`CONTRACT_MISMATCH:${mismatches.join(",")}`);
  const plan = liveRunPlan(options.fixtures, options.model);
  if (livePreflight(plan, options.model).some((item) => !item.passed)) throw new Error("PREFLIGHT_FAILED");
  const tracer = createExtractionTracer({ plan, ceilingMicroUsd: options.ceilingMicroUsd, fetcher: options.fetcher, now: options.now });
  options.onTracer?.(tracer);
  const timeoutMs = options.timeoutMs ?? TRANSCRIPT_EXTRACTION_LIVE_TIMEOUT_MS;
  const results = new Map<string, ExtractionProviderResult>();
  const scores: FixtureScore[] = [];
  let stoppedReason: LiveStop | null = null;
  let consecutiveFailures = 0;
  for (const fixture of options.fixtures) {
    const before = tracer.calls().length;
    const score = await scoreFixture(fixture, async (request) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await invokeTranscriptExtraction({ request, token: options.token, model: options.model, signal: controller.signal, fetcher: tracer.fetcher });
        results.set(fixture.id, result);
        return result;
      } finally {
        clearTimeout(timer);
      }
    });
    scores.push(score);
    const call = tracer.calls().length > before ? tracer.calls().at(-1)! : null;
    if (tracer.failure()) stoppedReason = tracer.failure();
    else if (call && HARD_STOP_RESPONSE_CLASSES.includes(call.responseClass)) stoppedReason = `RESPONSE_${call.responseClass}`;
    else if (score.outcome === "ACCEPTED" && score.mismatches.some((m) => TRANSCRIPT_EXTRACTION_SAFETY_MISMATCHES.includes(m))) stoppedReason = "ACCEPTED_SAFETY_VIOLATION";
    else {
      consecutiveFailures = score.outcome === "PROVIDER_FAILED" ? consecutiveFailures + 1 : score.calls > 0 ? 0 : consecutiveFailures;
      if (consecutiveFailures >= TRANSCRIPT_EXTRACTION_LIVE_MAX_CONSECUTIVE_FAILURES) stoppedReason = "CONSECUTIVE_PROVIDER_FAILURES";
    }
    if (stoppedReason) break;
  }

  const calls = tracer.calls();
  const scoredSent = scores.filter((score) => score.calls > 0).map((score) => score.id);
  const callMap =
    calls.length === scoredSent.length && calls.every((call, index) => call.fixtureId === scoredSent[index] && call.sequence === index + 1)
      ? ({ kind: "MAPPED", entries: calls.map((call) => [call.sequence, call.fixtureId] as const) } as const)
      : ({ kind: "MISMATCH", code: calls.length === scoredSent.length ? "FIXTURE_ORDER" : "INVOCATION_COUNT" } as const);
  const notSentCalls = calls.filter((call) => plan.notSent.includes(call.fixtureId)).length;
  const latencies = calls.filter((call) => call.responseClass !== "TRANSPORT_FAILED").map((call) => call.latencyMs).sort((a, b) => a - b);
  const p95 = latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]!;
  const responseClasses: Record<string, number> = {};
  for (const call of calls) responseClasses[call.responseClass] = (responseClasses[call.responseClass] ?? 0) + 1;
  const draft = summariseRun(scores);
  const failures = [
    ...(stoppedReason ? ["NOT_COMPLETED", `STOPPED:${stoppedReason}`] : []),
    ...(scores.length !== options.fixtures.length ? ["FIXTURES_NOT_ALL_SCORED"] : []),
    ...draft.failures,
    ...(callMap.kind !== "MAPPED" ? ["CALL_MAP_MISMATCH"] : []),
    ...(notSentCalls > 0 ? ["WITHHELD_FIXTURE_SENT"] : []),
    ...(p95 !== null && p95 >= TRANSCRIPT_EXTRACTION_FULL_POLICY.thresholds.maxP95LatencyMs ? ["LATENCY_P95"] : []),
    ...(tracer.spend().boundExceeded > 0 ? ["UPPER_BOUND_EXCEEDED"] : []),
    // The draft policy is not approved and every accepted output needs the bilingual human review: the runner can never pass.
    "HUMAN_REVIEW_PENDING",
  ];

  // The private review page: the only place model output appears (accepted outputs only, as validated spans and mapped review fields).
  const rows = options.fixtures.map((fixture) => {
    const score = scores.find((entry) => entry.id === fixture.id);
    const result = results.get(fixture.id);
    let output = "<em>no model output shown</em>";
    if (score?.outcome === "ACCEPTED" && result?.kind === "COMPLETED") {
      const request = fixtureRequest(fixture);
      const validation = validateExtraction(request, result.candidate, { isRedirect: transcriptRedirect(fixture.locale) });
      if (validation.kind === "VALID") {
        const mapped = mapToVoiceCandidates(validation.output, fixture.transcript, fixture.locale);
        const facts = validation.output.facts.map((fact) => `${fact.kind} "${fact.sourceSpan.text}" value=${fact.value ?? "-"} unit=${fact.unit ?? "-"} status=${fact.status ?? "-"} negated=${fact.negated} uncertain=${fact.uncertain} phrase=${fact.unresolvedPhrase ?? "-"}`);
        const unsupported = validation.output.unsupportedSpans.map((span) => `UNSUPPORTED "${span.text}"`);
        const review = mapped.kind === "MAPPED" ? mapped.candidates.map((candidate) => JSON.stringify(candidate)) : [`UNMAPPABLE:${mapped.reason}`];
        output = `<pre>${escapeHtml([...facts, ...unsupported].join("\n"))}</pre><details><summary>mapped review</summary><pre>${escapeHtml(review.join("\n"))}</pre></details>`;
      }
    }
    const golden = fixture.expect === "EXTRACT" ? [...fixture.facts.map((fact) => `${fact.kind} "${fact.text}"`), ...fixture.unsupported.map((text) => `UNSUPPORTED "${text}"`)].join("\n") : fixture.expect;
    const codes = score ? [score.outcome, ...score.mismatches].join(" ") : "NOT_RUN";
    return `<tr data-fixture-id="${escapeHtml(fixture.id)}" data-locale="${fixture.locale}" data-outcome="${escapeHtml(score?.outcome ?? "NOT_RUN")}"><td>${escapeHtml(fixture.id)}</td><td lang="${fixture.locale === "zh-SG" ? "zh" : "en"}">${escapeHtml(fixture.transcript)}</td><td><pre>${escapeHtml(golden)}</pre></td><td>${escapeHtml(codes)}</td><td>${output}</td><td>reviewer: ____ pass / fail</td></tr>`;
  });
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Transcript extraction review (private)</title></head><body><h1>Transcript extraction evaluation: private human review</h1><p>Synthetic transcripts only. Draft policy ${escapeHtml(TRANSCRIPT_EXTRACTION_FULL_POLICY.version)} (not approved). Not qualification, activation or deployment.</p><table><thead><tr><th>Fixture</th><th>Transcript</th><th>Golden</th><th>Codes</th><th>Model output (accepted only)</th><th>Review</th></tr></thead><tbody>${rows.join("")}</tbody></table></body></html>\n`;
  const reviewPage = tracer.writePrivate("review.html", page);

  const outcomes = scores.map((score) => [score.id, score.outcome, score.verdict, score.mismatches] as const);
  tracer.record("99-analysis.json", { kind: "ANALYSIS", contract: transcriptExtractionLiveContract(), stoppedReason, calls, spend: tracer.spend(), traceFailure: tracer.failure(), draft, outcomes, failures, callMap });
  const redaction = verifyTraceRedaction(tracer.directory, tracer.files(), options.token);
  const hashes = verifyTraceHashes(tracer.files());
  return {
    tracer,
    scores,
    summary: {
      stoppedReason,
      fixturesScored: scores.length,
      draft,
      transmissions: calls.length,
      notSentCalls,
      callMap,
      spend: tracer.spend(),
      latency: { p95Ms: p95, maxMs: latencies.at(-1) ?? null, overCeiling: latencies.filter((ms) => ms >= TRANSCRIPT_EXTRACTION_FULL_POLICY.thresholds.maxP95LatencyMs).length },
      responseClasses,
      outcomes,
      verdict: { kind: "FAIL", failures },
      redaction,
      hashes,
      trace: { directory: relative(process.cwd(), tracer.directory), files: tracer.files().length, reviewPage: relative(process.cwd(), reviewPage) },
    },
  };
}

/** The pricing behind every bound (DeepSeek deepseek-flash peak cache-miss USD per 1M tokens, from the catalogue). */
export const TRANSCRIPT_EXTRACTION_LIVE_PRICING = Object.freeze({ ...DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, source: "DeepSeek quick_start/pricing via deepseek-catalogue.ts", retrieved: "2026-10-06" });
