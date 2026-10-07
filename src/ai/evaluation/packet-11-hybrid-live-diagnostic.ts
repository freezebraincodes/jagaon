import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_FLASH_PEAK_USD_PER_MILLION, DEEPSEEK_RESPONSES_URL, deepSeekCostMicroUsd } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { KIE_MAX_RESPONSE_BYTES } from "@/ai/kie/kie-responses-contracts";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { shellOutputJsonSchema, shellOutputSchemaName } from "@/ai/kie/kie-shell-contracts";
import { shellPromptFor } from "@/ai/prompts/packet-11-shell-prompts";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import { AI_LANGUAGE_COPY } from "@/application/ai/language/ai-language-copy";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import { atomMultiset, composeDeterministic } from "@/application/ai/language/deterministic-composition";
import { CLINICAL_TOKEN_SEPARATOR, shellClinicalLabel, shellLexicalViolations, shellRegisterViolation, type ShellClinicalLabelCategory, type ShellLexicalViolation } from "@/application/ai/language/shell-lexicon";
import { approvedSectionHeading, GLOSSES_BY_KIND, isApprovedShellTaskRequest, projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { countSentences, languagePresent, meaningfulWording, shellMeaningScan, stripSlotTokens, validateShellCandidate, type ShellGate, type ShellIntegrityCode, type ShellQualityDetail, type ShellRegisterCode } from "@/application/ai/language/shell-validator";
import { planSlots } from "@/application/ai/language/slot-planner";
import {
  AI_ORGANISABLE_SECTIONS,
  ATOM_KINDS,
  remoteFields,
  remoteTokenInventory,
  SHELL_INPUT_VERSIONS,
  shellMaxOutputTokens,
  SHELL_OUTPUT_VERSIONS,
  SHELL_TEMPERATURE,
  SLOT_PLAN_VERSION,
  shellOutputSchema,
  shellTaskRequestSchema,
  slotTokenMatcher,
  type AiReasonCode,
  type GlossKey,
  type ShellFieldPath,
  type ShellTask,
  type SlotPlan,
} from "@/domain/ai";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";

/**
 * Packet 11B.8 evaluation-only traced hybrid shell diagnostic (owner approval 2026-10-06: exactly one call, direct
 * DeepSeek, `deepseek-flash`, at most USD 0.01, raw trace). Used only by the explicit live runner
 * packet-11-live-hybrid-diagnostic.test.ts; no production module imports it.
 *
 * Before transmission the traced fetcher binds the call to one registered synthetic hybrid fixture and runs the
 * value-blindness check on the exact request bytes: the body is the approved static shell prompt plus exactly the
 * fixture's value-blind shell projection, every string in the projection is an approved closed value (versions,
 * task, locale, bundle key, claim family, slot identifiers, atom kinds, approved glosses, field paths, approved
 * headings), every number is a field budget, and no fact value, date, unit, reference or patient text from the
 * fixture appears. A failing body, a second transmission or any other endpoint is refused unsent. The request is
 * written (Authorization value replaced, never read) before transmission; the raw response is captured under the
 * adapter's own size limit and replayed unchanged. Files go to a fresh private directory under the Git-ignored
 * trace root. Only closed codes, counts, versions, timings and spend are returned for printing.
 *
 * Packet 11B.9 (request profile ai-shell-request.11b.9): the body must carry `max_output_tokens` exactly
 * SHELL_MAX_OUTPUT_TOKENS (512), or it is refused unsent; the pre-call estimate uses that cap; the request record
 * names it and the response record carries the response status and a closed incomplete-details flag.
 * Packet 11B.10 (ai-shell-request.11b.10): the required value is the fixture task's cap (EXPLAIN 512, care 1024), and
 * the estimate and the request record use that task's cap.
 * Rules r4 (Packet 11B.11, offline): the sweep also reports, per field, the r4 meaningful-wording result and the zh S7
 * register detail, and the authoritative verdict carries the register and the S7b quality details (fix round 1); the presence groups are the r4 groups
 * (EXPLAIN headline, observation and evidence; each care section intro) judged with meaningfulWording.
 * Rules r5 (Packet 11B.12, offline): the sweep also reports, per field, the r5 clinical-label category (`shellClinicalLabel`,
 * tokens removed, reported independently of earlier gates), and the authoritative verdict carries the S6b category.
 * Rules r7 (ai-shell-request.11b.11, offline): the body must also carry `temperature` exactly SHELL_TEMPERATURE (0.2), or it is
 * refused unsent (TEMPERATURE_NOT_APPROVED; the approved body keys include it), and the request record names it.
 * Rules r8 (offline): the per-field directive flag reads S6's own provenance-aware scan (`shellMeaningScan`: a match that splits a
 * stand-in occurrence does not count; the token-separated copy is read too), so it agrees with the authoritative S6 verdict.
 * FULL-runner tooling (owner Option A, 2026-10-06, offline; used only by packet-11-live-hybrid-full.test.ts): an opt-in class
 * mode (`maxPerFixture` 1 or 2, `ceilingUsd` required). Requests are value-blind, so several listed fixtures can share a
 * byte-identical projection and a structural repair re-sends the same request: each body is bound to the CLASS of listed
 * fixtures whose expected projection equals its input text, the value-blindness check must pass against every class member
 * (no class: refused unsent), the class is sent at most maxPerFixture x classSize times and the run at most
 * `maxTransmissions` times. Files are `<seq>-<classHash8>-call.request.json` / `.response.json` (global transmission order;
 * same redaction, privacy and raw capture). Hard pre-send spend: before any write or transmission a call is refused unsent
 * (TRACE_SPEND_CEILING) when committed spend (every settled call billed from its reported usage, or at its own upper bound when
 * usage is missing or unreadable; in-flight calls reserved at their upper bound) plus this call's upper bound (`estimateMaxUsd`)
 * would exceed the ceiling, so total billed never exceeds it while each call bills at most its upper bound. `calls()` records
 * every fetcher invocation (refused ones included) for the post-run call map. Without `maxPerFixture` the one-fixture and
 * smoke behaviour is unchanged (an optional `ceilingUsd` adds only the spend check).
 * Observation ownership (packet11-eval.17, offline): the request check allows only the plan's REMOTE field paths and slot ids (an
 * application-owned observation path, slot id or budget in the request is UNAPPROVED_STRING / BUDGETS_NOT_PLAN), the sweep reads the
 * model's fields only (EXPLAIN headline and evidence; the presence groups are those two) against the remote inventory, and assembly
 * is the service's own AI-path composition (`composeAiResult`: local observation, S9, S10).
 */

export const PACKET_11_HYBRID_TRACE_FORMAT_VERSION = "packet11-hybrid-trace.1";
export const PACKET_11_HYBRID_TRACE_ROOT = "test-results/packet-11-hybrid-live-trace";
/** Record format of the class-mode (FULL runner) request and response files. */
export const PACKET_11_HYBRID_CLASS_TRACE_FORMAT_VERSION = "packet11-hybrid-trace.2";
/** Margin for provider-side message framing on top of the request byte count. */
const INPUT_FRAMING_MARGIN_TOKENS = 256;

export const HYBRID_TRACE_FAILURE_CODES = Object.freeze([
  "TRACE_ROOT_NOT_IGNORED",
  "TRACE_FIXTURE_NOT_REGISTERED",
  "TRACE_ENDPOINT_NOT_ALLOWED",
  "TRACE_CALL_LIMIT",
  "TRACE_REQUEST_UNSUPPORTED",
  "TRACE_REQUEST_NOT_VALUE_BLIND",
  "TRACE_WRITE_FAILED",
  "TRACE_SPEND_CEILING",
] as const);
export type HybridTraceFailureCode = (typeof HYBRID_TRACE_FAILURE_CODES)[number];

class HybridTraceError extends Error {
  constructor(readonly code: HybridTraceFailureCode) {
    super(code);
  }
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const REQUEST_BODY_KEYS = ["input", "instructions", "max_output_tokens", "model", "reasoning", "store", "stream", "temperature", "text"];
const SHELL_REQUEST_KEYS = ["claimFamily", "fields", "locale", "runtimeBundleKey", "sections", "shellInputVersion", "shellSchemaVersion", "slotPlanVersion", "slots", "taskType", "tokenInventory"];
const BUDGET_KEYS = new Set(["maxCodePoints", "maxSentences"]);
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/;
const REFERENCE_PATTERN = /\b(?:fact|claim|option|record|section|limitation|excerpt|rev|src|source|req)[-_]\w/i;
const UNIT_PATTERN = /\b(?:MMOL_L|MG_DL|mmol|mg\/dl|kg|bpm|mmHg)\b/i;
const MIN_SCANNED_FIXTURE_STRING = 3;
/** The one excluded negative-scan path: the fact value-kind enum, closed by the request schema. */
const FACT_VALUE_KIND_PATH = /^facts\[\d+\]\.value\.kind$/;

export type ValueBlindnessSummary = Readonly<{
  taskType: string | null;
  locale: string | null;
  versions: Readonly<Record<string, string | null>>;
  tokenInventory: readonly string[];
  slots: ReadonlyArray<Readonly<{ slotId: string; atomKind: string; glossKey: GlossKey | null }>>;
  fields: ReadonlyArray<Readonly<{ path: string; requiredSlots: readonly string[]; maxCodePoints: number; maxSentences: number; mayBeAtomOnly: boolean }>>;
  sectionCount: number;
  fixtureStringsScanned: number;
  fixtureValuesFound: number;
  bodyByteCount: number;
  inputMessageByteCount: number;
}>;
export type ValueBlindnessResult = Readonly<{ passed: boolean; violations: readonly string[]; summary: ValueBlindnessSummary }>;

function leaves(value: unknown, path: string, visit: (leaf: string | number | boolean | null, path: string) => void): void {
  if (Array.isArray(value)) value.forEach((item, index) => leaves(item, `${path}[${index}]`, visit));
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key, visit);
  else visit(value as string | number | boolean | null, path);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function glossKeyOf(gloss: string, locale: "en-SG" | "zh-SG"): GlossKey | null {
  for (const [key, text] of Object.entries(AI_LANGUAGE_COPY.glosses)) if ((text as Record<string, string>)[locale] === gloss) return key as GlossKey;
  return null;
}

function plannedOf(fixture: AiEvaluationFixture): { plan: SlotPlan; atoms: ReturnType<typeof planSlots> extends infer R ? (R extends { kind: "PLANNED"; atoms: infer A } ? A : never) : never } | null {
  const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
  return planned.kind === "PLANNED" ? { plan: planned.plan, atoms: planned.atoms } : null;
}

/** The exact provider message text the shared adapter builds for this fixture: the schema-parsed projection. */
export function expectedShellInputText(fixture: AiEvaluationFixture): string | null {
  const planned = plannedOf(fixture);
  if (!planned || planned.plan.remote.eligible !== true) return null;
  const parsed = shellTaskRequestSchema.safeParse(projectShellTaskRequest(planned.plan));
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

/**
 * The value-blindness check on the exact request body, before transmission. Pure: closed violation codes, the
 * structural summary (slot identifiers, atom kinds, gloss keys, budgets, versions) and counts only.
 */
export function checkHybridShellRequestBody(fixture: AiEvaluationFixture, bodyText: string, expectedModel: string): ValueBlindnessResult {
  const violations = new Set<string>();
  const task = fixture.taskType as ShellTask;
  const locale = fixture.locale;
  const bundle = AI_HYBRID_RUNTIME_BUNDLES[task];
  const planned = plannedOf(fixture);
  const empty: ValueBlindnessSummary = { taskType: null, locale: null, versions: {}, tokenInventory: [], slots: [], fields: [], sectionCount: 0, fixtureStringsScanned: 0, fixtureValuesFound: 0, bodyByteCount: new TextEncoder().encode(bodyText).byteLength, inputMessageByteCount: 0 };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return { passed: false, violations: ["BODY_NOT_JSON_OBJECT"], summary: empty };
  }
  if (!planned) violations.add("FIXTURE_NOT_PLANNABLE");
  if (Object.keys(body).sort().join("|") !== REQUEST_BODY_KEYS.join("|")) violations.add("BODY_KEYS");
  if (body.model !== expectedModel) violations.add("BODY_MODEL");
  if (body.store !== false) violations.add("STORE_NOT_FALSE");
  if (body.stream !== false) violations.add("STREAM_NOT_FALSE");
  if (body.max_output_tokens !== shellMaxOutputTokens(task)) violations.add("MAX_OUTPUT_TOKENS_NOT_APPROVED");
  // Rules r7: the fixed shell sampling temperature, by strict equality (a missing, null, string or other value fails).
  if (body.temperature !== SHELL_TEMPERATURE) violations.add("TEMPERATURE_NOT_APPROVED");
  if (!sameJson(body.reasoning, { effort: "none" })) violations.add("REASONING_NOT_NONE");
  if (!sameJson(body.text, { format: { type: "json_schema", name: shellOutputSchemaName(task, locale), schema: shellOutputJsonSchema(task, locale), strict: true } })) violations.add("TEXT_FORMAT_NOT_APPROVED");
  const prompt = shellPromptFor(task, locale);
  if (!prompt || body.instructions !== prompt.text) violations.add("INSTRUCTIONS_NOT_APPROVED_ASSET");

  const input = body.input;
  const message = Array.isArray(input) && input.length === 1 ? (input[0] as Record<string, unknown> | null) : null;
  const content = message && message.role === "user" && Array.isArray(message.content) && message.content.length === 1 ? (message.content[0] as Record<string, unknown> | null) : null;
  const inputText = content && content.type === "input_text" && typeof content.text === "string" ? content.text : null;
  if (inputText === null) {
    violations.add("INPUT_LAYOUT");
    return { passed: false, violations: [...violations].sort(), summary: empty };
  }
  if (inputText !== expectedShellInputText(fixture)) violations.add("INPUT_NOT_FIXTURE_PROJECTION");

  let shell: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(inputText) as unknown;
    shell = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    shell = null;
  }
  if (!shell) {
    violations.add("INPUT_NOT_JSON_OBJECT");
    return { passed: false, violations: [...violations].sort(), summary: empty };
  }
  if (!isApprovedShellTaskRequest(shell)) violations.add("SHELL_REQUEST_NOT_APPROVED");
  if (Object.keys(shell).sort().join("|") !== SHELL_REQUEST_KEYS.join("|")) violations.add("SHELL_REQUEST_KEYS");
  if (shell.taskType !== task || shell.locale !== locale) violations.add("TASK_OR_LOCALE");
  if (shell.shellInputVersion !== SHELL_INPUT_VERSIONS[task] || shell.shellSchemaVersion !== SHELL_OUTPUT_VERSIONS[task] || shell.slotPlanVersion !== SLOT_PLAN_VERSION || shell.runtimeBundleKey !== bundle.bundleKey) violations.add("VERSIONS");

  // Closed allowlist of every string the value-blind request may carry.
  const allowed = new Set<string>([task, locale, bundle.bundleKey, SHELL_INPUT_VERSIONS[task], SHELL_OUTPUT_VERSIONS[task], SLOT_PLAN_VERSION, ...ATOM_KINDS]);
  if (planned) {
    if (planned.plan.claimFamily) allowed.add(planned.plan.claimFamily);
    // Only the model's fields and their slots may appear; an application-owned field never crosses the boundary.
    for (const field of remoteFields(planned.plan)) allowed.add(field.path);
    for (const slotId of remoteTokenInventory(planned.plan)) allowed.add(slotId);
    for (const section of planned.plan.sections) allowed.add(section.sectionSlot);
  }
  for (const kind of ATOM_KINDS) for (const key of GLOSSES_BY_KIND[kind]) allowed.add(AI_LANGUAGE_COPY.glosses[key][locale]);
  for (const id of AI_ORGANISABLE_SECTIONS) {
    const heading = approvedSectionHeading(locale, id);
    if (heading) allowed.add(heading);
  }
  const shellStrings: string[] = [];
  leaves(shell, "", (leaf, path) => {
    const key = path.split(".").at(-1)!.replace(/\[\d+\]$/, "");
    if (typeof leaf === "string") {
      shellStrings.push(leaf);
      if (!allowed.has(leaf)) violations.add("UNAPPROVED_STRING");
      if (key === "gloss" && DATE_PATTERN.test(leaf)) violations.add("DATE_IN_GLOSS");
    } else if (typeof leaf === "number") {
      if (!BUDGET_KEYS.has(key)) violations.add("NUMBER_OUTSIDE_BUDGET");
    } else if (typeof leaf === "boolean") {
      if (key !== "mayBeAtomOnly") violations.add("BOOLEAN_OUTSIDE_FIELD_SPEC");
    } else if (leaf === null) {
      if (key !== "claimFamily") violations.add("NULL_OUTSIDE_CLAIM_FAMILY");
    }
  });
  if (DATE_PATTERN.test(inputText)) violations.add("DATE_PATTERN_PRESENT");
  if (REFERENCE_PATTERN.test(inputText)) violations.add("REFERENCE_PATTERN_PRESENT");
  if (UNIT_PATTERN.test(inputText)) violations.add("UNIT_PATTERN_PRESENT");

  // Budgets are the plan's fixed budgets, field by field.
  const fields = Array.isArray(shell.fields) ? (shell.fields as Array<Record<string, unknown>>) : [];
  if (planned) {
    const expectedBudgets = remoteFields(planned.plan).map((field) => [field.path, field.maxCodePoints, field.maxSentences, field.mayBeAtomOnly]);
    if (!sameJson(fields.map((field) => [field.path, field.maxCodePoints, field.maxSentences, field.mayBeAtomOnly]), expectedBudgets)) violations.add("BUDGETS_NOT_PLAN");
  }

  // Negative scan: no fixture string (fact value, date, unit, reference, patient text, rendered atom) in the message.
  const fixtureStrings = new Set<string>();
  leaves(fixture.request, "", (leaf, path) => {
    // Only the schema-closed fact value-kind enum (facts[*].value.kind, e.g. "TEXT", a substring of the approved atom
    // kind "QUOTED_TEXT") is not fixture data; every other leaf keeps its substring scan.
    if (FACT_VALUE_KIND_PATH.test(path)) return;
    if (typeof leaf === "string" && leaf.length >= MIN_SCANNED_FIXTURE_STRING && !allowed.has(leaf)) fixtureStrings.add(leaf);
    if (typeof leaf === "number" && !Number.isInteger(leaf)) fixtureStrings.add(String(leaf));
  });
  if (planned) for (const entry of Object.values(planned.atoms)) if (entry && entry.text.length >= MIN_SCANNED_FIXTURE_STRING && !allowed.has(entry.text)) fixtureStrings.add(entry.text);
  let found = 0;
  for (const value of fixtureStrings) if (inputText.includes(value)) found += 1;
  if (found > 0) violations.add("FIXTURE_VALUE_PRESENT");

  const summary: ValueBlindnessSummary = {
    taskType: typeof shell.taskType === "string" ? shell.taskType : null,
    locale: typeof shell.locale === "string" ? shell.locale : null,
    versions: { shellInputVersion: String(shell.shellInputVersion ?? ""), shellSchemaVersion: String(shell.shellSchemaVersion ?? ""), slotPlanVersion: String(shell.slotPlanVersion ?? ""), runtimeBundleKey: String(shell.runtimeBundleKey ?? ""), claimFamily: typeof shell.claimFamily === "string" ? shell.claimFamily : null },
    tokenInventory: Array.isArray(shell.tokenInventory) ? (shell.tokenInventory as unknown[]).map(String) : [],
    slots: Array.isArray(shell.slots) ? (shell.slots as Array<Record<string, unknown>>).map((slot) => ({ slotId: String(slot.slotId), atomKind: String(slot.atomKind), glossKey: typeof slot.gloss === "string" ? glossKeyOf(slot.gloss, locale) : null })) : [],
    fields: fields.map((field) => ({ path: String(field.path), requiredSlots: Array.isArray(field.requiredSlots) ? (field.requiredSlots as unknown[]).map(String) : [], maxCodePoints: Number(field.maxCodePoints), maxSentences: Number(field.maxSentences), mayBeAtomOnly: field.mayBeAtomOnly === true })),
    sectionCount: Array.isArray(shell.sections) ? shell.sections.length : 0,
    fixtureStringsScanned: fixtureStrings.size,
    fixtureValuesFound: found,
    bodyByteCount: empty.bodyByteCount,
    inputMessageByteCount: new TextEncoder().encode(inputText).byteLength,
  };
  return { passed: violations.size === 0, violations: [...violations].sort(), summary };
}

/** Upper-bound USD estimate before the call: every request byte as one input token, plus the task's fixed output cap. */
export function estimateMaxUsd(bodyByteCount: number, task: ShellTask): Readonly<{ inputTokensUpperBound: number; outputTokensMax: number; estimatedMaxUsd: number }> {
  const inputTokensUpperBound = bodyByteCount + INPUT_FRAMING_MARGIN_TOKENS;
  const outputTokensMax = shellMaxOutputTokens(task);
  const micro = inputTokensUpperBound * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.inputCacheMiss + outputTokensMax * DEEPSEEK_FLASH_PEAK_USD_PER_MILLION.output;
  return { inputTokensUpperBound, outputTokensMax, estimatedMaxUsd: Math.ceil(micro) / 1_000_000 };
}

export type TokenCheck = "EXACT" | "MALFORMED" | "STRAY" | "DUPLICATE" | "MISSING" | "REORDERED";
export type BudgetCheck = "WITHIN" | "OVER_CODE_POINTS" | "OVER_SENTENCES" | "EMPTY_FRAME";
export type ShellSweep = Readonly<{
  authoritative: Readonly<{ verdict: "ACCEPTED" | "REJECTED"; gate: ShellGate | null; reason: AiReasonCode | null; integrity: ShellIntegrityCode | null; lexical: readonly ShellLexicalViolation[]; register: ShellRegisterCode | null; quality: ShellQualityDetail | null; clinicalLabel: ShellClinicalLabelCategory | null }>;
  candidateKind: "OBJECT" | "UNPARSED_TEXT" | "OTHER";
  schema: "PASSED" | "FAILED";
  outcome: "SUCCESS" | "ABSTAIN" | null;
  schemaVersionEcho: boolean | null;
  slotPlanVersionEcho: boolean | null;
  tokenInventoryEcho: boolean | null;
  localeEcho: boolean | null;
  fields: ReadonlyArray<Readonly<{ path: ShellFieldPath; tokens: TokenCheck; budget: BudgetCheck; codePoints: number; maxCodePoints: number; languagePresent: boolean; meaningfulWording: boolean; lexical: readonly ShellLexicalViolation[]; directive: boolean; register: ShellRegisterCode | null; clinicalLabel: ShellClinicalLabelCategory | null }>>;
  presenceGroups: ReadonlyArray<Readonly<{ paths: readonly ShellFieldPath[]; satisfied: boolean }>>;
  assembly: "ASSEMBLED" | "REJECTED" | "NOT_REACHED";
  assemblyReason: AiReasonCode | null;
  r7: "ACCEPTED" | "REJECTED" | "NOT_REACHED";
  r7Reason: AiReasonCode | null;
  atomEqual: boolean | null;
}>;

function tokenCheck(text: string, required: readonly string[]): TokenCheck {
  const tokens = [...text.matchAll(slotTokenMatcher())].map((match) => match[1]!);
  if (/\{\{|\}\}|\{\s*S\d|S\d+\s*\}/.test(stripSlotTokens(text, " "))) return "MALFORMED";
  if (tokens.some((token) => !required.includes(token))) return "STRAY";
  if (new Set(tokens).size !== tokens.length) return "DUPLICATE";
  if (required.some((slot) => !tokens.includes(slot))) return "MISSING";
  return tokens.join("|") === required.join("|") ? "EXACT" : "REORDERED";
}

function textsOf(plan: SlotPlan, shells: unknown): Map<ShellFieldPath, string> | null {
  if (shells === null || typeof shells !== "object") return null;
  const texts = new Map<ShellFieldPath, string>();
  if (plan.taskType === "EXPLAIN_PATTERN") {
    for (const path of ["headline", "evidence"] as const) {
      const value = (shells as Record<string, unknown>)[path];
      if (typeof value !== "string") return null;
      texts.set(path, value);
    }
    return texts;
  }
  const sections = (shells as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return null;
  for (const [index, section] of plan.sections.entries()) {
    const entry = sections[index] as { intro?: unknown; bullets?: unknown } | undefined;
    if (!entry || typeof entry.intro !== "string" || !Array.isArray(entry.bullets)) return null;
    texts.set(section.introPath, entry.intro);
    section.bulletPaths.forEach((path, bullet) => typeof (entry.bullets as unknown[])[bullet] === "string" && texts.set(path, (entry.bullets as string[])[bullet]!));
  }
  return texts;
}

/**
 * Every shell check, reported independently (not only the first rejected gate), plus the authoritative verdict
 * of the unchanged gate order, the assembler and the unchanged r7 validator. Closed codes and counts only.
 */
export function sweepShellCandidate(fixture: AiEvaluationFixture, candidate: unknown): ShellSweep {
  const task = fixture.taskType as ShellTask;
  const bundle = AI_HYBRID_RUNTIME_BUNDLES[task];
  const planned = planSlots(fixture.request, bundle);
  if (planned.kind !== "PLANNED") throw new Error("FIXTURE_NOT_PLANNABLE");
  const { plan, atoms } = planned;
  const verdict = validateShellCandidate(plan, bundle, candidate);
  const authoritative = verdict.kind === "VALID"
    ? { verdict: "ACCEPTED" as const, gate: null, reason: null, integrity: null, lexical: [], register: null, quality: null, clinicalLabel: null }
    : { verdict: "REJECTED" as const, gate: verdict.gate, reason: verdict.reason as AiReasonCode, integrity: verdict.integrity ?? null, lexical: verdict.lexical ?? [], register: verdict.register ?? null, quality: verdict.quality ?? null, clinicalLabel: verdict.clinicalLabel ?? null };

  let value: unknown = candidate;
  const candidateKind = typeof candidate === "string" ? "UNPARSED_TEXT" : candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) ? "OBJECT" : "OTHER";
  if (typeof candidate === "string") value = null;
  const schemaOk = value !== null && shellOutputSchema(task).safeParse(value).success;
  const output = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const inventory = remoteTokenInventory(plan);
  const texts = output ? textsOf(plan, output.shells) : null;
  const fields = texts
    ? remoteFields(plan).map((field) => {
        const text = texts.get(field.path) ?? "";
        const prose = stripSlotTokens(text, "").trim();
        const codePoints = [...prose].length;
        const budget: BudgetCheck = codePoints > field.maxCodePoints ? "OVER_CODE_POINTS" : countSentences(prose) > field.maxSentences ? "OVER_SENTENCES" : !field.mayBeAtomOnly && prose.replace(/[\s\p{P}]/gu, "").length === 0 ? "EMPTY_FRAME" : "WITHIN";
        return {
          path: field.path,
          tokens: tokenCheck(text, field.requiredSlots),
          budget,
          codePoints,
          maxCodePoints: field.maxCodePoints,
          languagePresent: languagePresent(text, plan.locale),
          meaningfulWording: meaningfulWording(text, plan.locale),
          lexical: shellLexicalViolations(stripSlotTokens(text, " "), plan.locale, text),
          // Rules r8: the same reading as S6 (stand-in provenance plus the token-separated copy).
          directive: shellMeaningScan(text, plan.locale, AI_LANGUAGE_COPY.tokenStandIn[plan.locale]).directive,
          register: shellRegisterViolation(stripSlotTokens(text, " "), plan.locale),
          // r6 fix round 2: the same matcher input as S6b (tokens as CLINICAL_TOKEN_SEPARATOR, so no neutral phrase spans a token).
          clinicalLabel: shellClinicalLabel(stripSlotTokens(text, CLINICAL_TOKEN_SEPARATOR), plan.locale),
        };
      })
    : [];
  // Rules r4 groups (independent of the validator), model-written fields only: EXPLAIN headline and evidence; each care section intro.
  const groups: ReadonlyArray<readonly ShellFieldPath[]> = plan.taskType === "EXPLAIN_PATTERN" ? [["headline"], ["evidence"]] : plan.sections.map((section) => [section.introPath]);
  const presenceGroups = texts ? groups.map((paths) => ({ paths, satisfied: paths.every((path) => meaningfulWording(texts.get(path) ?? "", plan.locale)) })) : [];

  let assembly: ShellSweep["assembly"] = "NOT_REACHED";
  let assemblyReason: AiReasonCode | null = null;
  let r7: ShellSweep["r7"] = "NOT_REACHED";
  let r7Reason: AiReasonCode | null = null;
  let atomEqual: boolean | null = null;
  if (verdict.kind === "VALID") {
    // eval.17: the service's AI-path composition (local observation, S9, S10). A composer failure is reported as an assembly rejection.
    const composed = composeAiResult(fixture.request, plan, atoms, verdict.shells, bundle);
    if (composed.kind === "REJECTED" && (composed.gate === "S9" || composed.invariant === "COMPOSER")) {
      assembly = "REJECTED";
      assemblyReason = composed.reason;
    } else {
      assembly = "ASSEMBLED";
      r7 = composed.kind === "ACCEPTED" ? "ACCEPTED" : "REJECTED";
      r7Reason = composed.kind === "ACCEPTED" ? null : composed.reason;
      if (composed.kind === "ACCEPTED") atomEqual = JSON.stringify(atomMultiset(composed.composition)) === JSON.stringify(atomMultiset(composeDeterministic(fixture.request, plan, atoms, bundle)));
    }
  }
  return {
    authoritative,
    candidateKind,
    schema: schemaOk ? "PASSED" : "FAILED",
    outcome: output && (output.outcome === "SUCCESS" || output.outcome === "ABSTAIN") ? output.outcome : null,
    schemaVersionEcho: output ? output.schemaVersion === bundle.shellOutputVersion : null,
    slotPlanVersionEcho: output ? output.slotPlanVersion === plan.planVersion : null,
    tokenInventoryEcho: output ? Array.isArray(output.tokenInventory) && (output.tokenInventory as unknown[]).join("|") === inventory.join("|") : null,
    localeEcho: output ? output.locale === plan.locale : null,
    fields,
    presenceGroups,
    assembly,
    assemblyReason,
    r7,
    r7Reason,
    atomEqual,
  };
}

/** Header names in full; values only for the two fixed protocol headers. The Authorization value is never read. */
function redactedHeaders(headers: RequestInit["headers"]): Record<string, string> {
  if (headers === null || typeof headers !== "object" || headers instanceof Headers || Array.isArray(headers)) throw new HybridTraceError("TRACE_REQUEST_UNSUPPORTED");
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

/** Reads at most the adapter's limit plus one chunk and returns an identical replay for the adapter. */
async function capture(response: Response, limit: number): Promise<{ readResult: "COMPLETE" | "MISSING" | "OVERSIZED" | "READ_FAILED"; bytes: Uint8Array | null; byteCount: number; replay: Response }> {
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  if (!response.body) return { readResult: "MISSING", bytes: null, byteCount: 0, replay: response };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = (error?: unknown) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (error !== undefined) controller.error(error);
        else controller.close();
      },
    });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { readResult: "OVERSIZED", bytes: null, byteCount: total, replay: new Response(stream(), init) };
      }
    }
  } catch (error) {
    return { readResult: "READ_FAILED", bytes: null, byteCount: total, replay: new Response(stream(error), init) };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { readResult: "COMPLETE", bytes, byteCount: total, replay: new Response(stream(), init) };
}

