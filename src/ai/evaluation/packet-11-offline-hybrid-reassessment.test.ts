// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES } from "@/application/ai/ai-hybrid-runtime-bundles";
import type { AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { defaultShells } from "@/application/ai/language/default-shells";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { AI_LOCALES, type AiLocale, type ShellTask, type ShellTexts } from "@/domain/ai";
import {
  AI_HYBRID_EVALUATION_REPORT_VERSION,
  APPROVED_HYBRID_CONTRACT,
  blockedContentRequiringClassification,
  evaluateHybridModelSnapshot,
  HYBRID_FULL_EVALUATION_POLICY,
  HYBRID_FULL_UTILITY_THRESHOLDS,
  hybridFirstCallValid,
  hybridFullUtilityGates,
  hybridLiveRunVerdict,
  type BlockedContentReview,
  type HumanReviewRecord,
  type HybridEvaluationReport,
  type HybridFixtureEvidence,
} from "./packet-11-hybrid-evaluation";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { hybridFixturesForPhase, PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * Label note (Packet 11C B5 contract freeze): "eval.18" below names the harness LOGIC and policy (hybrid-full-policy.2) this reassessment
 * applies. Since B5 the current harness carries that logic under the label packet11-eval.19, so a run of this file records
 * `reassessedUnder.harness: "packet11-eval.19"`. The record label OFFLINE_REASSESSMENT_UNDER_EVAL_18 and the recorded reassessment of the
 * real stored run are kept unchanged (historical evidence).
 * OFFLINE REASSESSMENT UNDER packet11-eval.18 LOGIC (owner decision 2026-10-07, typed in the owner's own message: "I also authorize a clearly
 * labelled reassessment of the existing 70 stored responses under this corrected definition, without another provider call. Preserve
 * the original FAIL report and trace files."). Decision record: internal-docs/superpowers/decisions/2026-10-07-hybrid-first-call-validity.md.
 *
 * No provider call of any kind: the global fetch is stubbed to throw, and the real DeepSeek shell adapter is given a fake fetcher that
 * answers the n-th transmission with the n-th stored raw response (99-call-map.json order) and refuses any request that is not
 * byte-identical to the stored request (endpoint, method, accept/content-type headers, body). The stored run must be a FULL run under
 * packet11-eval.17 / hybrid-full-policy.1 whose every other contract pin (prompt, bundles, schema, slot plan, rules, request, caps,
 * temperature, fixtures, model, provider) equals the current contract, so the stored responses are exactly the evidence an eval.18
 * run would score. The real hybrid harness (evaluateHybridModelSnapshot, phase FULL, the original limits) re-runs every stored first
 * (and any repair) response through the real strict parser, shell validator, composer, assembler and the r7 composition verifier,
 * rebuilds the evidence, and the eval.18 gates and verdict are computed with the human review and the §16.3 blocked-content
 * classification pending (null), plus a verdict as if both were supplied by the owner as passed / NOT_A_16_3_VIOLATION, labelled
 * HYPOTHETICAL_ARITHMETIC_ONLY. Latency, usage, spend and transport facts are the ORIGINAL run's. The record is labelled
 * OFFLINE_REASSESSMENT_UNDER_EVAL_18, never a live evaluation, never qualifies the model; the original FAIL report and verdict stand
 * unchanged. Every guarded original file is hashed before and after and must stay byte-unchanged. Closed codes only, never model text.
 * The offline tests below always run on synthetic stored runs (temporary directories). The reassessment of the real stored run is
 * skipped unless RUN_OFFLINE_HYBRID_REASSESSMENT=1, and it refuses to start while DEEPSEEK_API_KEY or KIE_API_KEY is set.
 * Owner inputs (optional, both or neither): OFFLINE_HYBRID_REASSESSMENT_HUMAN_REVIEW and OFFLINE_HYBRID_REASSESSMENT_BLOCKED_CONTENT_REVIEW
 * name the owner's recorded human-review counts and §16.3 classifications; the record then also carries the actual verdict, labelled
 * ACTUAL_VERDICT_FROM_OWNER_RECORDS. It stays an offline reassessment and never marks the model qualified.
 */

const OFFLINE_REASSESSMENT_LABEL = "OFFLINE_REASSESSMENT_UNDER_EVAL_18";
const REASSESSMENT_FORMAT = "packet11-offline-reassessment.1";
const HYPOTHETICAL_LABEL = "HYPOTHETICAL_ARITHMETIC_ONLY";
const ACTUAL_LABEL = "ACTUAL_VERDICT_FROM_OWNER_RECORDS";
const DEFAULT_STORED_RUN = "test-results/packet-11-hybrid-live-trace/20261007T102510Z-c0b4b5486e150ba0";
const REASSESSMENT_ROOT = "test-results/packet-11-hybrid-reassessment";
const ORIGINAL_REVIEW_ROOT = "test-results/packet-11-hybrid-review";
/** The contract the stored run was produced under: only these two fields may differ from the current contract (eval.18 logic; label packet11-eval.19 since B5). */
const ORIGINAL_CONTRACT = Object.freeze({ evaluationReportVersion: "packet11-eval.17", fullEvaluationPolicy: "hybrid-full-policy.1" });
const FULL_MAX_CALLS = 140;
/** Never a credential: the fake fetcher never forwards it and nothing reaches the network. */
const REASSESSMENT_TOKEN = "offline-reassessment-no-credential";
const NOW = () => "2026-10-07T12:00:00.000Z";

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}
/** Canonical JSON (sorted object keys), for comparing per-task version maps whatever their key order. */
function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

// ---- The stored run ---------------------------------------------------------------------------------------------------
type StoredRequest = Readonly<{ sequence: number; endpoint: string; method: string; headers: Readonly<Record<string, string>>; bodyText: string; bodySha256: string }>;
type StoredResponse = Readonly<{
  sequence: number; transport: string; httpStatus: number | null; contentType: string | null; readResult: string | null; byteCount: number | null; sha256: string | null; latencyMs: number | null;
  bodyEncoding: string | null; status: string | null; returnedModel: string | null; returnedStore: boolean | null; usage: Readonly<{ inputTokens: number | null; outputTokens: number | null; reasoningTokens?: number | null }> | null;
  spend: Readonly<{ billedUsd: number | null; billedFrom: string | null }> | null; raw: string | null;
}>;
type StoredCall = Readonly<{ sequence: number; fixtureId: string; attempt: number; classHash: string; request: StoredRequest; response: StoredResponse; integrity: readonly string[] }>;
type StoredRun = Readonly<{ directory: string; calls: readonly StoredCall[]; original: HybridEvaluationReport; originalVerdict: unknown; analysisSpend: unknown }>;

/** Reads the call map, the analysis record and every request/response pair, checking each stored hash (closed codes only). */
async function loadStoredRun(directory: string): Promise<StoredRun> {
  const callMap = (JSON.parse(await readFile(join(directory, "99-call-map.json"), "utf8")) as { callMap?: { kind?: string; entries?: Array<{ sequence: number; fixtureId: string; attempt: number; classHash: string }> } }).callMap;
  if (callMap?.kind !== "MAPPED" || !Array.isArray(callMap.entries)) throw new Error("REASSESSMENT_CALL_MAP_NOT_MAPPED");
  const analysis = JSON.parse(await readFile(join(directory, "99-analysis.json"), "utf8")) as { report?: HybridEvaluationReport; verdict?: unknown; spend?: unknown };
  if (!analysis.report) throw new Error("REASSESSMENT_STORED_REPORT_MISSING");
  const calls: StoredCall[] = [];
  for (const [index, entry] of callMap.entries.entries()) {
    const stem = `${String(entry.sequence).padStart(3, "0")}-${entry.classHash}-call`;
    const request = JSON.parse(await readFile(join(directory, `${stem}.request.json`), "utf8")) as StoredRequest;
    const response = JSON.parse(await readFile(join(directory, `${stem}.response.json`), "utf8")) as StoredResponse;
    const integrity: string[] = [];
    if (entry.sequence !== index + 1 || request.sequence !== entry.sequence || response.sequence !== entry.sequence) integrity.push("SEQUENCE");
    if (sha256(request.bodyText) !== request.bodySha256) integrity.push("REQUEST_BODY_HASH");
    if (typeof response.raw === "string" && (sha256(response.raw) !== response.sha256 || Buffer.byteLength(response.raw, "utf8") !== response.byteCount)) integrity.push("RESPONSE_BODY_HASH");
    calls.push({ ...entry, request, response, integrity });
  }
  return { directory, calls, original: analysis.report, originalVerdict: analysis.verdict ?? null, analysisSpend: analysis.spend ?? null };
}

/**
 * The stored run must be FULL, under exactly eval.17 / hybrid-full-policy.1, and match the current contract on every other key (so its
 * stored responses answer exactly the requests an eval.18 run sends). Returns the mismatching keys (closed names).
 */
function sourceContractMismatches(original: HybridEvaluationReport): string[] {
  const mismatches: string[] = [];
  if (original.phase !== "FULL") mismatches.push("phase");
  if (original.reportVersion !== ORIGINAL_CONTRACT.evaluationReportVersion) mismatches.push("reportVersion");
  for (const key of Object.keys(APPROVED_HYBRID_CONTRACT) as Array<keyof typeof APPROVED_HYBRID_CONTRACT>) {
    const expected = key in ORIGINAL_CONTRACT ? ORIGINAL_CONTRACT[key as keyof typeof ORIGINAL_CONTRACT] : APPROVED_HYBRID_CONTRACT[key];
    if (canonical((original.versions as Record<string, unknown> | undefined)?.[key]) !== canonical(expected)) mismatches.push(key);
  }
  return mismatches;
}

type RequestCheck = { invocations: number; compared: number; identical: number; mismatches: Array<{ invocation: number; sequence: number | null; codes: string[] }> };
/**
 * The fake fetcher: the n-th transmission must be byte-identical to the n-th stored request (endpoint, method, accept and content-type
 * headers, body); it is answered with the stored raw response bytes, status and content type. Any other request is refused.
 */
function storedResponseFetcher(calls: readonly StoredCall[]) {
  const check: RequestCheck = { invocations: 0, compared: 0, identical: 0, mismatches: [] };
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    check.invocations += 1;
    const call = calls[check.invocations - 1];
    if (!call) {
      check.mismatches.push({ invocation: check.invocations, sequence: null, codes: ["NO_STORED_CALL"] });
      throw new Error("REASSESSMENT_NO_STORED_CALL");
    }
    check.compared += 1;
    const codes: string[] = [];
    const headers = new Headers(init.headers);
    if (url !== call.request.endpoint) codes.push("ENDPOINT");
    if ((init.method ?? "GET") !== call.request.method) codes.push("METHOD");
    for (const name of ["accept", "content-type"]) if (headers.get(name) !== call.request.headers[name]) codes.push(`HEADER:${name}`);
    if (!/^Bearer \S+$/.test(headers.get("authorization") ?? "")) codes.push("HEADER:authorization");
    if (String(init.body) !== call.request.bodyText) codes.push("BODY");
    if (codes.length > 0) {
      check.mismatches.push({ invocation: check.invocations, sequence: call.sequence, codes });
      throw new Error("REASSESSMENT_REQUEST_MISMATCH");
    }
    check.identical += 1;
    if (call.response.transport !== "RESPONSE_RECEIVED" || typeof call.response.raw !== "string" || call.response.bodyEncoding !== "utf8") throw new Error("REASSESSMENT_STORED_NO_RESPONSE");
    return new Response(call.response.raw, { status: call.response.httpStatus ?? 0, headers: call.response.contentType ? { "content-type": call.response.contentType } : {} });
  };
  return { fetcher, check };
}

const ORIGINAL_FACT_KEYS = ["latencyMs", "timedOutCalls", "inputTokens", "outputTokens", "credits", "retention", "responseModel", "responseAvailability"] as const;
/** The rebuilt evidence with the ORIGINAL run's latency, usage, spend and transport facts (the reassessment's own timings are never used). */
function withOriginalFacts(rebuilt: readonly HybridFixtureEvidence[], original: readonly HybridFixtureEvidence[]) {
  const inconsistent: string[] = [];
  const merged = rebuilt.map((fixture) => {
    const before = original.find((entry) => entry.fixtureId === fixture.fixtureId);
    if (!before || before.attempts !== fixture.attempts) {
      inconsistent.push(fixture.fixtureId);
      return fixture;
    }
    return { ...fixture, ...Object.fromEntries(ORIGINAL_FACT_KEYS.map((key) => [key, before[key]])) } as HybridFixtureEvidence;
  });
  return { merged, inconsistent };
}

// ---- Private writer and hash checks --------------------------------------------------------------------------------------
const stampOf = (now: () => string) => new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Writes a new private file (0600, never overwriting) in a private directory (0700); for the repository root, the root must be Git-ignored. */
async function writePrivate(root: string, name: string, content: string, requireIgnored: boolean): Promise<string> {
  if (requireIgnored) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", `${root}/probe`], { cwd: process.cwd(), stdio: "ignore" });
    } catch {
      throw new Error("REASSESSMENT_ROOT_NOT_IGNORED");
    }
  }
  const directory = resolve(process.cwd(), root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, name);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return path;
}
/** SHA-256 of every file (recursively) under the given directories, by path. */
async function hashTree(directories: readonly string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else hashes.set(path, sha256(await readFile(path)));
    }
  };
  for (const directory of directories) await walk(directory);
  return hashes;
}
async function changedFiles(before: ReadonlyMap<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const [path, hash] of before) {
    try {
      if (sha256(await readFile(path)) !== hash) changed.push(path);
    } catch {
      changed.push(path);
    }
  }
  return changed;
}
const treeDigest = (hashes: ReadonlyMap<string, string>) => sha256([...hashes.entries()].map(([path, hash]) => `${path}\0${hash}`).join("\n"));

