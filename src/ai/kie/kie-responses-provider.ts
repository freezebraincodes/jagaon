import type { AiProviderPort, AiShellProviderPort, ProviderFailureReason, ProviderInvocationResult, ProviderRetentionResult, ProviderUsage } from "@/application/ai/ai-provider-port";
import { parseStrictJson, toPlainData } from "@/backup/strict-json";
import { providerTaskRequestSchema, shellMaxOutputTokens, SHELL_TEMPERATURE, shellTaskRequestSchema, type AiLocale, type ProviderTaskRequest, type ShellTask } from "@/domain/ai";
import { isApprovedShellTaskRequest } from "@/application/ai/language/shell-projector";
import { promptFor, type Packet11RemoteTask } from "@/ai/prompts/packet-11-prompts";
import { shellPromptFor } from "@/ai/prompts/packet-11-shell-prompts";
import { KIE_ENDPOINT_LAYOUTS, type KieModelSnapshot } from "./kie-model-catalogue";
import { KIE_MAX_RESPONSE_BYTES, kieResponseSchema, normaliseProviderEnvelope, providerOutputJsonSchema, providerOutputSchemaName, singleOutputText } from "./kie-responses-contracts";
import { minimumReasoningEffort } from "./kie-route-config";
import { shellOutputJsonSchema, shellOutputSchemaName } from "./kie-shell-contracts";

/**
 * Native-fetch Kie Responses adapter (Packet 11B Task 2). Server-only.
 *
 * Builds one stateless, tool-free, non-streaming request from a validated
 * detached payload and the immutable prompt/schema assets, and returns the
 * untrusted structured candidate with bounded usage and credits. It performs
 * no acceptance validation: the 11A validator decides. Every failure is a
 * closed reason; no token, provider message or response body is returned or
 * logged.
 *
 * Retention (owner instruction 2026-10-05): every request carries the literal
 * `store: false`, which no configuration or payload can change. A completed
 * response that reports `store: true` is rejected; one that does not report
 * `store: false` is returned marked RETENTION_UNCONFIRMED, which the product
 * route refuses and which fails model qualification.
 *
 * Hybrid shell output caps (Packet 11B.10, request profile ai-shell-request.11b.10, owner instruction 2026-10-06):
 * the slot-shell contract alone adds `max_output_tokens` to the body in both layouts, chosen by the schema-parsed
 * task from SHELL_MAX_OUTPUT_TOKENS (EXPLAIN 512, care 1024); no configuration, payload, profile, model or
 * environment value can change or remove it. A shell response that is incomplete, carries non-null
 * `incomplete_details` or reports output tokens at or above its task's cap is a
 * closed OUTPUT_TRUNCATED failure (never repaired or retried here) whose billed usage is kept as evidence. The
 * legacy full-prose body and diagnostics are unchanged.
 *
 * Hybrid shell sampling (rules r7, request profile ai-shell-request.11b.11, owner instruction 2026-10-06): the slot-shell
 * contract alone also sends `temperature` SHELL_TEMPERATURE (0.2), in both layouts and for both shell providers, placed
 * just before the cap (which stays the last key); like the cap it comes only from the frozen contract and the domain
 * constant, never from configuration, payload, profile, model or environment. The legacy body stays byte-identical.
 */

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Evaluation-only redacted diagnostic (owner instruction 2026-10-05). It names
 * only the processing boundary that ended the call: closed codes, the numeric
 * HTTP status, a closed content-type class, sorted identifier-shaped top-level
 * property names and parser flags. It never carries a property value, provider
 * message, body text, prompt, payload, generated text or credential, and it is
 * delivered only to an explicit `onDiagnostic` observer: the application
 * result and the public route stay the closed ProviderFailureReason.
 */