/** The response status as a closed class for printing; never the provider's raw string. */
export type HybridResponseStatus = "completed" | "incomplete" | "failed" | "in_progress" | "OTHER";
const RESPONSE_STATUSES: ReadonlySet<string> = new Set(["completed", "incomplete", "failed", "in_progress"]);
function statusClass(status: unknown): HybridResponseStatus | null {
  if (status === undefined || status === null) return null;
  return typeof status === "string" && RESPONSE_STATUSES.has(status) ? (status as HybridResponseStatus) : "OTHER";
}

function envelopeOf(bytes: Uint8Array | null) {
  let text: string | null = null;
  try {
    text = bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;
  } catch {
    text = null;
  }
  let object: Record<string, unknown> | null = null;
  try {
    const parsed = text === null ? null : (JSON.parse(text) as unknown);
    object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    object = null;
  }
  const usage = object && object.usage !== null && typeof object.usage === "object" ? (object.usage as Record<string, unknown>) : null;
  const details = usage && usage.output_tokens_details !== null && typeof usage.output_tokens_details === "object" ? (usage.output_tokens_details as Record<string, unknown>) : null;
  const outputTypes = object && Array.isArray(object.output) ? (object.output as Array<{ type?: unknown }>).map((item) => String(item?.type)) : null;
  return {
    text,
    evidence: {
      bodyEncoding: text === null ? (bytes ? "base64" : null) : "utf8",
      bodyValidJsonObject: object !== null,
      status: object?.status ?? null,
      /** Closed: the response carries a non-null `incomplete_details` (null when no JSON object was received). */
      incompleteDetailsPresent: object === null ? null : Object.prototype.hasOwnProperty.call(object, "incomplete_details") && object.incomplete_details !== null,
      returnedModel: object && "model" in object ? object.model : null,
      returnedStorePresent: object !== null && Object.prototype.hasOwnProperty.call(object, "store"),
      returnedStore: object && Object.prototype.hasOwnProperty.call(object, "store") ? object.store : null,
      outputItemTypes: outputTypes,
      usage: usage ? { inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, reasoningTokens: details?.reasoning_tokens ?? null } : null,
    },
  };
}

