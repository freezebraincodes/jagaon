import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { resolveAiTaskBundle } from "@/application/ai/ai-runtime-bundles";
import { projectProviderTaskPayload } from "@/application/ai/detached-payload-projector";
import { providerTaskRequestSchema, type AiReasonCode } from "@/domain/ai";
import { KIE_MAX_RESPONSE_BYTES } from "@/ai/kie/kie-responses-contracts";
import { promptFor, type Packet11RemoteTask } from "@/ai/prompts/packet-11-prompts";
import { classifyKieRetention, type KieRetentionResult } from "@/ai/kie/kie-responses-provider";
import type { EvaluationCallObservation, EvaluationObserver, FixtureEvidence } from "./packet-11-evaluation";
import { PACKET_11_FIXTURES, type AiEvaluationFixture } from "./packet-11-fixtures";

/**
 * Packet 11B evaluation-only raw request/response trace (owner instruction
 * 2026-10-05). Used only by the explicit live runner with
 * KIE_EVALUATION_RAW_TRACE=1; no production module imports it.
 *
 * It wraps the adapter's injected fetcher. Before transmission it binds the
 * call to a registered synthetic HACKATHON_DEMO fixture, checks that the body
 * carries exactly that fixture's projection, and writes the request with the
 * Authorization value replaced (never read); a body without the literal
 * `store: false` is refused unsent. After the response it captures
 * the raw bytes under the adapter's own size limit and hands the adapter an
 * identical replay, so every adapter, validator and fallback decision is
 * unchanged. Files go only to a fresh private directory under the Git-ignored
 * trace root. Returned strings are stored as JSON data and never printed.
 * Any refusal or write failure aborts the evaluation.
 */

export const PACKET_11_TRACE_FORMAT_VERSION = "packet11-trace.1";
export const PACKET_11_TRACE_ROOT = "test-results/packet-11-live-trace";

export function rawTraceRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.KIE_EVALUATION_RAW_TRACE === "1";
}

export const TRACE_FAILURE_CODES = Object.freeze([
  "TRACE_ROOT_NOT_IGNORED",
  "TRACE_FIXTURE_NOT_REGISTERED",
  "TRACE_FIXTURE_SEQUENCE",
  "TRACE_NO_BOUND_FIXTURE",
  "TRACE_REQUEST_UNSUPPORTED",
  "TRACE_REQUEST_NOT_FIXTURE_PROJECTION",
  "TRACE_REQUEST_RETENTION_UNSAFE",
  "TRACE_CALL_MISMATCH",
  "TRACE_WRITE_FAILED",
] as const);
export type TraceFailureCode = (typeof TRACE_FAILURE_CODES)[number];