// ---- The reassessment ----------------------------------------------------------------------------------------------------
type GateKey = keyof typeof HYBRID_FULL_UTILITY_THRESHOLDS;
const GATE_KEYS = ["firstCallValid", "repairs", "usefulAcceptedOutput", "withinProductionTimeout"] as const satisfies readonly GateKey[];
/** The exact integer comparison behind one gate, written out (numerator × threshold denominator vs threshold numerator × denominator). */
function arithmeticOf(gates: ReturnType<typeof hybridFullUtilityGates>) {
  return Object.fromEntries(GATE_KEYS.map((key) => {
    const gate = gates[key];
    const left = gate.numerator * gate.threshold.denominator;
    const right = gate.threshold.numerator * gate.denominator;
    const operator = gate.comparison === "AT_LEAST" ? "≥" : "≤";
    return [key, { numerator: gate.numerator, denominator: gate.denominator, threshold: gate.threshold, comparison: gate.comparison, check: `${gate.numerator} × ${gate.threshold.denominator} = ${left} ${operator} ${gate.threshold.numerator} × ${gate.denominator} = ${right}`, passed: gate.passed }];
  })) as Record<(typeof GATE_KEYS)[number], { numerator: number; denominator: number; threshold: { numerator: number; denominator: number }; comparison: string; check: string; passed: boolean }>;
}