export type HybridTransmission = Readonly<{
  endpoint: string;
  httpStatus: number | null;
  transport: "RESPONSE_RECEIVED" | "TRANSPORT_FAILED" | "ABORTED";
  readResult: "COMPLETE" | "MISSING" | "OVERSIZED" | "READ_FAILED" | "NOT_RECEIVED";
  byteCount: number | null;
  latencyMs: number | null;
  /** Closed status class of the received response (null when none was parsed). */
  status: HybridResponseStatus | null;
  /** Closed flag: the response carried a non-null `incomplete_details` (null when none was parsed). */
  incompleteDetailsPresent: boolean | null;
  returnedModel: unknown;
  returnedStorePresent: boolean | null;
  returnedStore: unknown;
  usage: Readonly<{ inputTokens: unknown; outputTokens: unknown; reasoningTokens: unknown }> | null;
}>;

export type HybridDiagnosticTracer = Readonly<{
  directory: string;
  fetcher: Fetcher;
  /** Every pre-send value-blindness result, in order (refused bodies included). */
  checks(): readonly ValueBlindnessResult[];
  transmissions(): readonly HybridTransmission[];
  files(): readonly string[];
  failure(): HybridTraceFailureCode | null;
  /** Every fetcher invocation in order, refused ones included (sequence null): the input for the post-run call map. */
  calls(): readonly HybridTracedCall[];
  /** Pre-send spend accounting (micro-dollar exact, reported in USD). */
  spend(): HybridTraceSpend;
  /** Writes one further JSON record (closed codes) into the trace directory. */
  record(name: string, value: unknown): Promise<void>;
}>;