export const KIE_DIAGNOSTIC_CODES = Object.freeze([
  "COMPLETED",
  "TRANSPORT_FAILED",
  "REQUEST_TIMEOUT",
  "HTTP_4XX",
  "HTTP_5XX",
  "CONTENT_TYPE_EVENT_STREAM",
  "BODY_MISSING",
  "BODY_OVERSIZED",
  "BODY_NOT_UTF8",
  "BODY_NOT_JSON",
  "ERROR_ENVELOPE",
  "STATUS_NOT_COMPLETED",
  "RESPONSE_MODEL_MISSING",
  "RESPONSE_MODEL_MISMATCH",
  "OUTPUT_SHAPE_INVALID",
  "OUTPUT_TEXT_MISSING",
  "USAGE_MISSING_OR_INVALID",
  "CREDITS_INVALID",
  "UNKNOWN_PROVIDER_ENVELOPE",
  "RESPONSE_STORED",
  // Packet 11B.9, slot-shell contract only: the response was cut at (or ran past) the fixed output cap.
  "OUTPUT_TRUNCATED",
] as const);
export type KieDiagnosticCode = (typeof KIE_DIAGNOSTIC_CODES)[number];
export type KieContentTypeClass = "JSON" | "EVENT_STREAM" | "TEXT" | "OTHER" | "MISSING";
export type KieParserStage = "TRANSPORT" | "HTTP_STATUS" | "BODY_READ" | "JSON_PARSE" | "ERROR_ENVELOPE" | "RESPONSE_SCHEMA" | "STATUS" | "MODEL" | "OUTPUT" | "RETENTION" | "COMPLETE";

export const KIE_RETENTION_RESULTS = Object.freeze(["CONFIRMED_NOT_STORED", "PROVIDER_REPORTED_STORED", "RETENTION_UNCONFIRMED"] as const satisfies readonly ProviderRetentionResult[]);
export type KieRetentionResult = (typeof KIE_RETENTION_RESULTS)[number];

/** Only the JSON booleans count; an absent, null, string or any other value is unconfirmed. */
export function classifyKieRetention(store: unknown): KieRetentionResult {
  if (store === false) return "CONFIRMED_NOT_STORED";
  if (store === true) return "PROVIDER_REPORTED_STORED";
  return "RETENTION_UNCONFIRMED";
}

export const KIE_MODEL_IDENTITY_COMPARISONS = Object.freeze(["IDENTICAL", "NAMESPACE_PREFIXED", "VERSION_SUFFIXED", "NAMESPACE_PREFIXED_AND_VERSIONED", "OTHER_SAFE_IDENTIFIER", "MISSING", "INVALID_IDENTIFIER"] as const);
export type KieModelIdentityComparison = (typeof KIE_MODEL_IDENTITY_COMPARISONS)[number];

export type KieProviderDiagnostic = Readonly<{
  code: KieDiagnosticCode;
  httpStatus: number | null;
  contentTypeClass: KieContentTypeClass | null;
  topLevelKeys: readonly string[] | null;
  bodyValidJson: boolean | null;
  documentedSchemaParsed: boolean | null;
  parserStage: KieParserStage;
  /**
   * Recorded only for a successful, valid-JSON, schema-parsed, completed response. `returned` is the
   * exact identifier only when it passes the safe-identifier rule; otherwise null. Evidence only:
   * acceptance still requires exact identity.
   */
  modelIdentity: Readonly<{ requested: string; expected: string; returned: string | null; comparison: KieModelIdentityComparison }> | null;
  /** Whether the output list would have yielded exactly one output text (null before that stage). */
  envelopeOtherwiseValid: boolean | null;
  /** Numeric usage kept when a completed, billed response was rejected for model mismatch or reported storage. */
  mismatchUsage: Readonly<{ inputTokens: number; outputTokens: number; reasoningTokens: number | null; credits: number | null }> | null;
  /** Provider-reported numbers for any schema-parsed response (evaluation evidence only). */
  reportedUsage: Readonly<{ inputTokens: number; outputTokens: number; reasoningTokens: number | null; credits: number | null }> | null;
  /** Closed retention result for any schema-parsed response (null before that stage); never the raw value. */
  retention: KieRetentionResult | null;
}>;