type OwnerInputs = Readonly<{ humanReview: HumanReviewRecord; blockedContentReview: BlockedContentReview; sources: Readonly<{ humanReview: string; blockedContentReview: string }> }>;
const OWNER_CLASSIFICATIONS = new Set(["GENUINE_16_3_VIOLATION", "NOT_A_16_3_VIOLATION"]);
const isCount = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Loads the owner's human-review counts and §16.3 classifications from their record files; refuses any malformed record. */
async function loadOwnerInputs(humanReviewPath: string, blockedContentReviewPath: string): Promise<OwnerInputs> {
  const human = JSON.parse(await readFile(humanReviewPath, "utf8")) as { humanReview?: unknown };
  const review = human.humanReview;
  if (!isObject(review) || Object.keys(review).length !== AI_LOCALES.length || AI_LOCALES.some((locale) => !isObject(review[locale]) || !isCount((review[locale] as Record<string, unknown>).sampled) || !isCount((review[locale] as Record<string, unknown>).passed))) throw new Error("OWNER_INPUT_HUMAN_REVIEW_INVALID");
  const blocked = JSON.parse(await readFile(blockedContentReviewPath, "utf8")) as { blockedContentReview?: unknown };
  const classifications = blocked.blockedContentReview;
  if (!isObject(classifications) || Object.values(classifications).some((entry) => !isObject(entry) || !OWNER_CLASSIFICATIONS.has(entry.classification as string) || entry.reviewedBy !== "OWNER")) throw new Error("OWNER_INPUT_BLOCKED_CONTENT_REVIEW_INVALID");
  const humanReview = Object.fromEntries(AI_LOCALES.map((locale) => {
    const entry = review[locale] as { sampled: number; passed: number };
    return [locale, { sampled: entry.sampled, passed: entry.passed }];
  })) as HumanReviewRecord;
  const blockedContentReview = Object.fromEntries(Object.entries(classifications).map(([fixtureId, entry]) => [fixtureId, { classification: (entry as { classification: string }).classification, reviewedBy: "OWNER" }])) as BlockedContentReview;
  return { humanReview, blockedContentReview, sources: { humanReview: humanReviewPath, blockedContentReview: blockedContentReviewPath } };
}
type ReassessmentOptions = Readonly<{ storedRun: string; fixtures: readonly AiEvaluationFixture[]; reportRoot: string; requireIgnored: boolean; guardedDirectories: readonly string[]; now?: () => string; ownerInputs?: OwnerInputs | null }>;
/** The whole offline reassessment: load, check, re-run, rebuild, gates and verdicts, private record (pure apart from the one write). */
async function reassessStoredRun(options: ReassessmentOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const before = await hashTree(options.guardedDirectories);
  const stored = await loadStoredRun(options.storedRun);
  const original = stored.original;
  const contractMismatches = sourceContractMismatches(original);
  if (contractMismatches.length > 0) throw new Error(`REASSESSMENT_SOURCE_CONTRACT_MISMATCH:${contractMismatches.join(",")}`);
  if (stored.calls.some((call) => call.integrity.length > 0)) throw new Error("REASSESSMENT_STORED_INTEGRITY");
  // The call map must follow the fixtures in order (first attempts), and name only those fixtures.
  const firstAttempts = stored.calls.filter((call) => call.attempt === 1).map((call) => call.fixtureId);
  if (canonical(firstAttempts) !== canonical(options.fixtures.map((fixture) => fixture.id)) || canonical(original.fixtures.map((fixture) => fixture.fixtureId)) !== canonical(firstAttempts)) throw new Error("REASSESSMENT_CALL_MAP_ORDER");

  const { fetcher, check } = storedResponseFetcher(stored.calls);
  const model = deepSeekFlash();
  const diagnostics: string[] = [];
  let lastDiagnostic: unknown = null;
  // Candidates are never kept: only the harness sees them, and the record carries closed codes only.
  const provider: AiShellProviderPort = createDeepSeekShellResponsesProvider({ token: REASSESSMENT_TOKEN, model, fetcher, onDiagnostic: (diagnostic) => {
    lastDiagnostic = diagnostic;
    diagnostics.push(diagnostic.code);
  } });
  const takeDiagnostic = () => {
    const taken = lastDiagnostic;
    lastDiagnostic = null;
    return taken;
  };
  const ceilingUsd = original.limits.maxCredits;
  const rebuilt = await evaluateHybridModelSnapshot({ model, provider, fixtures: options.fixtures, phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: ceilingUsd, allowRepair: true }, takeDiagnostic, now });
  if (check.mismatches.length > 0 || check.compared !== stored.calls.length || check.invocations !== stored.calls.length) throw new Error("REASSESSMENT_REQUEST_MISMATCH");
  const { merged, inconsistent } = withOriginalFacts(rebuilt.fixtures, original.fixtures);
  if (inconsistent.length > 0) throw new Error("REASSESSMENT_FACTS_INCONSISTENT");
  const report: HybridEvaluationReport = { ...rebuilt, fixtures: merged };

  const gates = hybridFullUtilityGates(merged);
  const blocked = blockedContentRequiringClassification(merged);
  const plan = { phase: "FULL" as const, fixtureIds: options.fixtures.map((fixture) => fixture.id), maxCalls: FULL_MAX_CALLS };
  const approved = { maxCredits: ceilingUsd, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId, responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot };
  const aiPerLocale = Object.fromEntries(AI_LOCALES.map((locale) => [locale, merged.filter((fixture) => fixture.locale === locale && fixture.source === "AI").length])) as Record<AiLocale, number>;
  const hypotheticalHumanReview = Object.fromEntries(AI_LOCALES.map((locale) => [locale, { sampled: aiPerLocale[locale], passed: aiPerLocale[locale] }])) as HumanReviewRecord;
  const hypotheticalBlockedContentReview: BlockedContentReview = Object.fromEntries(blocked.map((entry) => [entry.fixtureId, { classification: "NOT_A_16_3_VIOLATION", reviewedBy: "OWNER" } as const]));
  const outcomeOf = (fixture: HybridFixtureEvidence) => ({ source: fixture.source, outcome: fixture.outcome, reasonCode: fixture.reasonCode, firstRejectedGate: fixture.firstRejectedGate ?? null, attempts: fixture.attempts, safeShellFallback: fixture.safeShellFallback ? `${fixture.safeShellFallback.gate}:${fixture.safeShellFallback.reason}` : null });
  const outcomeDifferences = merged.flatMap((fixture) => {
    const before = original.fixtures.find((entry) => entry.fixtureId === fixture.fixtureId)!;
    return canonical(outcomeOf(before)) === canonical(outcomeOf(fixture)) ? [] : [{ fixtureId: fixture.fixtureId, original: outcomeOf(before), reassessed: outcomeOf(fixture) }];
  });
  const originalCalls = stored.calls.map((call) => ({
    sequence: call.sequence, fixtureId: call.fixtureId, attempt: call.attempt, transport: call.response.transport, httpStatus: call.response.httpStatus, readResult: call.response.readResult, status: call.response.status,
    returnedModel: call.response.returnedModel, returnedStore: call.response.returnedStore, latencyMs: call.response.latencyMs, usage: call.response.usage, billedUsd: call.response.spend?.billedUsd ?? null, billedFrom: call.response.spend?.billedFrom ?? null,
  }));
  const latencies = originalCalls.flatMap((call) => (typeof call.latencyMs === "number" ? [call.latencyMs] : []));
  const changedBeforeWrite = await changedFiles(before);
  const record = {
    kind: OFFLINE_REASSESSMENT_LABEL,
    label: OFFLINE_REASSESSMENT_LABEL,
    formatVersion: REASSESSMENT_FORMAT,
    generatedAt: now(),
    liveEvaluation: false,
    providerCalls: 0,
    modelQualified: false,
    statement: `Offline reassessment of the stored FULL run's ${stored.calls.length} raw responses under ${AI_HYBRID_EVALUATION_REPORT_VERSION} / ${HYBRID_FULL_EVALUATION_POLICY} (spec §16.4 structural first-call validity, owner decision 2026-10-07). No provider was called. The original FAIL report and verdict (${ORIGINAL_CONTRACT.evaluationReportVersion} / ${ORIGINAL_CONTRACT.fullEvaluationPolicy}) stand unchanged. Not a live evaluation; it does not qualify the model. The owner's human review and the owner's §16.3 classification of the blocked fallbacks are pending.`,
    authorization: "Owner decision 2026-10-07 (typed in the owner's own message): reassessment of the existing 70 stored responses under the corrected definition, without another provider call; the original FAIL report and trace files are preserved.",
    decisionRecord: "internal-docs/superpowers/decisions/2026-10-07-hybrid-first-call-validity.md",
    source: {
      storedRun: options.storedRun,
      originalContract: { reportVersion: original.reportVersion, evaluationReportVersion: original.versions.evaluationReportVersion, fullEvaluationPolicy: original.versions.fullEvaluationPolicy, generatedAt: original.generatedAt },
      originalVerdict: stored.originalVerdict,
      originalVerdictStandsUnchanged: true,
      originalUtility: original.utility,
      storedCalls: stored.calls.length,
      requestContractEqualToCurrent: true,
    },
    reassessedUnder: { harness: rebuilt.reportVersion, fullEvaluationPolicy: rebuilt.versions.fullEvaluationPolicy, versions: rebuilt.versions },
    method: {
      fetch: "global fetch stubbed to throw; the real DeepSeek shell adapter used a fake fetcher answering the n-th transmission with the n-th stored raw response (99-call-map.json order)",
      requestEquality: "every request byte-identical to the stored request (endpoint, method, accept/content-type headers, body)",
      pipeline: "real strict parser, shell validator (S1–S7b), composer and assembler (S9), r7 composition verifier (S10), through evaluateHybridModelSnapshot",
      harness: { phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: ceilingUsd, allowRepair: true }, fixtures: options.fixtures.length },
      originalFacts: "latencyMs, timedOutCalls, inputTokens, outputTokens, credits, retention, responseModel and responseAvailability per fixture are the original run's",
    },
    requestCheck: check,
    adapterDiagnosticCodes: diagnostics,
    historicalFacts: {
      note: "Carried over from the original run; never re-measured.",
      spend: stored.analysisSpend,
      totals: original.totals,
      inputTokens: merged.reduce((sum, fixture) => sum + fixture.inputTokens, 0),
      outputTokens: merged.reduce((sum, fixture) => sum + fixture.outputTokens, 0),
      providerLatencyMs: latencies.length > 0 ? { min: Math.min(...latencies), max: Math.max(...latencies) } : null,
      calls: originalCalls,
    },
    reassessedTotals: { calls: rebuilt.totals.calls, repairs: rebuilt.totals.repairs, completed: rebuilt.completed, stoppedReason: rebuilt.stoppedReason, hardGatePassed: rebuilt.hardGatePassed, assemblyInvariantBreaches: rebuilt.assemblyInvariantBreaches },
    outcomeDifferencesFromOriginal: outcomeDifferences,
    perFixture: merged.map((fixture) => {
      const before = original.fixtures.find((entry) => entry.fixtureId === fixture.fixtureId)!;
      return {
        fixtureId: fixture.fixtureId, taskType: fixture.taskType, locale: fixture.locale, source: fixture.source, reasonCode: fixture.reasonCode, attempts: fixture.attempts,
        firstCallReceived: fixture.firstCallReceived, firstCallGate: fixture.firstCallGate, structuralFirstCallValid: hybridFirstCallValid(fixture), originalFirstCallValid: before.firstCallValid,
        usefulAcceptedOutput: fixture.source === "AI" && fixture.reasonCode === "ACCEPTED", safeShellFallback: fixture.safeShellFallback ? { gate: fixture.safeShellFallback.gate, reason: fixture.safeShellFallback.reason } : null,
        requiresBlockedContentClassification: blocked.some((entry) => entry.fixtureId === fixture.fixtureId),
        historical: { latencyMs: fixture.latencyMs, inputTokens: fixture.inputTokens, outputTokens: fixture.outputTokens, credits: fixture.credits, retention: fixture.retention },
      };
    }),
    gates: { reassessed: gates, arithmetic: arithmeticOf(gates), languagePresence: rebuilt.languagePresence },
    blockedContentRequiringClassification: blocked,
    verdict: {
      pending: hybridLiveRunVerdict(report, plan, approved, null, null),
      pendingInputs: { humanReview: null, blockedContentReview: null },
      hypothetical: {
        label: HYPOTHETICAL_LABEL,
        note: "Arithmetic only: the verdict as if the owner had supplied the human review (every accepted AI output sampled and passed) and classified every listed blocked fallback NOT_A_16_3_VIOLATION. Neither was supplied; this is not a verdict and never qualifies the model.",
        humanReview: hypotheticalHumanReview,
        blockedContentReview: hypotheticalBlockedContentReview,
        verdict: hybridLiveRunVerdict(report, plan, approved, hypotheticalHumanReview, hypotheticalBlockedContentReview),
      },
      // The verdict from the owner's recorded inputs, when supplied; still an offline reassessment, and it never marks the model qualified.
      actual: options.ownerInputs
        ? { label: ACTUAL_LABEL, sources: options.ownerInputs.sources, humanReview: options.ownerInputs.humanReview, blockedContentReview: options.ownerInputs.blockedContentReview, verdict: hybridLiveRunVerdict(report, plan, approved, options.ownerInputs.humanReview, options.ownerInputs.blockedContentReview) }
        : null,
    },
    originalFilesUnchanged: { guardedDirectories: options.guardedDirectories, guardedFiles: before.size, treeSha256: treeDigest(before), changedBeforeWrite },
  };
  const name = `${stampOf(now)}-${OFFLINE_REASSESSMENT_LABEL}.json`;
  const reportPath = await writePrivate(options.reportRoot, name, `${JSON.stringify(record, null, 2)}\n`, options.requireIgnored);
  const changedOriginals = await changedFiles(before);
  return { record, reportPath, changedOriginals, guardedFiles: before.size };
}