function assertTraceRootIgnored(): void {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", `${PACKET_11_HYBRID_TRACE_ROOT}/probe/01-call.request.json`], { cwd: process.cwd(), stdio: "ignore" });
  } catch {
    throw new HybridTraceError("TRACE_ROOT_NOT_IGNORED");
  }
}

export type HybridTracedCall = Readonly<{
  /** 1-based order of fetcher invocations (one per harness attempt), refused ones included. */
  invocation: number;
  /** Global transmission order; null when the call was refused unsent. */
  sequence: number | null;
  refusal: HybridTraceFailureCode | null;
  /** First 8 hex digits of the SHA-256 of the bound projection (class mode), else of the input text when readable. */
  classHash: string | null;
  /** SHA-256 of the transmitted input message text (null when refused before binding). */
  inputSha256: string | null;
  upperBoundMicroUsd: number | null;
  billedMicroUsd: number | null;
  billedFrom: "USAGE" | "UPPER_BOUND" | null;
}>;
export type HybridTraceSpend = Readonly<{ ceilingUsd: number | null; committedUsd: number; inFlightUsd: number; settledCalls: number; billedFromUsage: number; billedFromUpperBound: number }>;

const utf8 = (text: string) => new TextEncoder().encode(text);
/** The class identifier of a value-blind projection: the first 8 hex digits of its SHA-256. */
export function shellInputClassHash(inputText: string): string {
  return sha256(utf8(inputText)).slice(0, 8);
}
function inputTextOf(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as { input?: Array<{ content?: Array<{ text?: unknown }> }> };
    const text = body.input?.[0]?.content?.[0]?.text;
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}
const microOfUsd = (usd: number) => Math.round(usd * 1_000_000);
const tokenCount = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * One fixture (the single-call diagnostic) or a fixed ordered list (the smoke). Each transmitted body is bound to the
 * listed fixture with the same task and locale and must be exactly that fixture's value-blind projection; each fixture
 * may be transmitted at most once and the run at most `maxTransmissions` times. Anything else is refused unsent.
 * Class mode (`maxPerFixture`, FULL runner) and the pre-send spend ceiling are described in the module header.
 */