// The audit row's closed model-snapshot shape, plus explicit exclusions for URLs and key-like material.
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,95}$/i;
const CREDENTIAL_PREFIX = /^(sk|pk|rk|bearer|token|secret|key|apikey|api[-_]key)[-_:]/i;

/** The exact returned identifier when it is safe non-secret metadata; otherwise null. */
function safeModelIdentifier(value: string): string | null {
  if (!SAFE_MODEL_ID.test(value) || value.includes("://") || CREDENTIAL_PREFIX.test(value) || /[A-Za-z0-9]{24,}/.test(value)) return null;
  return value;
}

const VERSION_SUFFIX = /^[-.:][a-z0-9._-]*\d[a-z0-9._-]*$/i;
/** Closed structural comparison against the expected snapshot; evidence only, never acceptance. */
export function classifyModelIdentity(requested: string, returned: unknown): { returned: string | null; comparison: KieModelIdentityComparison } {
  if (returned === undefined || returned === null) return { returned: null, comparison: "MISSING" };
  const safe = typeof returned === "string" ? safeModelIdentifier(returned) : null;
  if (safe === null) return { returned: null, comparison: "INVALID_IDENTIFIER" };
  if (safe === requested) return { returned: safe, comparison: "IDENTICAL" };
  const versioned = (value: string) => value.startsWith(requested) && VERSION_SUFFIX.test(value.slice(requested.length));
  const slash = safe.lastIndexOf("/");
  const namespace = slash > 0 ? safe.slice(0, slash) : null;
  const rest = slash > 0 ? safe.slice(slash + 1) : safe;
  if (namespace !== null && /^[a-z0-9._-]+$/i.test(namespace)) {
    if (rest === requested) return { returned: safe, comparison: "NAMESPACE_PREFIXED" };
    if (versioned(rest)) return { returned: safe, comparison: "NAMESPACE_PREFIXED_AND_VERSIONED" };
  }
  if (namespace === null && versioned(safe)) return { returned: safe, comparison: "VERSION_SUFFIXED" };
  return { returned: safe, comparison: "OTHER_SAFE_IDENTIFIER" };
}

const failed = (reason: ProviderFailureReason): ProviderInvocationResult => ({ kind: "FAILED", reason });

function statusReason(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return "MISSING_CONFIGURATION";
  if (status === 402) return "OPERATIONAL_SPEND_LOCKED";
  if (status === 408 || status === 504) return "PROVIDER_TIMEOUT";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status >= 500) return "PROVIDER_FAILED";
  return "PROVIDER_REJECTED";
}

function contentTypeClass(header: string | null): KieContentTypeClass {
  if (!header) return "MISSING";
  const type = header.split(";")[0]!.trim().toLowerCase();
  if (type === "text/event-stream") return "EVENT_STREAM";
  if (type === "application/json" || type.endsWith("+json")) return "JSON";
  if (type === "text/plain") return "TEXT";
  return "OTHER";
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Sorted top-level names only; anything not identifier-shaped could carry a value and is masked. */
function keysOf(value: unknown): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return [...new Set(Object.keys(value).slice(0, 64).map((key) => (IDENTIFIER.test(key) ? key : "<non-identifier>")))].sort();
}

type BodyRead = { kind: "OK"; text: string } | { kind: "MISSING" | "OVERSIZED" | "NOT_UTF8" };