class TraceError extends Error {
  constructor(readonly code: TraceFailureCode) {
    super(code);
  }
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type ReadResult = "COMPLETE" | "MISSING" | "OVERSIZED" | "READ_FAILED" | "NOT_RECEIVED";
type GateState = "PASSED" | "FAILED" | "NOT_REACHED" | "NOT_APPLICABLE" | "UNDETERMINED";

type PendingCall = {
  sequence: number;
  callIndex: number;
  transport: "RESPONSE_RECEIVED" | "TRANSPORT_FAILED" | "ABORTED";
  httpStatus: number | null;
  contentTypeClass: "JSON" | "EVENT_STREAM" | "TEXT" | "OTHER" | "MISSING" | null;
  readResult: ReadResult;
  byteCount: number | null;
  bytes: Uint8Array | null;
};

export type TraceCallSummary = Readonly<{
  fixtureId: string;
  callIndex: number;
  transport: PendingCall["transport"];
  httpStatus: number | null;
  readResult: ReadResult;
  adapterOutcome: EvaluationCallObservation["adapterOutcome"];
  diagnosticCode: string | null;
  verdict: "ACCEPTED" | "REJECTED" | "NOT_RUN";
  reasonCode: AiReasonCode | null;
  abstentionReason: EvaluationCallObservation["abstentionReason"];
  retention: KieRetentionResult | null;
  finalOutcome: FixtureEvidence["outcome"];
}>;

export type Packet11LiveTracer = Readonly<{
  directory: string;
  fetcher: Fetcher;
  observer: EvaluationObserver;
  /** Written trace files, relative to the project root, in write order. */
  files(): readonly string[];
  /** Closed codes only; safe to print. */
  summary(): readonly TraceCallSummary[];
  failure(): TraceFailureCode | null;
}>;

const SAFE_FIXTURE_ID = /^p11\.[a-z0-9.-]+$/;
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const utc = (value: string) => new Date(value).toISOString();

function contentTypeClass(header: string | null): PendingCall["contentTypeClass"] {
  if (!header) return "MISSING";
  const type = header.split(";")[0]!.trim().toLowerCase();
  if (type === "text/event-stream") return "EVENT_STREAM";
  if (type === "application/json" || type.endsWith("+json")) return "JSON";
  if (type === "text/plain") return "TEXT";
  return "OTHER";
}

/** Header names in full; values only for the two fixed protocol headers. The Authorization value is never read. */
function redactedHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (headers === null || typeof headers !== "object" || headers instanceof Headers || Array.isArray(headers)) throw new TraceError("TRACE_REQUEST_UNSUPPORTED");
  const out: Record<string, string> = {};
  for (const name of Object.keys(headers).sort()) {
    const lower = name.toLowerCase();
    if (lower === "authorization") out[lower] = "Bearer [REDACTED]";
    else if (lower === "content-type" || lower === "accept") {
      const value = (headers as Record<string, unknown>)[name];
      out[lower] = typeof value === "string" ? value : "[REDACTED]";
    } else out[lower] = "[REDACTED]";
  }
  return out;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A response identical to the original for the adapter: same status, headers and bytes, and the same read failure. */
function replay(original: Response, chunks: readonly Uint8Array[], error: unknown): Response {
  const init = { status: original.status, statusText: original.statusText, headers: original.headers };
  if (NULL_BODY_STATUSES.has(original.status)) return new Response(null, init);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (error !== undefined) controller.error(error);
      else controller.close();
    },
  });
  return new Response(stream, init);
}

/** Reads at most the adapter's limit plus one chunk; beyond that the body is cancelled exactly as the adapter would. */
async function capture(response: Response, limit: number): Promise<{ readResult: ReadResult; byteCount: number; bytes: Uint8Array | null; replay: Response }> {
  if (!response.body) return { readResult: "MISSING", byteCount: 0, bytes: null, replay: response };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { readResult: "OVERSIZED", byteCount: total, bytes: null, replay: replay(response, chunks, undefined) };
      }
    }
  } catch (error) {
    return { readResult: "READ_FAILED", byteCount: total, bytes: null, replay: replay(response, chunks, error) };
  }
  const bytes = concat(chunks, total);
  return { readResult: "COMPLETE", byteCount: total, bytes, replay: replay(response, [bytes], undefined) };
}

function bodyEvidence(call: PendingCall) {
  if (call.bytes === null) return { body: { readResult: call.readResult, byteCount: call.byteCount, sha256: null, encoding: null, raw: null }, text: null };
  let text: string | null = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(call.bytes);
  } catch {
    text = null;
  }
  const raw = text ?? Buffer.from(call.bytes).toString("base64");
  return { body: { readResult: call.readResult, byteCount: call.byteCount, sha256: sha256(call.bytes), encoding: text === null ? "base64" : "utf8", raw }, text };
}