export async function createHybridDiagnosticTracer(options: { fetcher: Fetcher; fixture?: AiEvaluationFixture; fixtures?: readonly AiEvaluationFixture[]; expectedModel: string; maxTransmissions: number; maxPerFixture?: 1 | 2; ceilingUsd?: number; now?: () => string; monotonicMs?: () => number }): Promise<HybridDiagnosticTracer> {
  const now = options.now ?? (() => new Date().toISOString());
  const monotonic = options.monotonicMs ?? (() => performance.now());
  const listed: readonly AiEvaluationFixture[] = options.fixtures ?? (options.fixture ? [options.fixture] : []);
  const classMode = options.maxPerFixture !== undefined;
  if (classMode) {
    if (listed.length === 0 || options.fixture !== undefined || options.fixtures === undefined || new Set(listed.map((item) => item.id)).size !== listed.length) throw new HybridTraceError("TRACE_FIXTURE_NOT_REGISTERED");
  } else {
    const pairs = new Set(listed.map((item) => `${item.taskType}|${item.locale}`));
    if (listed.length === 0 || (options.fixture !== undefined && options.fixtures !== undefined) || pairs.size !== listed.length) throw new HybridTraceError("TRACE_FIXTURE_NOT_REGISTERED");
  }
  for (const item of listed) if (!PACKET_11_HYBRID_FIXTURES.includes(item) || item.request.releaseProfile !== "HACKATHON_DEMO" || !/^p11\.[a-z0-9.-]+$/.test(item.id)) throw new HybridTraceError("TRACE_FIXTURE_NOT_REGISTERED");
  const perFixture: number = options.maxPerFixture ?? 1;
  if (perFixture !== 1 && perFixture !== 2) throw new HybridTraceError("TRACE_CALL_LIMIT");
  if (!Number.isInteger(options.maxTransmissions) || options.maxTransmissions < 1 || options.maxTransmissions > listed.length * perFixture) throw new HybridTraceError("TRACE_CALL_LIMIT");
  if ((classMode || options.ceilingUsd !== undefined) && !(typeof options.ceilingUsd === "number" && Number.isFinite(options.ceilingUsd) && options.ceilingUsd > 0)) throw new HybridTraceError("TRACE_SPEND_CEILING");
  // Micro-dollar exact; a ceiling with more than six decimals is rounded down (stricter).
  const ceilingMicro = options.ceilingUsd === undefined ? null : Math.floor(options.ceilingUsd * 1_000_000 + 1e-6);
  // Class mode: the listed fixtures grouped by their byte-identical value-blind projection (in list order).
  const classes = new Map<string, { hash: string; members: AiEvaluationFixture[] }>();
  if (classMode) {
    for (const item of listed) {
      const projection = expectedShellInputText(item);
      if (projection === null) continue;
      const entry = classes.get(projection) ?? { hash: shellInputClassHash(projection), members: [] };
      entry.members.push(item);
      classes.set(projection, entry);
    }
  }
  assertTraceRootIgnored();
  const root = resolve(process.cwd(), PACKET_11_HYBRID_TRACE_ROOT);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const directory = join(root, `${stamp}-${randomBytes(8).toString("hex")}`);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);

  const written: string[] = [];
  const checks: ValueBlindnessResult[] = [];
  const transmissions: HybridTransmission[] = [];
  const calls: Array<{ -readonly [K in keyof HybridTracedCall]: HybridTracedCall[K] }> = [];
  let attempted = 0;
  const transmitted = new Set<string>();
  const classCounts = new Map<string, number>();
  let settledMicro = 0;
  let inFlightMicro = 0;
  let settledCalls = 0;
  let billedFromUsage = 0;
  let billedFromUpperBound = 0;
  let failure: HybridTraceFailureCode | null = null;
  const refuse = (code: HybridTraceFailureCode): never => {
    failure ??= code;
    throw new HybridTraceError(code);
  };
  async function write(name: string, value: unknown): Promise<void> {
    const path = join(directory, name);
    try {
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      refuse("TRACE_WRITE_FAILED");
    }
    written.push(relative(process.cwd(), path));
  }

  /** The listed fixture with the body's task and locale; an unreadable or unmatched body binds to the first (and fails its check). */
  function boundFixture(bodyText: string): AiEvaluationFixture {
    try {
      const body = JSON.parse(bodyText) as { input?: Array<{ content?: Array<{ text?: unknown }> }> };
      const text = body.input?.[0]?.content?.[0]?.text;
      const shell = typeof text === "string" ? (JSON.parse(text) as { taskType?: unknown; locale?: unknown }) : null;
      return listed.find((item) => item.taskType === shell?.taskType && item.locale === shell?.locale) ?? listed[0]!;
    } catch {
      return listed[0]!;
    }
  }

  async function tracedFetch(url: string, init: RequestInit): Promise<Response> {
    const call: (typeof calls)[number] = { invocation: calls.length + 1, sequence: null, refusal: null, classHash: null, inputSha256: null, upperBoundMicroUsd: null, billedMicroUsd: null, billedFrom: null };
    calls.push(call);
    const refuseCall = (code: HybridTraceFailureCode): never => {
      call.refusal = code;
      return refuse(code);
    };
    if (failure !== null) {
      call.refusal = failure;
      throw new HybridTraceError(failure);
    }
    if (url !== DEEPSEEK_RESPONSES_URL) return refuseCall("TRACE_ENDPOINT_NOT_ALLOWED");
    if (attempted >= options.maxTransmissions) return refuseCall("TRACE_CALL_LIMIT");
    if (typeof init.body !== "string") return refuseCall("TRACE_REQUEST_UNSUPPORTED");
    const bodyText = init.body;
    const inputText = inputTextOf(bodyText);
    if (inputText !== null) call.inputSha256 = sha256(utf8(inputText));
    // Pre-send binding: one listed fixture (legacy) or the class of listed fixtures sharing this exact projection.
    let fixture: AiEvaluationFixture;
    let bound: { hash: string; members: AiEvaluationFixture[] } | null = null;
    let memberChecks: ValueBlindnessResult[];
    if (!classMode) {
      fixture = boundFixture(bodyText);
      if (transmitted.has(fixture.id)) return refuseCall("TRACE_CALL_LIMIT");
      const check = checkHybridShellRequestBody(fixture, bodyText, options.expectedModel);
      checks.push(check);
      memberChecks = [check];
      if (!check.passed) return refuseCall("TRACE_REQUEST_NOT_VALUE_BLIND");
      if (inputText !== null) call.classHash = shellInputClassHash(inputText);
    } else {
      bound = inputText === null ? null : (classes.get(inputText) ?? null);
      if (!bound) {
        // No listed fixture has this projection: the check against the closest listed fixture fails and is recorded.
        checks.push(checkHybridShellRequestBody(boundFixture(bodyText), bodyText, options.expectedModel));
        return refuseCall("TRACE_REQUEST_NOT_VALUE_BLIND");
      }
      call.classHash = bound.hash;
      if ((classCounts.get(bound.hash) ?? 0) >= perFixture * bound.members.length) return refuseCall("TRACE_CALL_LIMIT");
      memberChecks = bound.members.map((member) => checkHybridShellRequestBody(member, bodyText, options.expectedModel));
      checks.push(...memberChecks);
      if (memberChecks.some((check) => !check.passed)) return refuseCall("TRACE_REQUEST_NOT_VALUE_BLIND");
      fixture = bound.members[0]!;
    }
    const task = fixture.taskType as ShellTask;
    const bodyBytes = utf8(bodyText);
    // Hard pre-send spend: this call's upper bound on top of everything committed (settled and in flight).
    const upperMicro = microOfUsd(estimateMaxUsd(bodyBytes.byteLength, task).estimatedMaxUsd);
    call.upperBoundMicroUsd = upperMicro;
    if (ceilingMicro !== null && settledMicro + inFlightMicro + upperMicro > ceilingMicro) return refuseCall("TRACE_SPEND_CEILING");
    let headers: Record<string, string>;
    try {
      headers = redactedHeaders(init.headers);
    } catch (error) {
      call.refusal = "TRACE_REQUEST_UNSUPPORTED";
      throw error;
    }
    attempted += 1;
    if (bound) classCounts.set(bound.hash, (classCounts.get(bound.hash) ?? 0) + 1);
    else transmitted.add(fixture.id);
    const sequence = classMode ? String(attempted).padStart(3, "0") : String(attempted).padStart(2, "0");
    const parsedBody = JSON.parse(bodyText) as JsonValue & { max_output_tokens?: unknown };
    const committedBefore = { committedUsd: settledMicro / 1_000_000, inFlightUsd: inFlightMicro / 1_000_000 };
    inFlightMicro += upperMicro;
    let settled = false;
    const settle = (billedMicro: number, from: "USAGE" | "UPPER_BOUND") => {
      if (settled) return;
      settled = true;
      inFlightMicro -= upperMicro;
      settledMicro += billedMicro;
      settledCalls += 1;
      if (from === "USAGE") billedFromUsage += 1;
      else billedFromUpperBound += 1;
      call.billedMicroUsd = billedMicro;
      call.billedFrom = from;
    };
    const requestName = bound ? `${sequence}-${bound.hash}-call.request.json` : `${sequence}-${fixture.id}-call1.request.json`;
    const responseName = bound ? `${sequence}-${bound.hash}-call.response.json` : `${sequence}-${fixture.id}-call1.response.json`;
    const responseHead = bound
      ? { traceFormatVersion: PACKET_11_HYBRID_CLASS_TRACE_FORMAT_VERSION, kind: "RESPONSE", sequence: attempted, classHash: bound.hash, classFixtureIds: bound.members.map((member) => member.id) }
      : { traceFormatVersion: PACKET_11_HYBRID_TRACE_FORMAT_VERSION, kind: "RESPONSE", fixtureId: fixture.id };
    const spendRecord = () => (ceilingMicro === null ? {} : { spend: { ceilingUsd: ceilingMicro / 1_000_000, billedUsd: (call.billedMicroUsd ?? 0) / 1_000_000, billedFrom: call.billedFrom, committedUsd: settledMicro / 1_000_000 } });
    // Written before transmission: a write failure means the call is never sent (and its reservation is released).
    try {
      await write(
        requestName,
        bound
          ? {
              traceFormatVersion: PACKET_11_HYBRID_CLASS_TRACE_FORMAT_VERSION,
              kind: "REQUEST",
              sequence: attempted,
              classHash: bound.hash,
              classFixtureIds: bound.members.map((member) => member.id),
              recordedAt: new Date(now()).toISOString(),
              endpoint: url,
              method: init.method ?? "GET",
              headers,
              valueBlindness: { passed: true, members: memberChecks.map((check, index) => ({ fixtureId: bound!.members[index]!.id, passed: check.passed, violations: check.violations })), summary: memberChecks[0]!.summary },
              maxOutputTokens: shellMaxOutputTokens(task),
              temperature: SHELL_TEMPERATURE,
              spend: { ceilingUsd: ceilingMicro! / 1_000_000, ...committedBefore, upperBoundUsd: upperMicro / 1_000_000 },
              body: parsedBody,
              bodyText,
              bodyByteCount: bodyBytes.byteLength,
              bodySha256: sha256(bodyBytes),
              inputSha256: call.inputSha256,
            }
          : {
              traceFormatVersion: PACKET_11_HYBRID_TRACE_FORMAT_VERSION,
              kind: "REQUEST",
              fixtureId: fixture.id,
              recordedAt: new Date(now()).toISOString(),
              endpoint: url,
              method: init.method ?? "GET",
              headers,
              valueBlindness: { passed: memberChecks[0]!.passed, violations: memberChecks[0]!.violations, summary: memberChecks[0]!.summary },
              // The fixture task's cap; the checked body carries exactly this value (anything else was refused above).
              maxOutputTokens: shellMaxOutputTokens(task),
              // Rules r7: the shell sampling temperature; the checked body carries exactly this value (anything else was refused above).
              temperature: SHELL_TEMPERATURE,
              body: parsedBody,
              bodyText,
              bodyByteCount: bodyBytes.byteLength,
              bodySha256: sha256(bodyBytes),
            },
      );
    } catch (error) {
      inFlightMicro -= upperMicro;
      call.refusal = "TRACE_WRITE_FAILED";
      throw error;
    }
    call.sequence = attempted;
    const started = monotonic();
    const transmission: { -readonly [K in keyof HybridTransmission]: HybridTransmission[K] } = { endpoint: url, httpStatus: null, transport: "TRANSPORT_FAILED", readResult: "NOT_RECEIVED", byteCount: null, latencyMs: null, status: null, incompleteDetailsPresent: null, returnedModel: null, returnedStorePresent: null, returnedStore: null, usage: null };
    transmissions.push(transmission);
    let response: Response;
    try {
      response = await options.fetcher(url, init);
    } catch (error) {
      transmission.transport = init.signal?.aborted ? "ABORTED" : "TRANSPORT_FAILED";
      transmission.latencyMs = Math.round(monotonic() - started);
      // No readable usage: the call counts at its upper bound.
      settle(upperMicro, "UPPER_BOUND");
      await write(responseName, { ...responseHead, recordedAt: new Date(now()).toISOString(), transport: transmission.transport, latencyMs: transmission.latencyMs, ...spendRecord() });
      throw error;
    }
    let captured: Awaited<ReturnType<typeof capture>>;
    try {
      captured = await capture(response, KIE_MAX_RESPONSE_BYTES);
    } catch (error) {
      settle(upperMicro, "UPPER_BOUND");
      throw error;
    }
    transmission.transport = "RESPONSE_RECEIVED";
    transmission.httpStatus = response.status;
    transmission.readResult = captured.readResult;
    transmission.byteCount = captured.byteCount;
    transmission.latencyMs = Math.round(monotonic() - started);
    const envelope = envelopeOf(captured.bytes);
    transmission.status = statusClass(envelope.evidence.status);
    transmission.incompleteDetailsPresent = envelope.evidence.incompleteDetailsPresent;
    transmission.returnedModel = envelope.evidence.returnedModel;
    transmission.returnedStorePresent = envelope.evidence.returnedStorePresent;
    transmission.returnedStore = envelope.evidence.returnedStore;
    transmission.usage = envelope.evidence.usage;
    // Billed from the reported usage when both counts are readable, else at this call's upper bound.
    const inputTokens = tokenCount(envelope.evidence.usage?.inputTokens);
    const outputTokens = tokenCount(envelope.evidence.usage?.outputTokens);
    if (inputTokens !== null && outputTokens !== null) settle(deepSeekCostMicroUsd(inputTokens, outputTokens), "USAGE");
    else settle(upperMicro, "UPPER_BOUND");
    await write(responseName, {
      ...responseHead,
      recordedAt: new Date(now()).toISOString(),
      transport: transmission.transport,
      httpStatus: transmission.httpStatus,
      contentType: response.headers.get("content-type"),
      readResult: captured.readResult,
      byteCount: captured.byteCount,
      sha256: captured.bytes ? sha256(captured.bytes) : null,
      latencyMs: transmission.latencyMs,
      ...envelope.evidence,
      ...spendRecord(),
      raw: envelope.text ?? (captured.bytes ? Buffer.from(captured.bytes).toString("base64") : null),
    });
    return captured.replay;
  }

  return Object.freeze({
    directory,
    fetcher: tracedFetch,
    checks: () => Object.freeze([...checks]),
    transmissions: () => Object.freeze(transmissions.map((item) => Object.freeze({ ...item }))),
    files: () => Object.freeze([...written]),
    failure: () => failure,
    calls: () => Object.freeze(calls.map((item) => Object.freeze({ ...item }))),
    spend: () => Object.freeze({ ceilingUsd: ceilingMicro === null ? null : ceilingMicro / 1_000_000, committedUsd: settledMicro / 1_000_000, inFlightUsd: inFlightMicro / 1_000_000, settledCalls, billedFromUsage, billedFromUpperBound }),
    record: (name: string, value: unknown) => write(name, value),
  });
}