/** Reads at most `limit` bytes; a larger or non-UTF-8 body is refused without buffering the rest. */
async function readBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<BodyRead> {
  if (!body) return { kind: "MISSING" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { kind: "OVERSIZED" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { kind: "OK", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "NOT_UTF8" };
  }
}

export async function readLimitedUtf8(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  const read = await readBody(body, limit);
  return read.kind === "OK" ? read.text : null;
}

/** A provider-level error delivered with HTTP 200 (`{ error }` or `{ code, msg }`). */
function bodyErrorReason(body: Record<string, unknown>): ProviderFailureReason | null {
  if (body.error !== undefined && body.error !== null) return "PROVIDER_FAILED";
  if (typeof body.code === "number" && body.code !== 200) return body.code === 402 ? "OPERATIONAL_SPEND_LOCKED" : body.code === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_FAILED";
  return null;
}

/** Which documented field broke the response schema, checked in a fixed order. */
function schemaFailureCode(body: Record<string, unknown>): KieDiagnosticCode {
  if (!("output" in body) && !("status" in body) && !("usage" in body)) return "UNKNOWN_PROVIDER_ENVELOPE";
  if (typeof body.status !== "string") return "STATUS_NOT_COMPLETED";
  if (!Array.isArray(body.output) || !kieResponseSchema.shape.output.safeParse(body.output).success) return "OUTPUT_SHAPE_INVALID";
  if (!kieResponseSchema.shape.usage.safeParse(body.usage).success) return "USAGE_MISSING_OR_INVALID";
  if (!kieResponseSchema.shape.credits_consumed.safeParse(body.credits_consumed).success) return "CREDITS_INVALID";
  if (!kieResponseSchema.shape.model.safeParse(body.model).success) return "RESPONSE_MODEL_MISMATCH";
  return "UNKNOWN_PROVIDER_ENVELOPE";
}

/** Distinguishes a missing output text from a malformed output list. */
function outputFailureCode(output: ReadonlyArray<{ type: string }>): KieDiagnosticCode {
  if (output.some((item) => item.type !== "message" && item.type !== "reasoning")) return "OUTPUT_SHAPE_INVALID";
  const messages = output.filter((item) => item.type === "message");
  if (messages.length === 0) return "OUTPUT_TEXT_MISSING";
  if (messages.length > 1) return "OUTPUT_SHAPE_INVALID";
  const content = (messages[0] as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length > 1) return "OUTPUT_SHAPE_INVALID";
  return "OUTPUT_TEXT_MISSING";
}

function candidateFrom(text: string): unknown {
  try {
    return normaliseProviderEnvelope(toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: 65_536 })));
  } catch {
    // Malformed or duplicate-key JSON goes to the validator unparsed and is rejected there.
    return text;
  }
}

export type ResponsesProviderConfig = {
  token: string;
  model: KieModelSnapshot;
  endpoint?: string;
  fetcher?: Fetcher;
  maxResponseBytes?: number;
  /** Evaluation-only observer for the redacted diagnostic; the route never supplies one. */
  onDiagnostic?: (diagnostic: KieProviderDiagnostic) => void;
};

/**
 * What differs between Responses-API providers that share this one request builder and parser: the provider key
 * recorded in the audit, the only endpoints its credential may reach (each with its documented request layout),
 * and how spend is measured. Request mapping, retention, identity and output rules are identical for every
 * profile and cannot be changed by one.
 */
export type ResponsesProviderProfile = Readonly<{
  providerKey: string;
  endpointLayouts: Readonly<Record<string, "INSTRUCTIONS_FIELD" | "SEPARATE_USER_MESSAGES">>;
  spend: (usage: Readonly<{ inputTokens: number; outputTokens: number }>, reportedCredits: number | undefined) => Readonly<{ credits: number | null; costMicroUsd: number | null }>;
  /**
   * Packet 11C Addendum C (C5): the pre-send upper bound of one slot-shell call with this exact body (USD-priced providers only; absent
   * for a provider whose spend cannot be bounded before the call, e.g. Kie credits). Used when a transmitted call's usage is unreadable.
   */
  upperBound?: (bodyByteCount: number, task: ShellTask) => Readonly<{ inputTokens: number; outputTokens: number; costMicroUsd: number | null }>;
}>;