// ---- Offline tests (synthetic stored runs; always run) -------------------------------------------------------------------
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const SENTINEL_BLOCKED = "哨兵甲乙";
const SENTINEL_LONG = "SENTINEL-OVERLONG-INTRO";
const tokensOf = (text: string) => text.match(/\{\{S\d+\}\}/g) ?? [];
type Fault = "S6" | "S4";
/** A synthetic shell fault built around the default shells' own tokens (no trace content). */
function faultedTexts(fixture: AiEvaluationFixture, texts: Map<string, string>, fault: Fault | undefined) {
  if (fault === "S6") texts.set("evidence", `建议您留意${SENTINEL_BLOCKED}：${tokensOf(texts.get("evidence") ?? "").join("，")}。`);
  if (fault === "S4") {
    const planned = planSlots(fixture.request, AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask]);
    if (planned.kind !== "PLANNED") throw new Error("UNPLANNABLE");
    const path = planned.plan.sections[0]!.introPath;
    texts.set(path, `${texts.get(path) ?? ""} ${SENTINEL_LONG} brings together every note you chose to include for this visit today`);
  }
}
type SyntheticOptions = Readonly<{ faults?: Readonly<Record<string, Fault>>; originalEdit?: (report: HybridEvaluationReport) => HybridEvaluationReport; bodyEdit?: (sequence: number, body: string) => string }>;
/**
 * A synthetic stored FULL run in the tracer's file formats, produced under the "eval.17" labels: request bodies captured from the real
 * adapter (current contract), raw responses wrapping synthetic shell candidates, and an "original" report computed by the current harness
 * then re-labelled to eval.17 / hybrid-full-policy.1 with eval.17's first-call validity (accepted on the first call only).
 */