/** The post-run call map: each transmission bound to a fixture and attempt (sequential harness, concurrency 1). */
export type HybridCallMap =
  | Readonly<{
      kind: "MAPPED";
      invocations: number;
      transmissions: number;
      entries: ReadonlyArray<Readonly<{ sequence: number; fixtureId: string; attempt: number; classHash: string | null }>>;
      refused: ReadonlyArray<Readonly<{ invocation: number; fixtureId: string; attempt: number; refusal: HybridTraceFailureCode | null }>>;
    }>
  | Readonly<{ kind: "MISMATCH"; code: "UNKNOWN_FIXTURE" | "INVOCATION_COUNT" | "SEQUENCE_ORDER" | "PROJECTION_MISMATCH"; at: number | null }>;

/**
 * Maps every traced fetcher invocation to a fixture and attempt, deterministically, from the harness evidence order and
 * each fixture's `attempts` (one fetcher invocation per harness attempt), and asserts that every transmitted call's
 * input text is exactly that fixture's expected projection. Any disagreement is a closed MISMATCH.
 */
export function mapTracedCallsToFixtures(evidence: ReadonlyArray<Readonly<{ fixtureId: string; attempts: number }>>, fixtures: readonly AiEvaluationFixture[], calls: readonly HybridTracedCall[]): HybridCallMap {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const attempts: Array<{ fixture: AiEvaluationFixture; attempt: number }> = [];
  for (const item of evidence) {
    const fixture = byId.get(item.fixtureId);
    if (!fixture || !Number.isInteger(item.attempts) || item.attempts < 0) return { kind: "MISMATCH", code: "UNKNOWN_FIXTURE", at: null };
    for (let attempt = 1; attempt <= item.attempts; attempt += 1) attempts.push({ fixture, attempt });
  }
  if (attempts.length !== calls.length) return { kind: "MISMATCH", code: "INVOCATION_COUNT", at: null };
  const entries: Array<{ sequence: number; fixtureId: string; attempt: number; classHash: string | null }> = [];
  const refused: Array<{ invocation: number; fixtureId: string; attempt: number; refusal: HybridTraceFailureCode | null }> = [];
  for (const [index, call] of calls.entries()) {
    const { fixture, attempt } = attempts[index]!;
    if (call.invocation !== index + 1) return { kind: "MISMATCH", code: "SEQUENCE_ORDER", at: call.invocation };
    if (call.sequence === null) {
      refused.push({ invocation: call.invocation, fixtureId: fixture.id, attempt, refusal: call.refusal });
      continue;
    }
    if (call.sequence !== entries.length + 1) return { kind: "MISMATCH", code: "SEQUENCE_ORDER", at: call.invocation };
    const expected = expectedShellInputText(fixture);
    if (expected === null || call.inputSha256 !== sha256(utf8(expected))) return { kind: "MISMATCH", code: "PROJECTION_MISMATCH", at: call.sequence };
    entries.push({ sequence: call.sequence, fixtureId: fixture.id, attempt, classHash: call.classHash });
  }
  return { kind: "MAPPED", invocations: calls.length, transmissions: entries.length, entries, refused };
}