/** Kie: the provider's own `credits_consumed`, which is not USD and never fills `costMicroUsd`. */
export const KIE_RESPONSES_PROFILE: ResponsesProviderProfile = Object.freeze({
  providerKey: "kie",
  endpointLayouts: KIE_ENDPOINT_LAYOUTS,
  spend: (_usage, reportedCredits) => ({ credits: reportedCredits ?? null, costMicroUsd: null }),
});

export function createKieResponsesProvider(config: ResponsesProviderConfig): AiProviderPort {
  return createResponsesProvider(KIE_RESPONSES_PROFILE, config);
}

type ResponsesRequestContract = Readonly<{
  /**
   * The fixed `max_output_tokens` this contract sends for the schema-parsed task, or null to send none (legacy).
   * Never configurable: it is a function of the validated task only.
   */
  outputCap(task: Packet11RemoteTask): number | null;
  /** Rules r7: the fixed sampling `temperature` this contract sends, or null to send none (legacy). Never configurable. */
  temperature(): number | null;
  prompt(input: unknown): { text: string } | null;
  parse(input: unknown): { task: Packet11RemoteTask; locale: AiLocale; json: string } | null;
  schemaName(task: Packet11RemoteTask, locale: AiLocale): string;
  schema(task: Packet11RemoteTask, locale: AiLocale): Record<string, unknown>;
  candidate(text: string): unknown;
}>;
const fieldsOf = (input: unknown) => (typeof input === "object" && input !== null ? (input as { taskType?: unknown; locale?: unknown }) : {});

/** The legacy full-prose contract (prompt 11b.11, kie-schema.11b.3): behaviour unchanged. */
const FULL_PROSE_CONTRACT: ResponsesRequestContract = Object.freeze({
  outputCap: () => null,
  temperature: () => null,
  prompt: (input: unknown) => promptFor(String(fieldsOf(input).taskType), fieldsOf(input).locale as AiLocale),
  parse: (input: unknown) => {
    const parsed = providerTaskRequestSchema.safeParse(input);
    if (!parsed.success) return null;
    const request = parsed.data as ProviderTaskRequest;
    return { task: request.taskType as Packet11RemoteTask, locale: request.locale, json: JSON.stringify(request) };
  },
  schemaName: providerOutputSchemaName,
  schema: providerOutputJsonSchema,
  candidate: candidateFrom,
});

/**
 * The hybrid slot-shell contract (introduced with prompt 11b.13 and kie-schema.11b.5; frozen in Packet 11C B5 at prompt 11b.18,
 * kie-schema.11c.1 and request profile ai-shell-request.11b.11, pinned in packet-11c-contract-freeze.test.ts): value-blind
 * input only; no envelope normalisation; the fixed per-task output cap (EXPLAIN 512, care 1024) and, since rules r7, the
 * fixed sampling temperature SHELL_TEMPERATURE (0.2).
 */
const SLOT_SHELL_CONTRACT: ResponsesRequestContract = Object.freeze({
  outputCap: (task) => shellMaxOutputTokens(task),
  temperature: () => SHELL_TEMPERATURE,
  // Prompt and body are both derived from the one schema-parsed clone, never from the caller's live object.
  prompt: (input: unknown) => {
    const parsed = shellTaskRequestSchema.safeParse(input);
    const fields = parsed.success ? parsed.data : fieldsOf(input);
    return shellPromptFor(String(fields.taskType), fields.locale as AiLocale);
  },
  parse: (input: unknown) => {
    const parsed = shellTaskRequestSchema.safeParse(input);
    return parsed.success && isApprovedShellTaskRequest(parsed.data) ? { task: parsed.data.taskType, locale: parsed.data.locale, json: JSON.stringify(parsed.data) } : null;
  },
  schemaName: shellOutputSchemaName,
  schema: shellOutputJsonSchema,
  candidate: (text: string) => {
    try {
      return toPlainData(parseStrictJson(text, { maxDepth: 16, maxLength: 65_536 }));
    } catch {
      return text;
    }
  },
});