async function syntheticStoredRun(fixtures: readonly AiEvaluationFixture[], options: SyntheticOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "p11-reassess-"));
  temporary.push(directory);
  const model = deepSeekFlash();
  const entries = [];
  const candidates: unknown[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const bundle = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask];
    const planned = planSlots(fixture.request, bundle);
    if (planned.kind !== "PLANNED") throw new Error("UNPLANNABLE");
    let captured: { url: string; init: RequestInit } | null = null;
    const capture = createDeepSeekShellResponsesProvider({ token: REASSESSMENT_TOKEN, model, fetcher: async (url, init) => {
      captured = { url, init };
      throw new Error("CAPTURE_ONLY");
    } });
    await capture.invoke(projectShellTaskRequest(planned.plan), new AbortController().signal);
    const { url, init } = captured as unknown as { url: string; init: RequestInit };
    const sequence = index + 1;
    const bodyText = options.bodyEdit ? options.bodyEdit(sequence, String(init.body)) : String(init.body);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const texts = new Map(defaultShells(planned.plan)) as Map<string, string>;
    faultedTexts(fixture, texts, options.faults?.[fixture.id]);
    const candidate = shellCandidate(planned.plan, texts as unknown as ShellTexts);
    candidates.push(candidate);
    const raw = JSON.stringify({ id: `resp_${index}`, object: "response", status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(candidate) }] }], usage: { input_tokens: 1600 + index, output_tokens: 120, output_tokens_details: { reasoning_tokens: 0 } } });
    const classHash = sha256(String(index)).slice(0, 8);
    const stem = `${String(sequence).padStart(3, "0")}-${classHash}-call`;
    await writeFile(join(directory, `${stem}.request.json`), JSON.stringify({ sequence, endpoint: url, method: init.method, headers: { ...headers, authorization: "Bearer [REDACTED]" }, bodyText, bodySha256: sha256(bodyText) }));
    await writeFile(join(directory, `${stem}.response.json`), JSON.stringify({ sequence, transport: "RESPONSE_RECEIVED", httpStatus: 200, contentType: "application/json", readResult: "COMPLETE", byteCount: Buffer.byteLength(raw, "utf8"), sha256: sha256(raw), latencyMs: 700 + index, bodyEncoding: "utf8", status: "completed", returnedModel: "deepseek-flash", returnedStore: false, usage: { inputTokens: 1600 + index, outputTokens: 120 }, spend: { billedUsd: 0.0006, billedFrom: "USAGE" }, raw }));
    entries.push({ sequence, fixtureId: fixture.id, attempt: 1, classHash });
  }
  const fakeProvider: AiShellProviderPort = {
    providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" },
    async invoke() {
      return { kind: "COMPLETED", candidate: candidates.shift(), usage: { inputTokens: 1600, outputTokens: 120, costMicroUsd: 600 }, responseModel: "deepseek-flash", retention: "CONFIRMED_NOT_STORED" } as never;
    },
  };
  const base = await evaluateHybridModelSnapshot({ model: { ...model, endpoint: DEEPSEEK_RESPONSES_URL }, provider: fakeProvider, fixtures, phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: 0.25, allowRepair: true }, now: NOW });
  const eval17 = {
    ...base,
    reportVersion: ORIGINAL_CONTRACT.evaluationReportVersion,
    versions: { ...base.versions, ...ORIGINAL_CONTRACT },
    // eval.17 evidence had no first-call gate fields, and counted a first call valid only when it reached accepted AI wording.
    fixtures: base.fixtures.map((fixture, index) => {
      const { firstCallGate: _gate, firstCallReceived: _received, ...rest } = fixture;
      return { ...rest, firstCallValid: fixture.source === "AI" && fixture.attempts === 1, latencyMs: 700 + index, credits: 0.0006, inputTokens: 1600 + index } as unknown as HybridFixtureEvidence;
    }),
  } as HybridEvaluationReport;
  const original = options.originalEdit ? options.originalEdit(eval17) : eval17;
  const verdict = { kind: "FAIL", failures: ["UTILITY:FIRST_CALL_VALID", "HUMAN_REVIEW_PENDING"] };
  await writeFile(join(directory, "99-call-map.json"), JSON.stringify({ kind: "CALL_MAP", callMap: { kind: "MAPPED", invocations: fixtures.length, transmissions: fixtures.length, entries, refused: [] } }));
  await writeFile(join(directory, "99-analysis.json"), JSON.stringify({ kind: "ANALYSIS", spend: { ceilingUsd: 0.25, committedUsd: 0.042 }, report: original, verdict }));
  return { directory };
}
const BLOCKED_A = "p11.explain-pattern.zh-sg.invalid-reference";
const BLOCKED_B = "p11.explain-pattern.zh-sg.forbidden-authority";
const OVER_BUDGET = "p11.draft-care-preparation-summary.en-sg.hidden-limitation";
const stubNetwork = () => {
  const network = vi.fn(() => {
    throw new Error("NETWORK_FORBIDDEN_IN_REASSESSMENT");
  });
  vi.stubGlobal("fetch", network);
  return network;
};