/** The envelope as untrusted data: parsed only to locate fields; nothing is interpreted. */
function envelopeEvidence(text: string | null) {
  let parsed: unknown = null;
  if (text !== null) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const texts: unknown[] = [];
  if (object && Array.isArray(object.output)) {
    for (const item of object.output as unknown[]) {
      const content = (item as { type?: unknown; content?: unknown } | null)?.type === "message" ? (item as { content?: unknown }).content : null;
      if (Array.isArray(content)) for (const part of content) if ((part as { type?: unknown } | null)?.type === "output_text") texts.push((part as { text?: unknown }).text);
    }
  }
  const storePresent = object !== null && Object.prototype.hasOwnProperty.call(object, "store");
  const usage = object && object.usage !== null && typeof object.usage === "object" ? (object.usage as Record<string, unknown>) : null;
  const details = usage && usage.output_tokens_details !== null && typeof usage.output_tokens_details === "object" ? (usage.output_tokens_details as Record<string, unknown>) : null;
  return {
    parsedEnvelope: parsed,
    outputText: texts.length === 1 && typeof texts[0] === "string" ? texts[0] : null,
    outputTextItemCount: texts.length,
    returnedModel: object && "model" in object ? object.model : null,
    returnedStorePresent: storePresent,
    returnedStore: storePresent ? object!.store : null,
    // The adapter's own classification; null when no envelope object was received.
    retention: object ? classifyKieRetention(object.store) : null,
    usage: object ? { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, reasoningTokens: details?.reasoning_tokens ?? null, creditsConsumed: object.credits_consumed ?? null } : null,
  };
}

/**
 * Gate states from the single validator verdict and its fixed order: schema
 * and task identity, locale, reference closure, abstention, references,
 * fidelity, authority/meaning, locale fidelity, budget. LOCALE_INVALID can
 * arise before references or after meaning, so it leaves both undetermined.
 */
function gateStates(validation: EvaluationCallObservation["validation"]): { verdict: "ACCEPTED" | "REJECTED" | "NOT_RUN"; reasonCode: AiReasonCode | null; repairable: boolean | null; schema: GateState; reference: GateState; fidelity: GateState; meaning: GateState } {
  if (validation === null) return { verdict: "NOT_RUN", reasonCode: null, repairable: null, schema: "NOT_REACHED", reference: "NOT_REACHED", fidelity: "NOT_REACHED", meaning: "NOT_REACHED" };
  if (validation.kind === "ACCEPTED") return { verdict: "ACCEPTED", reasonCode: null, repairable: null, schema: "PASSED", reference: "PASSED", fidelity: "PASSED", meaning: "PASSED" };
  const states = (schema: GateState, reference: GateState, fidelity: GateState, meaning: GateState) => ({ verdict: "REJECTED" as const, reasonCode: validation.reason, repairable: validation.repairable, schema, reference, fidelity, meaning });
  switch (validation.reason) {
    case "SCHEMA_INVALID":
      return states("FAILED", "NOT_REACHED", "NOT_REACHED", "NOT_REACHED");
    case "LOCALE_INVALID":
      return states("PASSED", "UNDETERMINED", "UNDETERMINED", "UNDETERMINED");
    case "REFERENCE_MISMATCH":
      return states("PASSED", "FAILED", "NOT_REACHED", "NOT_REACHED");
    case "MODEL_ABSTAINED":
      return states("PASSED", "PASSED", "NOT_APPLICABLE", "NOT_APPLICABLE");
    case "FACT_FIDELITY_FAILED":
      return states("PASSED", "PASSED", "FAILED", "NOT_REACHED");
    case "AUTHORITY_BOUNDARY_VIOLATION":
    case "CLINICAL_MEANING_VIOLATION":
      return states("PASSED", "PASSED", "PASSED", "FAILED");
    case "OUTPUT_BUDGET_EXCEEDED":
      return states("PASSED", "PASSED", "PASSED", "PASSED");
    default:
      return states("NOT_REACHED", "NOT_REACHED", "NOT_REACHED", "NOT_REACHED");
  }
}