function createResponsesInvoker(profile: ResponsesProviderProfile, config: ResponsesProviderConfig, contract: ResponsesRequestContract): (input: unknown, signal: AbortSignal) => Promise<ProviderInvocationResult> {
  const endpoint = config.endpoint ?? config.model.endpoint;
  // Only an endpoint allowlisted for this provider ever receives a request or the credential, in its documented layout.
  const layout = Object.hasOwn(profile.endpointLayouts, endpoint) ? profile.endpointLayouts[endpoint]! : null;
  const fetcher = config.fetcher ?? fetch;
  const limit = config.maxResponseBytes ?? KIE_MAX_RESPONSE_BYTES;
  const effort = minimumReasoningEffort(config.model);

  async function invoke(input: unknown, signal: AbortSignal): Promise<ProviderInvocationResult> {
    const prompt = contract.prompt(input);
    if (!prompt || effort === null || layout === null) return failed("MISSING_CONFIGURATION");
    const parsed = contract.parse(input);
    if (!parsed) return failed("PROVIDER_REJECTED");

    // The synthetic JSON is always its own message; the static prompt is never concatenated with it.
    const data = { role: "user", content: [{ type: "input_text", text: parsed.json }] };
    const textFormat = { format: { type: "json_schema", name: contract.schemaName(parsed.task, parsed.locale), schema: contract.schema(parsed.task, parsed.locale), strict: true } };
    const base =
      layout === "INSTRUCTIONS_FIELD"
        ? { model: config.model.requestModelId, stream: false, store: false, instructions: prompt.text, input: [data], reasoning: { effort }, text: textFormat }
        : { model: config.model.requestModelId, stream: false, store: false, input: [{ role: "user", content: [{ type: "input_text", text: prompt.text }] }, data], reasoning: { effort }, text: textFormat };
    // The cap comes only from the frozen contract and the schema-parsed task, and the temperature (rules r7) only from the
    // frozen contract: the legacy body is byte-unchanged; the shell body ends with the temperature and its task's cap.
    const cap = contract.outputCap(parsed.task);
    const temperature = contract.temperature();
    const sampled = temperature === null ? base : { ...base, temperature };
    const body = cap === null ? sampled : { ...sampled, max_output_tokens: cap };
    const bodyText = JSON.stringify(body);

    // Packet 11C Addendum C (C5), slot-shell contract only (the legacy full-prose results are unchanged): every failure after
    // transmission may have been billed, so it carries usage. Once the response's usage was parsed, that reported usage; before that,
    // the call's pre-send upper bound for this exact body (a USD-priced profile only), never zero. Result handling only: the body above
    // is built and sent exactly as before.
    const upperBound: ProviderUsage | null = cap !== null && profile.upperBound ? { ...profile.upperBound(new TextEncoder().encode(bodyText).byteLength, parsed.task as ShellTask), credits: null, basis: "UPPER_BOUND" } : null;
    let reported: ProviderUsage | null = null;
    const failedAfterSend = (reason: ProviderFailureReason): ProviderInvocationResult => {
      const usage = cap === null ? null : (reported ?? upperBound);
      return usage ? { kind: "FAILED", reason, usage } : failed(reason);
    };

    // Every exit after transmission reports exactly one redacted diagnostic.
    let diagnostic: KieProviderDiagnostic = {
      code: "TRANSPORT_FAILED",
      httpStatus: null,
      contentTypeClass: null,
      topLevelKeys: null,
      bodyValidJson: null,
      documentedSchemaParsed: null,
      parserStage: "TRANSPORT",
      modelIdentity: null,
      envelopeOtherwiseValid: null,
      mismatchUsage: null,
      reportedUsage: null,
      retention: null,
    };
    const end = (result: ProviderInvocationResult, patch: Partial<KieProviderDiagnostic>): ProviderInvocationResult => {
      diagnostic = { ...diagnostic, ...patch };
      config.onDiagnostic?.(Object.freeze(diagnostic));
      return result;
    };

    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        cache: "no-store",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", accept: "application/json" },
        body: bodyText,
        signal,
      });
    } catch {
      return end(failedAfterSend("TRANSPORT_FAILED"), { code: signal.aborted ? "REQUEST_TIMEOUT" : "TRANSPORT_FAILED" });
    }
    const typeClass = contentTypeClass(response.headers.get("content-type"));
    diagnostic = { ...diagnostic, httpStatus: response.status, contentTypeClass: typeClass };

    let read: BodyRead;
    try {
      read = await readBody(response.body, limit);
    } catch {
      return end(failedAfterSend(response.ok ? "TRANSPORT_FAILED" : statusReason(response.status)), { code: signal.aborted ? "REQUEST_TIMEOUT" : "TRANSPORT_FAILED", parserStage: "BODY_READ" });
    }
    let json: unknown;
    let validJson: boolean | null = null;
    if (read.kind === "OK") {
      try {
        json = JSON.parse(read.text);
        validJson = true;
      } catch {
        validJson = false;
      }
    }
    diagnostic = { ...diagnostic, bodyValidJson: validJson, topLevelKeys: validJson ? keysOf(json) : null };

    if (!response.ok) return end(failedAfterSend(statusReason(response.status)), { code: response.status >= 500 ? "HTTP_5XX" : "HTTP_4XX", parserStage: "HTTP_STATUS" });
    if (read.kind !== "OK") return end(failedAfterSend("PROVIDER_FAILED"), { code: read.kind === "MISSING" ? "BODY_MISSING" : read.kind === "OVERSIZED" ? "BODY_OVERSIZED" : "BODY_NOT_UTF8", parserStage: "BODY_READ" });
    if (!validJson) return end(failedAfterSend("PROVIDER_FAILED"), { code: typeClass === "EVENT_STREAM" ? "CONTENT_TYPE_EVENT_STREAM" : "BODY_NOT_JSON", parserStage: "JSON_PARSE" });
    if (json === null || typeof json !== "object" || Array.isArray(json)) return end(failedAfterSend("PROVIDER_FAILED"), { code: "UNKNOWN_PROVIDER_ENVELOPE", documentedSchemaParsed: false, parserStage: "RESPONSE_SCHEMA" });
    const bodyError = bodyErrorReason(json as Record<string, unknown>);
    if (bodyError) return end(failedAfterSend(bodyError), { code: "ERROR_ENVELOPE", documentedSchemaParsed: false, parserStage: "ERROR_ENVELOPE" });

    const result = kieResponseSchema.safeParse(json);
    if (!result.success) return end(failedAfterSend("PROVIDER_FAILED"), { code: schemaFailureCode(json as Record<string, unknown>), documentedSchemaParsed: false, parserStage: "RESPONSE_SCHEMA" });
    const reasoning = (result.data.usage as { output_tokens_details?: { reasoning_tokens?: unknown } }).output_tokens_details?.reasoning_tokens;
    const spent = profile.spend({ inputTokens: result.data.usage.input_tokens, outputTokens: result.data.usage.output_tokens }, result.data.credits_consumed);
    const reportedUsage = {
      inputTokens: result.data.usage.input_tokens,
      outputTokens: result.data.usage.output_tokens,
      reasoningTokens: typeof reasoning === "number" && Number.isInteger(reasoning) && reasoning >= 0 && reasoning <= 10_000_000 ? reasoning : null,
      credits: spent.credits,
    };
    const retention = classifyKieRetention((json as Record<string, unknown>).store);
    diagnostic = { ...diagnostic, documentedSchemaParsed: true, reportedUsage, retention };
    // C5: from here on every failure carries this call's reported (schema-bounded) usage, as a completed result would.
    reported = { inputTokens: result.data.usage.input_tokens, outputTokens: result.data.usage.output_tokens, costMicroUsd: spent.costMicroUsd, credits: spent.credits, basis: "REPORTED" };
    // Shell contract only: a truncated response (incomplete, non-null incomplete_details, or output tokens at the
    // request task's cap or past it) is a billed shell failure; a stored one is still reported as stored.
    if (cap !== null) {
      const envelope = json as Record<string, unknown>;
      const incompleteDetails = Object.hasOwn(envelope, "incomplete_details") && envelope.incomplete_details !== null;
      if (result.data.status === "incomplete" || incompleteDetails || result.data.usage.output_tokens >= cap) {
        // Evidence only (outcome unchanged): the returned model identity, as a completed response would record it.
        const expectedSnapshot = config.model.responseModelSnapshot;
        diagnostic = { ...diagnostic, modelIdentity: { requested: config.model.requestModelId, expected: expectedSnapshot, ...classifyModelIdentity(expectedSnapshot, result.data.model) } };
        if (retention === "PROVIDER_REPORTED_STORED") return end(failedAfterSend("PROVIDER_FAILED"), { code: "RESPONSE_STORED", parserStage: "RETENTION", mismatchUsage: reportedUsage });
        return end(failedAfterSend("PROVIDER_FAILED"), { code: "OUTPUT_TRUNCATED", parserStage: "STATUS", mismatchUsage: reportedUsage });
      }
    }
    if (result.data.status !== "completed") return end(failedAfterSend("PROVIDER_FAILED"), { code: "STATUS_NOT_COMPLETED", parserStage: "STATUS" });
    const text = singleOutputText(result.data.output);
    const expected = config.model.responseModelSnapshot;
    diagnostic = { ...diagnostic, modelIdentity: { requested: config.model.requestModelId, expected, ...classifyModelIdentity(expected, result.data.model) }, envelopeOtherwiseValid: text !== null };
    // A response the provider reports as stored is never used, whatever else it contains.
    if (retention === "PROVIDER_REPORTED_STORED") return end(failedAfterSend("PROVIDER_FAILED"), { code: "RESPONSE_STORED", parserStage: "RETENTION", mismatchUsage: reportedUsage });
    // Exact pinning: only the byte-for-byte expected response snapshot is accepted; a missing,
    // aliased, re-dated, prefixed or otherwise similar identifier is rejected.
    if (result.data.model !== expected) {
      const mismatchUsage = text === null ? null : reportedUsage;
      return end(failedAfterSend("PROVIDER_FAILED"), { code: result.data.model === undefined ? "RESPONSE_MODEL_MISSING" : "RESPONSE_MODEL_MISMATCH", parserStage: "MODEL", mismatchUsage });
    }
    if (text === null) return end(failedAfterSend("PROVIDER_FAILED"), { code: outputFailureCode(result.data.output), parserStage: "OUTPUT" });

    return end(
      {
        kind: "COMPLETED",
        candidate: contract.candidate(text),
        usage: { inputTokens: result.data.usage.input_tokens, outputTokens: result.data.usage.output_tokens, costMicroUsd: spent.costMicroUsd, credits: spent.credits },
        responseModel: result.data.model ?? null,
        retention,
      },
      { code: "COMPLETED", parserStage: "COMPLETE" },
    );
  }

  return invoke;
}

export function createResponsesProvider(profile: ResponsesProviderProfile, config: ResponsesProviderConfig): AiProviderPort {
  return Object.freeze({ providerModel: Object.freeze({ providerKey: profile.providerKey, modelSnapshot: config.model.responseModelSnapshot }), invoke: createResponsesInvoker(profile, config, FULL_PROSE_CONTRACT) });
}

export function createShellResponsesProvider(profile: ResponsesProviderProfile, config: ResponsesProviderConfig): AiShellProviderPort {
  return Object.freeze({ providerModel: Object.freeze({ providerKey: profile.providerKey, modelSnapshot: config.model.responseModelSnapshot }), invoke: createResponsesInvoker(profile, config, SLOT_SHELL_CONTRACT) });
}

export function createKieShellResponsesProvider(config: ResponsesProviderConfig): AiShellProviderPort {
  return createShellResponsesProvider(KIE_RESPONSES_PROFILE, config);
}