describe("Packet 11 hybrid offline reassessment under eval.18 logic (label packet11-eval.19) (offline, synthetic stored runs)", () => {
  it("reassesses a synthetic 70-response eval.17 run shaped like the stored one (two S6, one S4): exact arithmetic, labels, pending and hypothetical verdicts, private record, originals untouched", async () => {
    const network = stubNetwork();
    const fixtures = hybridFixturesForPhase("FULL");
    expect(fixtures).toHaveLength(70);
    const { directory } = await syntheticStoredRun(fixtures, { faults: { [BLOCKED_A]: "S6", [BLOCKED_B]: "S6", [OVER_BUDGET]: "S4" } });
    const reportRoot = join(directory, "..", `${basename(directory)}-out`);
    temporary.push(reportRoot);
    const result = await reassessStoredRun({ storedRun: directory, fixtures, reportRoot, requireIgnored: false, guardedDirectories: [directory], now: NOW });
    const { record } = result;
    expect(network).not.toHaveBeenCalled();
    expect(record).toMatchObject({ kind: OFFLINE_REASSESSMENT_LABEL, label: OFFLINE_REASSESSMENT_LABEL, liveEvaluation: false, providerCalls: 0, modelQualified: false });
    expect(record.statement).toContain("The original FAIL report and verdict (packet11-eval.17 / hybrid-full-policy.1) stand unchanged");
    expect(record.source).toMatchObject({ storedRun: directory, originalContract: { reportVersion: "packet11-eval.17", evaluationReportVersion: "packet11-eval.17", fullEvaluationPolicy: "hybrid-full-policy.1" }, originalVerdict: { kind: "FAIL", failures: ["UTILITY:FIRST_CALL_VALID", "HUMAN_REVIEW_PENDING"] }, originalVerdictStandsUnchanged: true, storedCalls: 70 });
    // The synthetic reassessment runs the CURRENT harness: eval.18's logic and policy, labelled packet11-eval.19 since the Packet 11C B5
    // contract freeze (label only). The recorded reassessment of the real stored run (under eval.18) is historical evidence, unchanged.
    expect(record.reassessedUnder).toMatchObject({ harness: "packet11-eval.19", fullEvaluationPolicy: "hybrid-full-policy.2" });
    expect(record.requestCheck).toEqual({ invocations: 70, compared: 70, identical: 70, mismatches: [] });
    expect(record.outcomeDifferencesFromOriginal).toEqual([]);
    expect(record.reassessedTotals).toMatchObject({ calls: 70, repairs: 0, completed: true, stoppedReason: null, hardGatePassed: true, assemblyInvariantBreaches: 0 });
    // Per-fixture closed codes: the two S6 fallbacks are structurally valid; the S4 fallback is not; eval.17 counted all three invalid.
    const byFixture = new Map(record.perFixture.map((entry) => [entry.fixtureId, entry]));
    expect(byFixture.get(BLOCKED_A)).toMatchObject({ source: "DETERMINISTIC", reasonCode: "CLINICAL_MEANING_VIOLATION", firstCallReceived: true, firstCallGate: "S6", structuralFirstCallValid: true, originalFirstCallValid: false, usefulAcceptedOutput: false, requiresBlockedContentClassification: true });
    expect(byFixture.get(BLOCKED_B)).toMatchObject({ firstCallGate: "S6", structuralFirstCallValid: true, requiresBlockedContentClassification: true });
    expect(byFixture.get(OVER_BUDGET)).toMatchObject({ source: "DETERMINISTIC", reasonCode: "OUTPUT_BUDGET_EXCEEDED", firstCallGate: "S4", structuralFirstCallValid: false, originalFirstCallValid: false, requiresBlockedContentClassification: false });
    expect(record.perFixture.filter((entry) => entry.source === "AI").every((entry) => entry.structuralFirstCallValid && entry.firstCallGate === null && entry.originalFirstCallValid)).toBe(true);
    // Exact arithmetic under eval.18 (thresholds unchanged).
    expect(record.gates.arithmetic).toEqual({
      firstCallValid: { numerator: 69, denominator: 70, threshold: { numerator: 69, denominator: 70 }, comparison: "AT_LEAST", check: "69 × 70 = 4830 ≥ 69 × 70 = 4830", passed: true },
      repairs: { numerator: 0, denominator: 70, threshold: { numerator: 1, denominator: 70 }, comparison: "AT_MOST", check: "0 × 70 = 0 ≤ 1 × 70 = 70", passed: true },
      usefulAcceptedOutput: { numerator: 67, denominator: 70, threshold: { numerator: 67, denominator: 70 }, comparison: "AT_LEAST", check: "67 × 70 = 4690 ≥ 67 × 70 = 4690", passed: true },
      withinProductionTimeout: { numerator: 70, denominator: 70, threshold: { numerator: 67, denominator: 70 }, comparison: "AT_LEAST", check: "70 × 70 = 4900 ≥ 67 × 70 = 4690", passed: true },
    });
    expect(record.gates.reassessed).toMatchObject({ safeShellFallbacks: { total: 3, byGateAndReason: { "S4:OUTPUT_BUDGET_EXCEEDED": 1, "S6:CLINICAL_MEANING_VIOLATION": 2 } }, hardStopFailures: 0, passed: true });
    expect(record.blockedContentRequiringClassification.map((entry) => [entry.fixtureId, entry.gate, entry.reason])).toEqual([[BLOCKED_A, "S6", "CLINICAL_MEANING_VIOLATION"], [BLOCKED_B, "S6", "CLINICAL_MEANING_VIOLATION"]]);
    // Verdicts: pending (both reviews null) and the clearly labelled hypothetical one (arithmetic only).
    expect(record.verdict.pending).toEqual({ kind: "FAIL", failures: ["HUMAN_REVIEW_PENDING", "BLOCKED_CONTENT_REVIEW_PENDING"] });
    expect(record.verdict.pendingInputs).toEqual({ humanReview: null, blockedContentReview: null });
    expect(record.verdict.hypothetical).toMatchObject({ label: "HYPOTHETICAL_ARITHMETIC_ONLY", humanReview: { "en-SG": { sampled: 34, passed: 34 }, "zh-SG": { sampled: 33, passed: 33 } }, blockedContentReview: { [BLOCKED_A]: { classification: "NOT_A_16_3_VIOLATION", reviewedBy: "OWNER" }, [BLOCKED_B]: { classification: "NOT_A_16_3_VIOLATION", reviewedBy: "OWNER" } }, verdict: { kind: "PASS" } });
    // Historical facts carried over, never re-measured.
    expect(record.historicalFacts).toMatchObject({ spend: { ceilingUsd: 0.25, committedUsd: 0.042 }, providerLatencyMs: { min: 700, max: 769 }, inputTokens: 70 * 1600 + (69 * 70) / 2 });
    expect(record.historicalFacts.calls.map((call) => call.latencyMs)).toEqual(fixtures.map((_fixture, index) => 700 + index));
    expect(record.perFixture.map((entry) => entry.historical.latencyMs)).toEqual(fixtures.map((_fixture, index) => 700 + index));
    expect(record.perFixture.every((entry) => entry.historical.credits === 0.0006 && entry.historical.retention === "CONFIRMED_NOT_STORED")).toBe(true);
    // The private record; nothing in the guarded stored run changed; no model text was written.
    expect(basename(result.reportPath)).toBe("20261007T120000Z-OFFLINE_REASSESSMENT_UNDER_EVAL_18.json");
    expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
    expect((await stat(reportRoot)).mode & 0o777).toBe(0o700);
    expect(result.changedOriginals).toEqual([]);
    expect(record.originalFilesUnchanged).toMatchObject({ guardedFiles: 142, changedBeforeWrite: [] });
    const written = await readFile(result.reportPath, "utf8");
    for (const forbidden of [SENTINEL_BLOCKED, SENTINEL_LONG, "建议您留意", "brings together", "Bearer", REASSESSMENT_TOKEN, "{{S"]) expect(written).not.toContain(forbidden);
    expect(JSON.parse(written)).toEqual(JSON.parse(JSON.stringify(record)));
    // A second write with the same stamp never overwrites.
    await expect(writePrivate(reportRoot, basename(result.reportPath), "x", false)).rejects.toThrow();
  }, 120_000);

  it("computes the actual verdict only from supplied owner inputs (human review counts and §16.3 classifications), loaded and checked from their record files", async () => {
    stubNetwork();
    const fixtures = hybridFixturesForPhase("FULL");
    const { directory } = await syntheticStoredRun(fixtures, { faults: { [BLOCKED_A]: "S6", [BLOCKED_B]: "S6", [OVER_BUDGET]: "S4" } });
    const records = join(directory, "..", `${basename(directory)}-owner`);
    temporary.push(records);
    await mkdir(records, { recursive: true });
    const write = async (name: string, value: unknown) => {
      await writeFile(join(records, name), JSON.stringify(value));
      return join(records, name);
    };
    const notA = { classification: "NOT_A_16_3_VIOLATION", reviewedBy: "OWNER" };
    const human = await write("human.json", { kind: "OWNER_HUMAN_REVIEW", reviewedBy: "OWNER", humanReview: { "en-SG": { sampled: 20, passed: 20 }, "zh-SG": { sampled: 20, passed: 20 } } });
    const blocked = await write("blocked.json", { kind: "OWNER_BLOCKED_CONTENT_REVIEW", decidedBy: "OWNER", blockedContentReview: { [BLOCKED_A]: notA, [BLOCKED_B]: notA } });
    const run = async (ownerInputs: Awaited<ReturnType<typeof loadOwnerInputs>> | null, suffix: string) => {
      const reportRoot = join(directory, "..", `${basename(directory)}-${suffix}`);
      temporary.push(reportRoot);
      return (await reassessStoredRun({ storedRun: directory, fixtures, reportRoot, requireIgnored: false, guardedDirectories: [directory], now: NOW, ownerInputs })).record;
    };
    // No owner inputs: no actual verdict.
    expect((await run(null, "none")).verdict.actual).toBeNull();
    // Both supplied: the actual verdict, with its sources; the record still never marks the model qualified.
    const supplied = await run(await loadOwnerInputs(human, blocked), "actual");
    expect(supplied.verdict.actual).toEqual({
      label: ACTUAL_LABEL,
      sources: { humanReview: human, blockedContentReview: blocked },
      humanReview: { "en-SG": { sampled: 20, passed: 20 }, "zh-SG": { sampled: 20, passed: 20 } },
      blockedContentReview: { [BLOCKED_A]: notA, [BLOCKED_B]: notA },
      verdict: { kind: "PASS" },
    });
    expect(supplied).toMatchObject({ liveEvaluation: false, providerCalls: 0, modelQualified: false });
    expect(supplied.verdict.pending).toEqual({ kind: "FAIL", failures: ["HUMAN_REVIEW_PENDING", "BLOCKED_CONTENT_REVIEW_PENDING"] });
    // A genuine violation fails even though blocked; a sample below 20 is still pending; a failed output fails the review.
    const genuine = await write("genuine.json", { blockedContentReview: { [BLOCKED_A]: notA, [BLOCKED_B]: { classification: "GENUINE_16_3_VIOLATION", reviewedBy: "OWNER" } } });
    expect((await run(await loadOwnerInputs(human, genuine), "genuine")).verdict.actual?.verdict).toEqual({ kind: "FAIL", failures: ["HARD_GATE:BLOCKED_16_3_VIOLATION"] });
    const short = await write("short.json", { humanReview: { "en-SG": { sampled: 19, passed: 19 }, "zh-SG": { sampled: 20, passed: 20 } } });
    expect((await run(await loadOwnerInputs(short, blocked), "short")).verdict.actual?.verdict).toEqual({ kind: "FAIL", failures: ["HUMAN_REVIEW_PENDING"] });
    const failed = await write("failed.json", { humanReview: { "en-SG": { sampled: 20, passed: 20 }, "zh-SG": { sampled: 20, passed: 19 } } });
    expect((await run(await loadOwnerInputs(failed, blocked), "failed")).verdict.actual?.verdict).toEqual({ kind: "FAIL", failures: ["HUMAN_REVIEW_FAILED"] });
    // Malformed records are refused before any reassessment.
    const missingLocale = await write("missing-locale.json", { humanReview: { "en-SG": { sampled: 20, passed: 20 } } });
    await expect(loadOwnerInputs(missingLocale, blocked)).rejects.toThrow("OWNER_INPUT_HUMAN_REVIEW_INVALID");
    const notOwner = await write("not-owner.json", { blockedContentReview: { [BLOCKED_A]: { classification: "NOT_A_16_3_VIOLATION", reviewedBy: "AI" } } });
    await expect(loadOwnerInputs(human, notOwner)).rejects.toThrow("OWNER_INPUT_BLOCKED_CONTENT_REVIEW_INVALID");
    const badClass = await write("bad-class.json", { blockedContentReview: { [BLOCKED_A]: { classification: "PROBABLY_FINE", reviewedBy: "OWNER" } } });
    await expect(loadOwnerInputs(human, badClass)).rejects.toThrow("OWNER_INPUT_BLOCKED_CONTENT_REVIEW_INVALID");
  }, 300_000);

  it("refuses a stored run under any other contract, a stored hash mismatch, a call map out of order and any request that is not byte-identical; nothing is written", async () => {
    stubNetwork();
    const fixtures = [PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === "p11.explain-pattern.en-sg.ordinary")!, PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === "p11.explain-pattern.zh-sg.ordinary")!];
    /** The refusal code of one reassessment attempt; it must never write its record. */
    const attempt = async (directory: string, list = fixtures) => {
      const reportRoot = join(directory, "out");
      const outcome = await reassessStoredRun({ storedRun: directory, fixtures: list, reportRoot, requireIgnored: false, guardedDirectories: [directory], now: NOW }).then(() => "NOT_REFUSED", (error: Error) => error.message);
      await expect(stat(reportRoot)).rejects.toThrow();
      return outcome;
    };
    // A clean synthetic run is accepted (control).
    const ok = await syntheticStoredRun(fixtures);
    const accepted = await reassessStoredRun({ storedRun: ok.directory, fixtures, reportRoot: join(ok.directory, "..", `${basename(ok.directory)}-ok`), requireIgnored: false, guardedDirectories: [ok.directory], now: NOW });
    temporary.push(join(ok.directory, "..", `${basename(ok.directory)}-ok`));
    expect(accepted.record.requestCheck).toEqual({ invocations: 2, compared: 2, identical: 2, mismatches: [] });
    // Other contracts: already eval.18; another prompt; another policy; a SMOKE run.
    const relabel = (change: Record<string, unknown>, top: Record<string, unknown> = {}) => (report: HybridEvaluationReport) => ({ ...report, ...top, versions: { ...report.versions, ...change } }) as HybridEvaluationReport;
    expect(await attempt((await syntheticStoredRun(fixtures, { originalEdit: relabel({ evaluationReportVersion: "packet11-eval.18", fullEvaluationPolicy: "hybrid-full-policy.2" }, { reportVersion: "packet11-eval.18" }) })).directory)).toBe("REASSESSMENT_SOURCE_CONTRACT_MISMATCH:reportVersion,evaluationReportVersion,fullEvaluationPolicy");
    expect(await attempt((await syntheticStoredRun(fixtures, { originalEdit: relabel({ promptVersion: "11b.17" }) })).directory)).toBe("REASSESSMENT_SOURCE_CONTRACT_MISMATCH:promptVersion");
    expect(await attempt((await syntheticStoredRun(fixtures, { originalEdit: relabel({ shellMaxOutputTokens: { EXPLAIN_PATTERN: 512, DRAFT_CARE_PREPARATION_SUMMARY: 512 } }) })).directory)).toBe("REASSESSMENT_SOURCE_CONTRACT_MISMATCH:shellMaxOutputTokens");
    expect(await attempt((await syntheticStoredRun(fixtures, { originalEdit: relabel({}, { phase: "SMOKE" }) })).directory)).toBe("REASSESSMENT_SOURCE_CONTRACT_MISMATCH:phase");
    // A stored body whose hash no longer matches.
    const tampered = await syntheticStoredRun(fixtures);
    const requestFile = (await readdir(tampered.directory)).find((name) => name.startsWith("002-") && name.endsWith(".request.json"))!;
    const stored = JSON.parse(await readFile(join(tampered.directory, requestFile), "utf8"));
    await writeFile(join(tampered.directory, requestFile), JSON.stringify({ ...stored, bodyText: `${stored.bodyText} ` }));
    expect(await attempt(tampered.directory)).toBe("REASSESSMENT_STORED_INTEGRITY");
    // A stored request that differs from today's request bytes (with a consistent hash): refused, never answered.
    expect(await attempt((await syntheticStoredRun(fixtures, { bodyEdit: (sequence, body) => (sequence === 2 ? body.replace('"temperature":0.2', '"temperature":0.3') : body) })).directory)).toBe("REASSESSMENT_REQUEST_MISMATCH");
    // The call map must follow the fixtures in order.
    expect(await attempt((await syntheticStoredRun(fixtures)).directory, [...fixtures].reverse())).toBe("REASSESSMENT_CALL_MAP_ORDER");
  }, 120_000);
});