function expectedInputText(fixture: AiEvaluationFixture): string | null {
  const projection = projectProviderTaskPayload(fixture.request, resolveAiTaskBundle(fixture.taskType, fixture.locale));
  if (projection.kind !== "PROJECTED") return null;
  const parsed = providerTaskRequestSchema.safeParse(projection.payload);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

function assertTraceRootIgnored(): void {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", `${PACKET_11_TRACE_ROOT}/probe/01-call.request.json`], { cwd: process.cwd(), stdio: "ignore" });
  } catch {
    throw new TraceError("TRACE_ROOT_NOT_IGNORED");
  }
}

export async function createPacket11LiveTracer(options: { fetcher: Fetcher; now?: () => string }): Promise<Packet11LiveTracer> {
  const now = options.now ?? (() => new Date().toISOString());
  assertTraceRootIgnored();
  const root = resolve(process.cwd(), PACKET_11_TRACE_ROOT);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stamp = utc(now()).replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const directory = join(root, `${stamp}-${randomBytes(8).toString("hex")}`);
  // Non-recursive: an existing directory is an error, never reused.
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);

  const written: string[] = [];
  const summaries: TraceCallSummary[] = [];
  let current: AiEvaluationFixture | null = null;
  let expected: string | null = null;
  let pending: PendingCall[] = [];
  let sequence = 0;
  let failure: TraceFailureCode | null = null;

  const refuse = (code: TraceFailureCode): never => {
    failure ??= code;
    throw new TraceError(code);
  };

  async function write(name: string, record: unknown): Promise<void> {
    const path = join(directory, name);
    try {
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      refuse("TRACE_WRITE_FAILED");
    }
    written.push(relative(process.cwd(), path));
  }

  const fileName = (call: { sequence: number; callIndex: number }, fixtureId: string, kind: "request" | "response") => `${String(call.sequence).padStart(2, "0")}-${fixtureId}-call${call.callIndex}.${kind}.json`;

  async function tracedFetch(url: string, init: RequestInit): Promise<Response> {
    const fixture = current;
    if (fixture === null) return refuse("TRACE_NO_BOUND_FIXTURE");
    // After a write failure nothing further is transmitted.
    if (failure === "TRACE_WRITE_FAILED") throw new TraceError(failure);
    if (typeof init.body !== "string") return refuse("TRACE_REQUEST_UNSUPPORTED");
    const bodyText = init.body;
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return refuse("TRACE_REQUEST_NOT_FIXTURE_PROJECTION");
    }
    // The fixture projection is exactly the last input message. A two-message request (route kie-responses.11b.5,
    // Grok layout) carries exactly the fixture's static prompt asset first; data is never merged or repeated.
    const input = (body as { input?: unknown } | null)?.input;
    const texts = Array.isArray(input) ? input.map((entry) => (Array.isArray(entry?.content) && entry.content.length === 1 ? entry.content[0]?.text : undefined)) : [];
    const instructions = promptFor(fixture.taskType as Packet11RemoteTask, fixture.locale)?.text;
    const layoutOk = texts.length === 1 || (texts.length === 2 && instructions !== undefined && texts[0] === instructions);
    if (expected === null || !layoutOk || texts.at(-1) !== expected) return refuse("TRACE_REQUEST_NOT_FIXTURE_PROJECTION");
    if ((body as { store?: unknown }).store !== false) return refuse("TRACE_REQUEST_RETENTION_UNSAFE");
    const headers = redactedHeaders(init.headers);

    const call: PendingCall = { sequence: ++sequence, callIndex: pending.length + 1, transport: "TRANSPORT_FAILED", httpStatus: null, contentTypeClass: null, readResult: "NOT_RECEIVED", byteCount: null, bytes: null };
    const bodyBytes = new TextEncoder().encode(bodyText);
    // Written before transmission: a write failure means the call is never sent.
    await write(fileName(call, fixture.id, "request"), {
      traceFormatVersion: PACKET_11_TRACE_FORMAT_VERSION,
      kind: "REQUEST",
      fixtureId: fixture.id,
      callIndex: call.callIndex,
      recordedAt: utc(now()),
      endpoint: url,
      method: init.method ?? "GET",
      headers,
      requestedStore: false,
      body,
      bodyText,
      bodyByteCount: bodyBytes.byteLength,
      bodySha256: sha256(bodyBytes),
    });
    pending.push(call);

    let response: Response;
    try {
      response = await options.fetcher(url, init);
    } catch (error) {
      call.transport = init.signal?.aborted ? "ABORTED" : "TRANSPORT_FAILED";
      throw error;
    }
    call.transport = "RESPONSE_RECEIVED";
    call.httpStatus = response.status;
    call.contentTypeClass = contentTypeClass(response.headers.get("content-type"));
    const captured = await capture(response, KIE_MAX_RESPONSE_BYTES);
    call.readResult = captured.readResult;
    call.byteCount = captured.byteCount;
    call.bytes = captured.bytes;
    return captured.replay;
  }

  const observer: EvaluationObserver = Object.freeze({
    beginFixture(fixture: AiEvaluationFixture): void {
      if (!PACKET_11_FIXTURES.includes(fixture) || fixture.request.releaseProfile !== "HACKATHON_DEMO" || !SAFE_FIXTURE_ID.test(fixture.id)) throw new TraceError("TRACE_FIXTURE_NOT_REGISTERED");
      if (current !== null) throw new TraceError("TRACE_FIXTURE_SEQUENCE");
      current = fixture;
      expected = expectedInputText(fixture);
      pending = [];
    },
    async endFixture(evidence: FixtureEvidence, calls: readonly EvaluationCallObservation[]): Promise<void> {
      const fixture = current;
      current = null;
      expected = null;
      if (failure !== null) throw new TraceError(failure);
      if (fixture === null || fixture.id !== evidence.fixtureId || pending.length !== calls.length) refuse("TRACE_CALL_MISMATCH");
      for (const [index, call] of pending.entries()) {
        const observed = calls[index]!;
        const { body, text } = bodyEvidence(call);
        const gates = gateStates(observed.validation);
        const envelope = envelopeEvidence(text);
        await write(fileName(call, fixture!.id, "response"), {
          traceFormatVersion: PACKET_11_TRACE_FORMAT_VERSION,
          kind: "RESPONSE",
          fixtureId: fixture!.id,
          callIndex: call.callIndex,
          recordedAt: utc(now()),
          transport: call.transport,
          httpStatus: call.httpStatus,
          contentTypeClass: call.contentTypeClass,
          requestedStore: false,
          body,
          ...envelope,
          adapter: { outcome: observed.adapterOutcome, failureReason: observed.failureReason, diagnosticCode: observed.diagnosticCode },
          validation: { ...gates, schemaDiagnostic: observed.schemaDiagnostic, referenceDiagnostic: observed.referenceDiagnostic, meaningDiagnostic: observed.meaningDiagnostic },
          abstentionReason: observed.abstentionReason,
          finalDecision: { outcome: evidence.outcome, reasonCode: evidence.reasonCode },
        });
        summaries.push(
          Object.freeze({
            fixtureId: fixture!.id,
            callIndex: call.callIndex,
            transport: call.transport,
            httpStatus: call.httpStatus,
            readResult: call.readResult,
            adapterOutcome: observed.adapterOutcome,
            diagnosticCode: observed.diagnosticCode,
            verdict: gates.verdict,
            reasonCode: gates.reasonCode,
            abstentionReason: observed.abstentionReason,
            retention: envelope.retention,
            finalOutcome: evidence.outcome,
          }),
        );
      }
      pending = [];
    },
  });

  return Object.freeze({
    directory,
    fetcher: tracedFetch,
    observer,
    files: () => Object.freeze([...written]),
    summary: () => Object.freeze([...summaries]),
    failure: () => failure,
  });
}