/** A fixed placeholder for the offline capture fetcher, which never transmits; no credential is read or used. */
const OFFLINE_CAPTURE_TOKEN = "offline-capture-only";
function deepSeekFlashSnapshot() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: () => "2026-10-06T00:00:00.000Z" });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}

/**
 * The exact request body the shared DeepSeek shell adapter builds for a remote-eligible fixture, captured offline (the
 * fetcher records the body and throws; nothing is transmitted). Null when the fixture is unplannable or remote-ineligible
 * (the service makes no call for it).
 */
export async function captureShellRequestBody(fixture: AiEvaluationFixture): Promise<string | null> {
  const planned = plannedOf(fixture);
  if (!planned || planned.plan.remote.eligible !== true) return null;
  const captured: { body: string | null } = { body: null };
  const provider = createDeepSeekShellResponsesProvider({ token: OFFLINE_CAPTURE_TOKEN, model: deepSeekFlashSnapshot(), fetcher: async (_url, init) => {
    captured.body = typeof init.body === "string" ? init.body : null;
    throw new Error("OFFLINE_CAPTURE_ONLY");
  } });
  await provider.invoke(projectShellTaskRequest(planned.plan), new AbortController().signal);
  return captured.body;
}

/**
 * The minimum ceilings a FULL run needs: the sum of the pre-send upper bounds (`estimateMaxUsd`) of the exact bodies the
 * shared builder produces for each remote-eligible fixture, once (one call each) and twice (every fixture repaired), in
 * whole micro-dollars (each bound is already rounded up to the micro-dollar).
 */