// ---- The reassessment of the real stored FULL run (env-gated; offline; never a live call) ---------------------------------
describe.runIf(process.env.RUN_OFFLINE_HYBRID_REASSESSMENT === "1")("OFFLINE reassessment of the stored FULL run under eval.18 logic (label packet11-eval.19) (RUN_OFFLINE_HYBRID_REASSESSMENT=1)", () => {
  it("reassesses all 70 stored responses and writes the labelled record; every original trace, report and review file stays byte-unchanged", async () => {
    if (process.env.DEEPSEEK_API_KEY || process.env.KIE_API_KEY) throw new Error("REASSESSMENT_REQUIRES_PROVIDER_KEYS_UNSET");
    const network = stubNetwork();
    const storedRun = process.env.OFFLINE_HYBRID_REASSESSMENT_TRACE || DEFAULT_STORED_RUN;
    const fixtures = hybridFixturesForPhase("FULL");
    // Owner inputs: both record paths or neither.
    const humanReviewPath = process.env.OFFLINE_HYBRID_REASSESSMENT_HUMAN_REVIEW;
    const blockedContentReviewPath = process.env.OFFLINE_HYBRID_REASSESSMENT_BLOCKED_CONTENT_REVIEW;
    if (Boolean(humanReviewPath) !== Boolean(blockedContentReviewPath)) throw new Error("OWNER_INPUTS_INCOMPLETE");
    const ownerInputs = humanReviewPath && blockedContentReviewPath ? await loadOwnerInputs(humanReviewPath, blockedContentReviewPath) : null;
    const result = await reassessStoredRun({ storedRun, fixtures, reportRoot: REASSESSMENT_ROOT, requireIgnored: true, guardedDirectories: [storedRun, ORIGINAL_REVIEW_ROOT], ownerInputs });
    const { record } = result;
    expect(network).not.toHaveBeenCalled();
    expect(result.changedOriginals).toEqual([]);
    expect(record.requestCheck).toMatchObject({ compared: 70, identical: 70, mismatches: [] });
    expect(record.reassessedTotals.calls).toBe(70);
    // Closed summary only (never model text).
    console.log(JSON.stringify({
      label: record.label,
      providerCalls: record.providerCalls,
      globalFetchCalls: network.mock.calls.length,
      source: { storedRun: record.source.storedRun, originalContract: record.source.originalContract, originalVerdict: record.source.originalVerdict, originalVerdictStandsUnchanged: record.source.originalVerdictStandsUnchanged },
      requestCheck: { compared: record.requestCheck.compared, identical: record.requestCheck.identical, mismatches: record.requestCheck.mismatches.length },
      outcomeDifferencesFromOriginal: record.outcomeDifferencesFromOriginal.length,
      arithmetic: Object.fromEntries(GATE_KEYS.map((key) => [key, `${record.gates.arithmetic[key].check} ${record.gates.arithmetic[key].passed ? "PASS" : "FAIL"}`])),
      fallbacks: record.perFixture.filter((entry) => entry.source !== "AI").map((entry) => ({ fixtureId: entry.fixtureId, firstCallGate: entry.firstCallGate, reasonCode: entry.reasonCode, structuralFirstCallValid: entry.structuralFirstCallValid })),
      blockedContentRequiringClassification: record.blockedContentRequiringClassification,
      verdictPending: record.verdict.pending,
      verdictHypothetical: { label: record.verdict.hypothetical.label, verdict: record.verdict.hypothetical.verdict },
      verdictActual: record.verdict.actual ? { label: record.verdict.actual.label, sources: record.verdict.actual.sources, humanReview: record.verdict.actual.humanReview, blockedContentReview: record.verdict.actual.blockedContentReview, verdict: record.verdict.actual.verdict } : null,
      historical: { calls: record.historicalFacts.calls.length, inputTokens: record.historicalFacts.inputTokens, outputTokens: record.historicalFacts.outputTokens, providerLatencyMs: record.historicalFacts.providerLatencyMs, spend: record.historicalFacts.spend },
      report: relative(process.cwd(), result.reportPath),
      guardedOriginalFiles: result.guardedFiles,
      changedOriginals: result.changedOriginals.length,
    }, null, 2));
  }, 300_000);
});