export async function minimumFullRunCeilingUsd(fixtures: readonly AiEvaluationFixture[]): Promise<Readonly<{ oneCallEach: number; withAllRepairs: number; eligibleFixtures: number; perFixture: ReadonlyArray<Readonly<{ fixtureId: string; bodyByteCount: number; upperBoundUsd: number }>> }>> {
  let micro = 0;
  const perFixture: Array<{ fixtureId: string; bodyByteCount: number; upperBoundUsd: number }> = [];
  for (const fixture of fixtures) {
    const body = await captureShellRequestBody(fixture);
    if (body === null) continue;
    const bodyByteCount = utf8(body).byteLength;
    const upper = microOfUsd(estimateMaxUsd(bodyByteCount, fixture.taskType as ShellTask).estimatedMaxUsd);
    micro += upper;
    perFixture.push({ fixtureId: fixture.id, bodyByteCount, upperBoundUsd: upper / 1_000_000 });
  }
  return Object.freeze({ oneCallEach: micro / 1_000_000, withAllRepairs: (2 * micro) / 1_000_000, eligibleFixtures: perFixture.length, perFixture: Object.freeze(perFixture) });
}

/**
 * Re-verifies the recorded hashes of a trace: every request's body SHA-256 and byte count against its recorded body
 * text, every response's SHA-256 against its recorded raw body (UTF-8 text or base64). Closed counts only.
 */
export async function verifyTraceHashes(files: readonly string[]): Promise<Readonly<{ filesChecked: number; requestsVerified: number; responsesVerified: number; mismatches: number }>> {
  let requestsVerified = 0;
  let responsesVerified = 0;
  let mismatches = 0;
  for (const file of files) {
    const record = JSON.parse(await readFile(resolve(process.cwd(), file), "utf8")) as { kind?: unknown; bodyText?: unknown; bodySha256?: unknown; bodyByteCount?: unknown; raw?: unknown; sha256?: unknown; bodyEncoding?: unknown };
    if (record.kind === "REQUEST") {
      const bytes = typeof record.bodyText === "string" ? utf8(record.bodyText) : null;
      if (bytes && sha256(bytes) === record.bodySha256 && bytes.byteLength === record.bodyByteCount) requestsVerified += 1;
      else mismatches += 1;
    } else if (record.kind === "RESPONSE" && typeof record.raw === "string") {
      const bytes = record.bodyEncoding === "base64" ? new Uint8Array(Buffer.from(record.raw, "base64")) : utf8(record.raw);
      if (sha256(bytes) === record.sha256) responsesVerified += 1;
      else mismatches += 1;
    }
  }
  return { filesChecked: files.length, requestsVerified, responsesVerified, mismatches };
}

/**
 * Redaction check over the written trace files: the credential (held only in memory, never printed) appears in no
 * file, and every request file's Authorization header is the fixed redacted value.
 */
export async function verifyTraceRedaction(files: readonly string[], secret: string): Promise<Readonly<{ filesChecked: number; secretAbsent: boolean; authorizationRedacted: boolean; filesPrivate: boolean }>> {
  let secretAbsent = secret.length > 0;
  let authorizationRedacted = true;
  let filesPrivate = true;
  const { stat } = await import("node:fs/promises");
  for (const file of files) {
    const path = resolve(process.cwd(), file);
    const text = await readFile(path, "utf8");
    if (text.includes(secret)) secretAbsent = false;
    if (((await stat(path)).mode & 0o077) !== 0) filesPrivate = false;
    const record = JSON.parse(text) as { kind?: unknown; headers?: Record<string, unknown> };
    if (record.kind === "REQUEST" && record.headers?.authorization !== "Bearer [REDACTED]") authorizationRedacted = false;
  }
  return { filesChecked: files.length, secretAbsent, authorizationRedacted, filesPrivate };
}
