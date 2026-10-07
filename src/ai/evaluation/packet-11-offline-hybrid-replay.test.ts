// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DEEPSEEK_DOCUMENTED_MODELS, DEEPSEEK_RESPONSES_URL } from "@/ai/deepseek/deepseek-catalogue";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { selectEvaluationCandidates } from "@/ai/kie/kie-route-config";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import type { AiShellProviderPort } from "@/application/ai/ai-provider-port";
import { defaultShells } from "@/application/ai/language/default-shells";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { planSlots } from "@/application/ai/language/slot-planner";
import { AI_LOCALES, type AiLocale, type AiReasonCode, type ShellTask, type ShellTexts } from "@/domain/ai";
import { APPROVED_HYBRID_CONTRACT, evaluateHybridModelSnapshot, hybridFullUtilityGates, hybridLiveRunVerdict, type HumanReviewRecord, type HybridEvaluationReport, type HybridFixtureEvidence } from "./packet-11-hybrid-evaluation";
import type { AiEvaluationFixture } from "./packet-11-fixtures";
import { hybridFixturesForPhase, PACKET_11_HYBRID_FIXTURES } from "./packet-11-hybrid-fixtures";
import { buildHybridHumanReview, escapeReviewHtml, HYBRID_REVIEW_PAGE_PARTS, type HumanReviewEntry, type HumanReviewItem } from "./packet-11-hybrid-human-review";
import { shellCandidate } from "./packet-11-hybrid-test-support";

/**
 * Rules r8 (owner instruction 2026-10-07, offline only): OFFLINE REPLAY of a stored FULL run after the S6 validator correction
 * (ai-shell-rules.11b.15-r8). No provider call of any kind: the global fetch is stubbed to throw, the DeepSeek shell adapter is given
 * a fake fetcher that answers the n-th transmission with the n-th stored raw response (in 99-call-map.json order) and refuses any
 * request that is not byte-identical to the stored request except for the bundle key (@11b.14 → @11b.15). The real adapter and the
 * real hybrid harness (evaluateHybridModelSnapshot, phase FULL, the original limits) recompute acceptance, fallbacks, first-call
 * validity, useful output and every gate under the corrected validator. Latency, usage, spend and transport facts are the ORIGINAL
 * run's (the replay's own timings are never presented). The report is labelled OFFLINE_REPLAY_AFTER_VALIDATOR_CORRECTION, is never a
 * live evaluation and never marks the model qualified; the owner's recorded human review applies to the original run's outputs only.
 * Every original trace, report and review file is hashed before and after and must stay byte-unchanged. Prints closed codes, counts,
 * gates and paths only, never model text.
 * The offline tests below always run on synthetic stored runs (temporary directories). The replay of the real stored run is skipped
 * unless RUN_OFFLINE_HYBRID_REPLAY=1, and it refuses to start while DEEPSEEK_API_KEY or KIE_API_KEY is set.
 */

export const OFFLINE_REPLAY_LABEL = "OFFLINE_REPLAY_AFTER_VALIDATOR_CORRECTION";
const REPLAY_FORMAT = "packet11-offline-replay.1";
const REPLAY_REVIEW_FORMAT = "packet11-offline-replay-review.1";
const STORED_RUN = "test-results/packet-11-hybrid-live-trace/20261006T171832Z-d9f6c556f527f2e5";
const REVIEW_ROOT = "test-results/packet-11-hybrid-review";
const REPLAY_ROOT = "test-results/packet-11-hybrid-replay";
const OWNER_REVIEW_RECORD = `${REVIEW_ROOT}/20261006T171946Z-e41f3745-human-review-record.json`;
const FULL_MAX_CALLS = 140;
/** Never a credential: the fake fetcher never forwards it and nothing reaches the network. */
const REPLAY_TOKEN = "offline-replay-no-credential";
const NOW = () => "2026-10-07T00:00:00.000Z";

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function deepSeekFlash() {
  const selection = selectEvaluationCandidates({ requested: "deepseek-flash", listing: [], documented: DEEPSEEK_DOCUMENTED_MODELS, now: NOW });
  if (selection.kind !== "SELECTED" || selection.candidates.length !== 1) throw new Error("DEEPSEEK_FLASH_NOT_SELECTABLE");
  return selection.candidates[0]!;
}

// ---- The stored run ---------------------------------------------------------------------------------------------------
type StoredRequest = Readonly<{ sequence: number; endpoint: string; method: string; headers: Readonly<Record<string, string>>; bodyText: string; bodySha256: string }>;
type StoredResponse = Readonly<{
  sequence: number; transport: string; httpStatus: number | null; contentType: string | null; readResult: string | null; byteCount: number | null; sha256: string | null; latencyMs: number | null;
  bodyEncoding: string | null; status: string | null; returnedModel: string | null; returnedStore: boolean | null; usage: Readonly<{ inputTokens: number | null; outputTokens: number | null; reasoningTokens?: number | null }> | null;
  spend: Readonly<{ billedUsd: number | null; billedFrom: string | null }> | null; raw: string | null;
}>;
type StoredCall = Readonly<{ sequence: number; fixtureId: string; attempt: number; classHash: string; request: StoredRequest; response: StoredResponse; integrity: readonly string[] }>;
type StoredRun = Readonly<{ directory: string; calls: readonly StoredCall[]; original: HybridEvaluationReport; analysisSpend: unknown; callMapEntries: number }>;

/** Reads the call map, the analysis record and every request/response pair, checking each stored hash (closed codes only). */
async function loadStoredRun(directory: string): Promise<StoredRun> {
  const callMap = (JSON.parse(await readFile(join(directory, "99-call-map.json"), "utf8")) as { callMap?: { kind?: string; entries?: Array<{ sequence: number; fixtureId: string; attempt: number; classHash: string }> } }).callMap;
  if (callMap?.kind !== "MAPPED" || !Array.isArray(callMap.entries)) throw new Error("STORED_CALL_MAP_NOT_MAPPED");
  const analysis = JSON.parse(await readFile(join(directory, "99-analysis.json"), "utf8")) as { report?: HybridEvaluationReport; spend?: unknown };
  if (!analysis.report) throw new Error("STORED_REPORT_MISSING");
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
  return { directory, calls, original: analysis.report, analysisSpend: analysis.spend ?? null, callMapEntries: callMap.entries.length };
}

/** The stored body with its one bundle key rewritten to the current key (null unless exactly one key occurrence exists). */
function rewriteBundleKey(body: string, keys: ReadonlyArray<readonly [string, string]>): string | null {
  const found = keys.map(([from]) => body.split(from).length - 1);
  if (found.reduce((sum, count) => sum + count, 0) !== 1) return null;
  const [from, to] = keys[found.findIndex((count) => count === 1)]!;
  return body.replace(from, () => to);
}
type RequestCheck = { invocations: number; compared: number; identicalExceptBundleKey: number; mismatches: Array<{ invocation: number; sequence: number | null; codes: string[] }> };
/**
 * The fake fetcher: the n-th transmission must be byte-identical to the n-th stored request except for the bundle key (endpoint,
 * method, accept and content-type headers, body); it is answered with the stored raw response bytes, status and content type. Any
 * other request is refused (never answered) with closed codes.
 */
function storedReplayFetcher(calls: readonly StoredCall[], keys: ReadonlyArray<readonly [string, string]>) {
  const check: RequestCheck = { invocations: 0, compared: 0, identicalExceptBundleKey: 0, mismatches: [] };
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    check.invocations += 1;
    const call = calls[check.invocations - 1];
    if (!call) {
      check.mismatches.push({ invocation: check.invocations, sequence: null, codes: ["NO_STORED_CALL"] });
      throw new Error("REPLAY_NO_STORED_CALL");
    }
    check.compared += 1;
    const codes: string[] = [];
    const headers = new Headers(init.headers);
    if (url !== call.request.endpoint) codes.push("ENDPOINT");
    if ((init.method ?? "GET") !== call.request.method) codes.push("METHOD");
    for (const name of ["accept", "content-type"]) if (headers.get(name) !== call.request.headers[name]) codes.push(`HEADER:${name}`);
    if (!/^Bearer \S+$/.test(headers.get("authorization") ?? "")) codes.push("HEADER:authorization");
    const expected = rewriteBundleKey(call.request.bodyText, keys);
    if (expected === null) codes.push("BUNDLE_KEY_NOT_FOUND_ONCE");
    else if (String(init.body) !== expected) codes.push("BODY");
    if (call.integrity.length > 0) codes.push(...call.integrity.map((code) => `STORED:${code}`));
    if (codes.length > 0) {
      check.mismatches.push({ invocation: check.invocations, sequence: call.sequence, codes });
      throw new Error("REPLAY_REQUEST_MISMATCH");
    }
    check.identicalExceptBundleKey += 1;
    if (call.response.transport !== "RESPONSE_RECEIVED" || typeof call.response.raw !== "string" || call.response.bodyEncoding !== "utf8") throw new Error("REPLAY_STORED_NO_RESPONSE");
    return new Response(call.response.raw, { status: call.response.httpStatus ?? 0, headers: call.response.contentType ? { "content-type": call.response.contentType } : {} });
  };
  return { fetcher, check };
}

type Invocation = { completed: boolean; candidate: unknown };
/** Replays the stored run through the real DeepSeek shell adapter and the real hybrid harness (phase FULL, the original limits). */
async function replayStoredRun(stored: StoredRun, options: Readonly<{ fixtures: readonly AiEvaluationFixture[]; ceilingUsd: number; now?: () => string }>) {
  const keys: ReadonlyArray<readonly [string, string]> = [
    [String(stored.original.versions.explainBundle), AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey],
    [String(stored.original.versions.careBundle), AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey],
  ];
  const { fetcher, check } = storedReplayFetcher(stored.calls, keys);
  const model = deepSeekFlash();
  const diagnostics: string[] = [];
  let lastDiagnostic: unknown = null;
  const inner = createDeepSeekShellResponsesProvider({ token: REPLAY_TOKEN, model, fetcher, onDiagnostic: (diagnostic) => {
    lastDiagnostic = diagnostic;
    diagnostics.push(diagnostic.code);
  } });
  // Candidates stay in memory only (for the review page); they are never printed or written to the report.
  const invocations: Invocation[] = [];
  const provider: AiShellProviderPort = {
    providerModel: inner.providerModel,
    async invoke(input, signal) {
      const slot: Invocation = { completed: false, candidate: null };
      invocations.push(slot);
      const result = await inner.invoke(input, signal);
      if (result.kind === "COMPLETED") Object.assign(slot, { completed: true, candidate: result.candidate });
      return result;
    },
  };
  const takeDiagnostic = () => {
    const taken = lastDiagnostic;
    lastDiagnostic = null;
    return taken;
  };
  const report = await evaluateHybridModelSnapshot({ model, provider, fixtures: options.fixtures, phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: options.ceilingUsd, allowRepair: true }, takeDiagnostic, now: options.now ?? NOW });
  return { report, invocations, check, diagnostics, keys };
}

// ---- Before / after ---------------------------------------------------------------------------------------------------
type Outcome = Readonly<{ source: string; outcome: string; reasonCode: string; firstRejectedGate: string | null; fallback: Readonly<{ gate: string; reason: string }> | null; firstCallValid: boolean; attempts: number }>;
const outcomeOf = (fixture: HybridFixtureEvidence): Outcome => ({
  source: fixture.source, outcome: fixture.outcome, reasonCode: fixture.reasonCode, firstRejectedGate: fixture.firstRejectedGate ?? null,
  fallback: fixture.safeShellFallback ? { gate: fixture.safeShellFallback.gate, reason: fixture.safeShellFallback.reason } : null, firstCallValid: fixture.firstCallValid, attempts: fixture.attempts,
});
const ORIGINAL_FACT_KEYS = ["latencyMs", "timedOutCalls", "inputTokens", "outputTokens", "credits", "retention", "responseModel", "responseAvailability"] as const;
/**
 * The replayed evidence with the ORIGINAL run's latency, usage, spend and transport facts (the replay's own timings are never used),
 * when the attempt counts agree; otherwise the fixture is marked and keeps its replayed facts (it is then a reported inconsistency).
 */
function withOriginalFacts(replayed: readonly HybridFixtureEvidence[], original: readonly HybridFixtureEvidence[]) {
  const inconsistent: string[] = [];
  const merged = replayed.map((fixture) => {
    const before = original.find((entry) => entry.fixtureId === fixture.fixtureId);
    if (!before || before.attempts !== fixture.attempts) {
      inconsistent.push(fixture.fixtureId);
      return fixture;
    }
    return { ...fixture, ...Object.fromEntries(ORIGINAL_FACT_KEYS.map((key) => [key, before[key]])) } as HybridFixtureEvidence;
  });
  return { merged, inconsistent };
}
const countsOf = (evidence: readonly HybridFixtureEvidence[]) => {
  const fallbacks = evidence.filter((fixture) => fixture.source !== "AI");
  const byGate: Record<string, number> = {};
  for (const fixture of fallbacks) {
    const key = `${fixture.safeShellFallback?.gate ?? fixture.firstRejectedGate ?? "none"}:${fixture.reasonCode}`;
    byGate[key] = (byGate[key] ?? 0) + 1;
  }
  const perLocale = Object.fromEntries(AI_LOCALES.map((locale) => [locale, { accepted: evidence.filter((fixture) => fixture.locale === locale && fixture.source === "AI").length, fallbacks: fallbacks.filter((fixture) => fixture.locale === locale).length }]));
  return { fixtures: evidence.length, accepted: evidence.length - fallbacks.length, fallbacks: fallbacks.length, fallbacksByGateAndReason: byGate, perLocale };
};
type Change = Readonly<{ fixtureId: string; taskType: string; locale: string; before: Outcome; after: Outcome }>;
function changesOf(original: readonly HybridFixtureEvidence[], replayed: readonly HybridFixtureEvidence[]): Change[] {
  return replayed.flatMap((fixture) => {
    const before = original.find((entry) => entry.fixtureId === fixture.fixtureId);
    if (!before) return [];
    const [a, b] = [outcomeOf(before), outcomeOf(fixture)];
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ fixtureId: fixture.fixtureId, taskType: fixture.taskType, locale: fixture.locale, before: a, after: b }];
  });
}

// ---- The owner's prior human review (of the ORIGINAL run's outputs) ----------------------------------------------------
type OwnerRecord = Readonly<{ humanReview: HumanReviewRecord; failures?: ReadonlyArray<Readonly<{ fixtureId: string; reason: string }>>; run?: Readonly<{ trace?: string }> }>;
export type OwnerPriorReview = Readonly<{ status: "PASSED" | "FAILED" | "NOT_REVIEWED" | "UNDETERMINED"; reason: string | null }>;
/**
 * Per fixture, the owner's review of the ORIGINAL run's output: an originally accepted AI output is PASSED or FAILED (with the
 * recorded reason) when the record sampled every original AI output of its locale (else UNDETERMINED); an original deterministic
 * fallback was not reviewed as AI wording (NOT_REVIEWED).
 */
function ownerPriorReviews(record: OwnerRecord, original: readonly HybridFixtureEvidence[]): Map<string, OwnerPriorReview> {
  const reviews = new Map<string, OwnerPriorReview>();
  const failed = new Map((record.failures ?? []).map((entry) => [entry.fixtureId, entry.reason]));
  for (const fixture of original) {
    if (fixture.source !== "AI") {
      reviews.set(fixture.fixtureId, { status: "NOT_REVIEWED", reason: null });
      continue;
    }
    const locale = fixture.locale as AiLocale;
    const aiInLocale = original.filter((entry) => entry.locale === locale && entry.source === "AI").length;
    const complete = record.humanReview[locale]?.sampled === aiInLocale;
    reviews.set(fixture.fixtureId, !complete ? { status: "UNDETERMINED", reason: null } : failed.has(fixture.fixtureId) ? { status: "FAILED", reason: failed.get(fixture.fixtureId)! } : { status: "PASSED", reason: null });
  }
  return reviews;
}

// ---- The review page ---------------------------------------------------------------------------------------------------
const TASK_NAMES: Readonly<Record<string, string>> = { EXPLAIN_PATTERN: "Pattern explanation", DRAFT_CARE_PREPARATION_SUMMARY: "Care preparation summary" };
const describeOutcome = (outcome: Outcome) => (outcome.source === "AI" ? "AI wording accepted" : `Deterministic fallback · ${outcome.fallback?.gate ?? outcome.firstRejectedGate ?? "none"} · ${outcome.reasonCode}`);
const OWNER_TEXT: Readonly<Record<OwnerPriorReview["status"], string>> = {
  PASSED: "Owner's review of the original run: passed",
  FAILED: "Owner's review of the original run: failed",
  NOT_REVIEWED: "Owner's review of the original run: not reviewed (the original run showed a deterministic fallback for this fixture)",
  UNDETERMINED: "Owner's review of the original run: not determinable from the record",
};
const REPLAY_STYLE = `
.banner { margin: 0 0 20px; padding: 12px 14px; border: 1px solid var(--warn); border-radius: 10px; background: var(--card); font-size: .9rem; }
.banner strong { color: var(--warn); }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.changes { margin: 0 0 20px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); overflow-x: auto; }
.owner { margin: 12px 0 0; font-size: .85rem; color: var(--muted); }
.owner[data-owner-review="FAILED"] { color: var(--warn); }
.changed-note { margin: 6px 0 0; font-size: .85rem; color: var(--warn); }
`;
export type ReplayReviewInput = Readonly<{
  items: readonly HumanReviewItem[];
  changes: readonly Change[];
  owner: ReadonlyMap<string, OwnerPriorReview>;
  generatedAt: string;
  storedRun: string;
  counts: Readonly<{ before: ReturnType<typeof countsOf>; after: ReturnType<typeof countsOf> }>;
}>;
/**
 * The replay review page (pure): every final output under the corrected validation (AI wording or the deterministic fallback shown,
 * with closed codes only), AI wording / fact atoms / approved deterministic wording marked, a compact before/after table of the changed
 * outcomes and, per item, the owner's prior review labelled as the review of the ORIGINAL run. No controls, no script, nothing
 * external, no automated quality judgement.
 */
function buildReplayReview(input: ReplayReviewInput): string {
  const changed = new Map(input.changes.map((change) => [change.fixtureId, change]));
  const card = (item: HumanReviewItem) => {
    const owner = input.owner.get(item.fixtureId) ?? { status: "UNDETERMINED", reason: null };
    const change = changed.get(item.fixtureId);
    const label = item.source === "AI" ? "AI wording, accepted under rules r8" : `Deterministic fallback shown · gate <code>${escapeReviewHtml(item.fallback?.gate ?? "none")}</code> · reason <code>${escapeReviewHtml(item.fallback?.reason ?? "none")}</code>`;
    return [
      `<article class="card${item.source === "AI" ? "" : " fallback"}" data-fixture-id="${escapeReviewHtml(item.fixtureId)}" data-locale="${item.locale}" data-source="${item.source}" data-changed="${change !== undefined}" data-owner-review="${owner.status}">`,
      `<header><h3>${escapeReviewHtml(item.fixtureId)}</h3><span class="pill">${TASK_NAMES[item.taskType]} · ${item.locale}</span></header>`,
      `<p class="codes">${label}</p>`,
      change ? `<p class="changed-note">Outcome changed by the correction — original run: ${escapeReviewHtml(describeOutcome(change.before))}</p>` : "",
      item.blocks.map((block) => HYBRID_REVIEW_PAGE_PARTS.renderBlock(block, item.locale)).join(""),
      `<p class="owner" data-owner-review="${owner.status}">${escapeReviewHtml(OWNER_TEXT[owner.status])}${owner.reason ? ` (<code>${escapeReviewHtml(owner.reason)}</code>)` : ""}</p>`,
      "</article>",
    ].join("");
  };
  const rows = input.changes.map((change) => `<tr data-fixture-id="${escapeReviewHtml(change.fixtureId)}"><td>${escapeReviewHtml(change.fixtureId)}</td><td>${escapeReviewHtml(change.locale)}</td><td>${escapeReviewHtml(TASK_NAMES[change.taskType] ?? change.taskType)}</td><td>${escapeReviewHtml(describeOutcome(change.before))}</td><td>${escapeReviewHtml(describeOutcome(change.after))}</td></tr>`).join("");
  const sections = AI_LOCALES.map((locale) => {
    const ai = input.items.filter((item) => item.locale === locale && item.source === "AI");
    const shown = input.items.filter((item) => item.locale === locale && item.source !== "AI");
    return `<h2>${locale} · ${ai.length} AI outputs · ${shown.length} deterministic fallbacks shown</h2>${[...ai, ...shown].map(card).join("")}`;
  }).join("");
  const count = (side: "before" | "after") => AI_LOCALES.map((locale) => `${locale} ${input.counts[side].perLocale[locale]!.accepted} AI / ${input.counts[side].perLocale[locale]!.fallbacks} fallback`).join(" · ");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    "<title>Hybrid Offline Replay</title>",
    `<style>${HYBRID_REVIEW_PAGE_PARTS.style}${REPLAY_STYLE}</style></head><body>`,
    `<main data-format="${REPLAY_REVIEW_FORMAT}" data-label="${OFFLINE_REPLAY_LABEL}" data-ai="${input.counts.after.accepted}" data-fallbacks="${input.counts.after.fallbacks}" data-changed="${input.changes.length}">`,
    "<h1>Offline replay after the S6 validator correction · final wording</h1>",
    `<p class="banner"><strong>${OFFLINE_REPLAY_LABEL}</strong> — not a live evaluation, and the model is not qualified by it. No provider was called: the stored responses of the original FULL run (<code>${escapeReviewHtml(input.storedRun)}</code>) were re-validated offline with ${escapeReviewHtml(AI_HYBRID_VERSIONS.shellRules)}. Latency, usage and spend are the original run's. The owner's review shown on each item is the owner's review of the ORIGINAL run's output.</p>`,
    `<p class="sub">Synthetic fixtures only · generated ${escapeReviewHtml(input.generatedAt)} · ${escapeReviewHtml(`${AI_HYBRID_VERSIONS.shellRules} · ${AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey} / ${AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey} · ${AI_HYBRID_VERSIONS.fixtureSet} · ${AI_HYBRID_VERSIONS.evaluationReport}`)}. Every final user-visible output is listed; fallbacks carry closed gate and reason codes only (never rejected model text).</p>`,
    '<div class="legend"><span><span class="ai">AI shell wording</span></span><span><span class="fact">fact atom (deterministic)</span></span><span><span class="det">deterministic approved wording (limitation copy, headings, fallback text)</span></span></div>',
    `<section class="counts"><p data-counts="before">Original run: ${input.counts.before.accepted} AI outputs, ${input.counts.before.fallbacks} deterministic fallbacks (${escapeReviewHtml(count("before"))})</p><p data-counts="after">Replay under rules r8: ${input.counts.after.accepted} AI outputs, ${input.counts.after.fallbacks} deterministic fallbacks (${escapeReviewHtml(count("after"))})</p></section>`,
    `<section class="changes"><h2>Outcomes changed by the correction (${input.changes.length})</h2><table><thead><tr><th>Fixture</th><th>Locale</th><th>Task</th><th>Original run</th><th>Replay (r8)</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    sections,
    "</main>",
    "</body></html>",
  ].join("\n");
}

// ---- Private writers and hash checks -------------------------------------------------------------------------------------
const stampOf = (now: () => string) => new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Writes a new private file (0600, never overwriting) in a private directory (0700); for the repository roots, the root must be Git-ignored. */
async function writePrivate(root: string, name: string, content: string, requireIgnored: boolean): Promise<string> {
  if (requireIgnored) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", `${root}/probe`], { cwd: process.cwd(), stdio: "ignore" });
    } catch {
      throw new Error("REPLAY_ROOT_NOT_IGNORED");
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
const unchangedFiles = async (before: ReadonlyMap<string, string>) => {
  const changed: string[] = [];
  for (const [path, hash] of before) {
    try {
      if (sha256(await readFile(path)) !== hash) changed.push(path);
    } catch {
      changed.push(path);
    }
  }
  return changed;
};

/** The review entries (as the FULL runner builds them): AI fixtures with their last-attempt candidate, others with closed codes. */
function reviewEntries(evidence: readonly HybridFixtureEvidence[], fixtures: readonly AiEvaluationFixture[], invocations: readonly Invocation[]): HumanReviewEntry[] {
  const entries: HumanReviewEntry[] = [];
  let index = 0;
  for (const item of evidence) {
    const fixture = fixtures.find((entry) => entry.id === item.fixtureId)!;
    const last = invocations[index + item.attempts - 1];
    if (item.source === "AI" && item.attempts > 0 && last?.completed) entries.push({ fixture, candidate: last.candidate });
    else if (item.source !== "AI") entries.push({ fixture, fallback: { gate: item.safeShellFallback?.gate ?? item.firstRejectedGate ?? null, reason: item.reasonCode as AiReasonCode } });
    index += item.attempts;
  }
  return entries;
}

/** The whole offline replay: load, replay, compare, gates and verdicts, review page and report (pure apart from the two writes). */
async function runOfflineReplay(options: Readonly<{ storedRun: string; fixtures: readonly AiEvaluationFixture[]; ownerRecord: OwnerRecord | null; ownerRecordPath: string | null; reportRoot: string; reviewRoot: string; requireIgnored: boolean; guardedDirectories: readonly string[]; now?: () => string }>) {
  const now = options.now ?? (() => new Date().toISOString());
  const before = await hashTree(options.guardedDirectories);
  const stored = await loadStoredRun(options.storedRun);
  const original = stored.original;
  const ceilingUsd = original.limits.maxCredits;
  const replay = await replayStoredRun(stored, { fixtures: options.fixtures, ceilingUsd, now });
  const { merged, inconsistent } = withOriginalFacts(replay.report.fixtures, original.fixtures);
  const report: HybridEvaluationReport = { ...replay.report, fixtures: merged };
  const plan = { phase: "FULL" as const, fixtureIds: options.fixtures.map((fixture) => fixture.id), maxCalls: FULL_MAX_CALLS };
  const approved = { maxCredits: ceilingUsd, requestModelId: APPROVED_HYBRID_CONTRACT.requestModelId, responseModelSnapshot: APPROVED_HYBRID_CONTRACT.responseModelSnapshot };
  const changes = changesOf(original.fixtures, replay.report.fixtures);
  const counts = { before: countsOf(original.fixtures), after: countsOf(replay.report.fixtures) };
  const owner = options.ownerRecord ? ownerPriorReviews(options.ownerRecord, original.fixtures) : new Map<string, OwnerPriorReview>();
  const review = buildHybridHumanReview(reviewEntries(replay.report.fixtures, options.fixtures, replay.invocations), { generatedAt: now() });
  const html = buildReplayReview({ items: review.items, changes, owner, generatedAt: now(), storedRun: options.storedRun, counts });
  const stamp = stampOf(now);
  const reviewPath = await writePrivate(options.reviewRoot, `${stamp}-offline-replay-review.html`, html, options.requireIgnored);
  const originalCalls = stored.calls.map((call) => ({
    sequence: call.sequence, fixtureId: call.fixtureId, attempt: call.attempt, transport: call.response.transport, httpStatus: call.response.httpStatus, readResult: call.response.readResult, status: call.response.status,
    returnedModel: call.response.returnedModel, returnedStore: call.response.returnedStore, latencyMs: call.response.latencyMs, usage: call.response.usage, billedUsd: call.response.spend?.billedUsd ?? null, billedFrom: call.response.spend?.billedFrom ?? null,
  }));
  const record = {
    kind: OFFLINE_REPLAY_LABEL,
    label: OFFLINE_REPLAY_LABEL,
    formatVersion: REPLAY_FORMAT,
    generatedAt: now(),
    liveEvaluation: false,
    providerCallsMade: 0,
    modelQualified: false,
    statement: "Offline replay of the stored FULL run's raw responses after the S6 validator correction (rules r8). Not a live evaluation; it does not qualify the model. Latency, usage, spend and transport facts are the original run's; the owner's human review applies to the original run's outputs only.",
    source: { storedRun: options.storedRun, originalReportVersion: original.reportVersion, originalGeneratedAt: original.generatedAt, originalVersions: original.versions, callMapEntries: stored.callMapEntries, storedCalls: stored.calls.length, storedIntegrityFailures: stored.calls.filter((call) => call.integrity.length > 0).map((call) => ({ sequence: call.sequence, codes: call.integrity })) },
    correction: {
      shellRules: { before: original.versions.shellRulesRevision, after: AI_HYBRID_VERSIONS.shellRules },
      bundles: { before: [original.versions.explainBundle, original.versions.careBundle], after: [AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.bundleKey, AI_HYBRID_RUNTIME_BUNDLES.DRAFT_CARE_PREPARATION_SUMMARY.bundleKey] },
      validatorComponent: AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN.validatorProfile.version,
      fixtureSet: { before: original.versions.fixtureSetRevision, after: AI_HYBRID_VERSIONS.fixtureSet },
      harness: { before: original.reportVersion, after: replay.report.reportVersion },
      unchanged: { prompt: AI_HYBRID_VERSIONS.prompt, shellRequest: AI_HYBRID_VERSIONS.shellRequest, fullEvaluationPolicy: replay.report.versions.fullEvaluationPolicy, maxOutputTokens: replay.report.versions.shellMaxOutputTokens, temperature: replay.report.versions.shellTemperature },
    },
    method: {
      fetch: "global fetch stubbed to throw; the DeepSeek shell adapter used a fake fetcher answering the n-th transmission with the n-th stored raw response (99-call-map.json order)",
      requestEquality: "every request byte-identical to the stored request except the one bundle key (endpoint, method, accept/content-type headers, body)",
      harness: { phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: ceilingUsd, allowRepair: true }, fixtures: options.fixtures.length },
      originalFacts: "latencyMs, timedOutCalls, inputTokens, outputTokens, credits, retention, responseModel and responseAvailability per fixture are the original run's",
    },
    requestCheck: replay.check,
    adapterDiagnosticCodes: replay.diagnostics,
    originalFacts: { spend: stored.analysisSpend, totals: original.totals, calls: originalCalls },
    replayTotals: { calls: replay.report.totals.calls, repairs: replay.report.totals.repairs, creditsFromStoredUsage: replay.report.totals.credits, completed: replay.report.completed, stoppedReason: replay.report.stoppedReason, hardGatePassed: replay.report.hardGatePassed, assemblyInvariantBreaches: replay.report.assemblyInvariantBreaches },
    factsInconsistentFixtures: inconsistent,
    perFixture: replay.report.fixtures.map((fixture) => {
      const before = original.fixtures.find((entry) => entry.fixtureId === fixture.fixtureId)!;
      const ownerReview = owner.get(fixture.fixtureId) ?? null;
      return { fixtureId: fixture.fixtureId, taskType: fixture.taskType, locale: fixture.locale, original: outcomeOf(before), replay: outcomeOf(fixture), changed: changes.some((change) => change.fixtureId === fixture.fixtureId), originalFacts: Object.fromEntries(ORIGINAL_FACT_KEYS.map((key) => [key, before[key]])), ownerReviewOfOriginalRun: ownerReview };
    }),
    counts,
    changes,
    remainingFallbacks: replay.report.fixtures.filter((fixture) => fixture.source !== "AI").map((fixture) => ({ fixtureId: fixture.fixtureId, locale: fixture.locale, taskType: fixture.taskType, gate: fixture.safeShellFallback?.gate ?? fixture.firstRejectedGate ?? null, reason: fixture.reasonCode })),
    gates: {
      original: original.utility,
      replayWithOriginalFacts: hybridFullUtilityGates(merged),
      languagePresence: { original: original.languagePresence, replay: replay.report.languagePresence },
    },
    verdict: {
      pendingHumanReview: hybridLiveRunVerdict(report, plan, approved, null),
      withOwnerRecordOfOriginalRun: options.ownerRecord ? hybridLiveRunVerdict(report, plan, approved, options.ownerRecord.humanReview) : null,
      ownerRecord: options.ownerRecordPath,
      ownerRecordAppliesTo: "THE_ORIGINAL_RUN_OUTPUTS_ONLY",
      ownerRecordHumanReview: options.ownerRecord?.humanReview ?? null,
      newlyAcceptedOutputsWithoutOwnerReview: changes.filter((change) => change.after.source === "AI" && change.before.source !== "AI").map((change) => change.fixtureId),
      note: "A replay verdict never qualifies the model; any qualification needs a live FULL run under the corrected contract and the owner's review of its outputs.",
    },
    review: { path: relative(process.cwd(), reviewPath), formatVersion: REPLAY_REVIEW_FORMAT, aiItems: review.included, fallbackItems: review.fallbacks, excluded: review.excluded, exclusions: review.exclusions },
  };
  const reportPath = await writePrivate(options.reportRoot, `${stamp}-offline-replay.json`, `${JSON.stringify(record, null, 2)}\n`, options.requireIgnored);
  const changedOriginals = await unchangedFiles(before);
  return { record, reportPath, reviewPath, html, changedOriginals, guardedFiles: before.size, replay, review };
}

// ---- Offline tests (synthetic stored runs; always run) -------------------------------------------------------------------
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const SENTINEL_REJECTED = "哨兵乙丙";
type SyntheticCall = Readonly<{ fixtureId: string; texts?: Readonly<Record<string, string>>; raw?: string }>;
/** A synthetic stored run (same file formats as the tracer) whose bodies carry the previous bundle keys (@11b.14). */
async function syntheticStoredRun(calls: readonly SyntheticCall[], originalEdit: (report: HybridEvaluationReport) => HybridEvaluationReport) {
  const directory = mkdtempSync(join(tmpdir(), "p11-replay-"));
  temporary.push(directory);
  const model = deepSeekFlash();
  const fixtures = calls.map((call) => PACKET_11_HYBRID_FIXTURES.find((entry) => entry.id === call.fixtureId)!);
  const entries = [];
  const candidates: unknown[] = [];
  for (const [index, call] of calls.entries()) {
    const fixture = fixtures[index]!;
    const bundle = AI_HYBRID_RUNTIME_BUNDLES[fixture.taskType as ShellTask];
    const planned = planSlots(fixture.request, bundle);
    if (planned.kind !== "PLANNED") throw new Error("UNPLANNABLE");
    let captured: { url: string; init: RequestInit } | null = null;
    const capture = createDeepSeekShellResponsesProvider({ token: REPLAY_TOKEN, model, fetcher: async (url, init) => {
      captured = { url, init };
      throw new Error("CAPTURE_ONLY");
    } });
    await capture.invoke(projectShellTaskRequest(planned.plan), new AbortController().signal);
    const { url, init } = captured as unknown as { url: string; init: RequestInit };
    const previous = bundle.bundleKey.replace(/@11b\.\d+$/, "@11b.14");
    const bodyText = String(init.body).replace(bundle.bundleKey, previous);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const texts = new Map(defaultShells(planned.plan)) as Map<string, string>;
    for (const [path, text] of Object.entries(call.texts ?? {})) texts.set(path, text);
    const candidate = shellCandidate(planned.plan, texts as unknown as ShellTexts);
    candidates.push(candidate);
    const raw = call.raw ?? JSON.stringify({ id: `resp_${index}`, object: "response", status: "completed", model: "deepseek-flash", store: false, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(candidate) }] }], usage: { input_tokens: 1500, output_tokens: 120, output_tokens_details: { reasoning_tokens: 0 } } });
    const sequence = index + 1;
    const classHash = sha256(String(index)).slice(0, 8);
    const stem = `${String(sequence).padStart(3, "0")}-${classHash}-call`;
    await writeFile(join(directory, `${stem}.request.json`), JSON.stringify({ sequence, endpoint: url, method: init.method, headers: { ...headers, authorization: "Bearer [REDACTED]" }, bodyText, bodySha256: sha256(bodyText) }));
    await writeFile(join(directory, `${stem}.response.json`), JSON.stringify({ sequence, transport: "RESPONSE_RECEIVED", httpStatus: 200, contentType: "application/json", readResult: "COMPLETE", byteCount: Buffer.byteLength(raw, "utf8"), sha256: sha256(raw), latencyMs: 4321 + index, bodyEncoding: "utf8", status: "completed", returnedModel: "deepseek-flash", returnedStore: false, usage: { inputTokens: 1500, outputTokens: 120 }, spend: { billedUsd: 0.0006, billedFrom: "USAGE" }, raw }));
    entries.push({ sequence, fixtureId: fixture.id, attempt: 1, classHash });
  }
  // The "original" report: the same candidates through the current harness, then edited to what the earlier rules recorded.
  const fakeProvider: AiShellProviderPort = {
    providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" },
    async invoke() {
      const candidate = candidates.shift();
      return { kind: "COMPLETED", candidate, usage: { inputTokens: 1500, outputTokens: 120, costMicroUsd: 600 }, responseModel: "deepseek-flash", retention: "CONFIRMED_NOT_STORED" } as never;
    },
  };
  const base = await evaluateHybridModelSnapshot({ model: { ...model, endpoint: DEEPSEEK_RESPONSES_URL }, provider: fakeProvider, fixtures, phase: "FULL", limits: { maxCalls: FULL_MAX_CALLS, maxCredits: 0.25, allowRepair: true }, now: NOW });
  const original = originalEdit({ ...base, versions: { ...base.versions, explainBundle: "ai.explain-pattern@11b.14", careBundle: "ai.draft-care-preparation-summary@11b.14", shellRulesRevision: "ai-shell-rules.11b.14-r7" }, fixtures: base.fixtures.map((fixture, index) => ({ ...fixture, latencyMs: 4321 + index, credits: 0.000611, timedOutCalls: index === 0 ? 1 : 0 })) });
  await writeFile(join(directory, "99-call-map.json"), JSON.stringify({ kind: "CALL_MAP", callMap: { kind: "MAPPED", invocations: calls.length, transmissions: calls.length, entries, refused: [] } }));
  await writeFile(join(directory, "99-analysis.json"), JSON.stringify({ kind: "ANALYSIS", spend: { ceilingUsd: 0.25, committedUsd: 0.0018 }, report: original }));
  return { directory, fixtures };
}
const asS6Fallback = (fixtureId: string) => (report: HybridEvaluationReport): HybridEvaluationReport => ({
  ...report,
  fixtures: report.fixtures.map((fixture) => (fixture.fixtureId !== fixtureId ? fixture : ({ ...fixture, source: "DETERMINISTIC", outcome: "FALLBACK", reasonCode: "CLINICAL_MEANING_VIOLATION", firstRejectedGate: "S6", firstCallValid: false, safeShellFallback: { gate: "S6", reason: "CLINICAL_MEANING_VIOLATION", integrity: null, lexical: null, register: null, quality: null, clinicalLabel: null, rejections: [] } } as unknown as HybridFixtureEvidence))),
});
const ZH_COLLISION = "p11.explain-pattern.zh-sg.prompt-injection";
const ZH_ORDINARY = "p11.explain-pattern.zh-sg.ordinary";
const EN_ORDINARY = "p11.explain-pattern.en-sg.ordinary";

describe("Packet 11 hybrid offline replay after the S6 validator correction (offline, synthetic stored runs)", () => {
  it("replays stored raw responses through the real adapter and harness with zero network: bundle-key-only request differences, recomputed outcomes, original facts, private report and review", async () => {
    const network = vi.fn(() => {
      throw new Error("NETWORK_FORBIDDEN_IN_REPLAY");
    });
    vi.stubGlobal("fetch", network);
    const { directory, fixtures } = await syntheticStoredRun([
      { fixtureId: EN_ORDINARY },
      // Observation ownership (@11b.8): the model writes the headline and evidence only, so the synthetic model texts sit in the evidence
      // (the stand-in collision 相应 + {{S4}} and the model-written token split 应{{S3}}该).
      { fixtureId: ZH_COLLISION, texts: { evidence: "以上内容相应{{S4}}整理。" } },
      { fixtureId: ZH_ORDINARY, texts: { evidence: `应{{S3}}该记录${SENTINEL_REJECTED}。` } },
    ], asS6Fallback(ZH_COLLISION));
    const roots = { report: join(directory, "replay"), review: join(directory, "review") };
    await mkdir(roots.review, { recursive: true });
    await writeFile(join(roots.review, "owner-record.json"), "{}");
    const owner: OwnerRecord = { humanReview: { "en-SG": { sampled: 1, passed: 0 }, "zh-SG": { sampled: 0, passed: 0 } }, failures: [{ fixtureId: EN_ORDINARY, reason: "LANGUAGE_NATURALNESS" }] };
    const result = await runOfflineReplay({ storedRun: directory, fixtures, ownerRecord: owner, ownerRecordPath: "owner-record.json", reportRoot: roots.report, reviewRoot: roots.review, requireIgnored: false, guardedDirectories: [directory], now: NOW });
    expect(network).not.toHaveBeenCalled();
    expect(result.record).toMatchObject({ kind: OFFLINE_REPLAY_LABEL, label: OFFLINE_REPLAY_LABEL, liveEvaluation: false, providerCallsMade: 0, modelQualified: false });
    expect(result.record.requestCheck).toEqual({ invocations: 3, compared: 3, identicalExceptBundleKey: 3, mismatches: [] });
    // The collision is now accepted; the model-written token split still falls back at S6; the ordinary en output is unchanged.
    expect(result.record.changes.map((change) => [change.fixtureId, change.before.source, change.after.source])).toEqual([[ZH_COLLISION, "DETERMINISTIC", "AI"]]);
    expect(result.record.remainingFallbacks).toEqual([{ fixtureId: ZH_ORDINARY, locale: "zh-SG", taskType: "EXPLAIN_PATTERN", gate: "S6", reason: "CLINICAL_MEANING_VIOLATION" }]);
    expect(result.record.counts.before).toMatchObject({ accepted: 1, fallbacks: 2 });
    expect(result.record.counts.after).toMatchObject({ accepted: 2, fallbacks: 1, fallbacksByGateAndReason: { "S6:CLINICAL_MEANING_VIOLATION": 1 } });
    // Original facts are carried (never the replay's own timings).
    expect(result.record.perFixture.map((fixture) => fixture.originalFacts.latencyMs)).toEqual([4321, 4322, 4323]);
    expect(result.record.originalFacts.calls.map((call) => call.latencyMs)).toEqual([4321, 4322, 4323]);
    // The gates are recomputed with the original facts (a synthetic original timeout on the first fixture), never the replay's timings.
    expect(result.record.gates.replayWithOriginalFacts.withinProductionTimeout).toMatchObject({ numerator: 2, denominator: 3 });
    expect(result.record.perFixture.map((fixture) => fixture.originalFacts.timedOutCalls)).toEqual([1, 0, 0]);
    expect(result.record.verdict.newlyAcceptedOutputsWithoutOwnerReview).toEqual([ZH_COLLISION]);
    expect(result.record.verdict.ownerRecordAppliesTo).toBe("THE_ORIGINAL_RUN_OUTPUTS_ONLY");
    expect(result.record.perFixture.map((fixture) => fixture.ownerReviewOfOriginalRun?.status)).toEqual(["FAILED", "NOT_REVIEWED", "NOT_REVIEWED"]);
    // Private files; nothing in the guarded stored run changed.
    for (const path of [result.reportPath, result.reviewPath]) expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(result.changedOriginals).toEqual([]);
    const written = await readFile(result.reportPath, "utf8");
    expect(written).not.toContain(SENTINEL_REJECTED);
    expect(written).not.toContain("以上内容相应");
    // The review page: final outputs only, the before/after row, owner reviews labelled as the original run's, no controls or script.
    const html = result.html;
    expect(html).toContain(OFFLINE_REPLAY_LABEL);
    expect(html).toContain("not a live evaluation");
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toMatch(/<script|<input|<link|https?:\/\/|\{\{|\}\}/);
    expect(html).not.toContain(SENTINEL_REJECTED);
    expect(html).toMatch(new RegExp(`<tr data-fixture-id="${ZH_COLLISION}">`));
    expect(html).toContain(`data-fixture-id="${ZH_COLLISION}" data-locale="zh-SG" data-source="AI" data-changed="true" data-owner-review="NOT_REVIEWED"`);
    expect(html).toContain(`data-fixture-id="${ZH_ORDINARY}" data-locale="zh-SG" data-source="DETERMINISTIC" data-changed="false" data-owner-review="NOT_REVIEWED"`);
    expect(html).toContain(`data-fixture-id="${EN_ORDINARY}" data-locale="en-SG" data-source="AI" data-changed="false" data-owner-review="FAILED"`);
    expect(html).toContain("<code>LANGUAGE_NATURALNESS</code>");
    expect(html).toContain("Owner&#39;s review of the original run");
    expect(html).toContain('<span class="ai">');
    expect(html).toContain('<span class="fact">');
    // A second write with the same stamp never overwrites.
    await expect(writePrivate(roots.review, result.reviewPath.split("/").pop()!, "x", false)).rejects.toThrow();
  }, 60_000);

  it("refuses any request that differs from the stored request beyond the bundle key, and any stored file whose hash does not match", async () => {
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("NETWORK_FORBIDDEN_IN_REPLAY");
    }));
    const { directory, fixtures } = await syntheticStoredRun([{ fixtureId: EN_ORDINARY }, { fixtureId: ZH_ORDINARY }], (report) => report);
    const stored = await loadStoredRun(directory);
    // Tamper with the second stored body (its hash no longer matches, and the body differs beyond the bundle key).
    const tampered: StoredRun = { ...stored, calls: stored.calls.map((call, index) => (index === 1 ? { ...call, request: { ...call.request, bodyText: call.request.bodyText.replace('"temperature":0.2', '"temperature":0.3') } } : call)) };
    const replay = await replayStoredRun(tampered, { fixtures, ceilingUsd: 0.25 });
    expect(replay.check.compared).toBe(2);
    expect(replay.check.identicalExceptBundleKey).toBe(1);
    expect(replay.check.mismatches).toEqual([{ invocation: 2, sequence: 2, codes: ["BODY"] }]);
    expect(replay.report.fixtures[1]).toMatchObject({ source: "DETERMINISTIC" });
    expect(rewriteBundleKey("a ai.explain-pattern@11b.14 b ai.explain-pattern@11b.14", [["ai.explain-pattern@11b.14", "ai.explain-pattern@11b.15"]])).toBeNull();
    expect(rewriteBundleKey("no key here", [["ai.explain-pattern@11b.14", "ai.explain-pattern@11b.15"]])).toBeNull();
    const reread = await loadStoredRun(directory);
    await writeFile(join(directory, "002-" + reread.calls[1]!.classHash + "-call.response.json"), JSON.stringify({ ...reread.calls[1]!.response, raw: `${reread.calls[1]!.response.raw} ` }));
    expect((await loadStoredRun(directory)).calls[1]!.integrity).toEqual(["RESPONSE_BODY_HASH"]);
  }, 60_000);
});

// ---- The replay of the real stored FULL run (env-gated; offline; never a live call) --------------------------------------
describe.runIf(process.env.RUN_OFFLINE_HYBRID_REPLAY === "1")("OFFLINE replay of the stored FULL run 20261006T171832Z-d9f6c556f527f2e5 (RUN_OFFLINE_HYBRID_REPLAY=1)", () => {
  it("replays all 70 stored responses under rules r8 and writes the labelled report and review page; every original file stays byte-unchanged", async () => {
    if (process.env.DEEPSEEK_API_KEY || process.env.KIE_API_KEY) throw new Error("REPLAY_REQUIRES_PROVIDER_KEYS_UNSET");
    const network = vi.fn(() => {
      throw new Error("NETWORK_FORBIDDEN_IN_REPLAY");
    });
    vi.stubGlobal("fetch", network);
    const ownerRecord = JSON.parse(await readFile(OWNER_REVIEW_RECORD, "utf8")) as OwnerRecord;
    expect(ownerRecord.run?.trace).toBe(STORED_RUN);
    const fixtures = hybridFixturesForPhase("FULL");
    const result = await runOfflineReplay({ storedRun: STORED_RUN, fixtures, ownerRecord, ownerRecordPath: OWNER_REVIEW_RECORD, reportRoot: REPLAY_ROOT, reviewRoot: REVIEW_ROOT, requireIgnored: true, guardedDirectories: [STORED_RUN, REVIEW_ROOT] });
    const { record } = result;
    expect(network).not.toHaveBeenCalled();
    expect(result.changedOriginals).toEqual([]);
    expect(record.source.storedIntegrityFailures).toEqual([]);
    expect(record.requestCheck).toMatchObject({ compared: 70, identicalExceptBundleKey: 70, mismatches: [] });
    expect(record.factsInconsistentFixtures).toEqual([]);
    expect(record.replayTotals.calls).toBe(70);
    expect(record.replayTotals.creditsFromStoredUsage).toBe((record.originalFacts.totals as { credits: number }).credits);
    // Closed summary only (no model text).
    console.log(JSON.stringify({
      label: record.label,
      providerCallsMade: record.providerCallsMade,
      globalFetchCalls: network.mock.calls.length,
      requestCheck: { compared: record.requestCheck.compared, identicalExceptBundleKey: record.requestCheck.identicalExceptBundleKey, mismatches: record.requestCheck.mismatches.length },
      before: record.counts.before,
      after: record.counts.after,
      changes: record.changes.map((change) => ({ fixtureId: change.fixtureId, before: describeOutcome(change.before), after: describeOutcome(change.after) })),
      remainingFallbacks: record.remainingFallbacks,
      gates: Object.fromEntries((["firstCallValid", "repairs", "usefulAcceptedOutput", "withinProductionTimeout"] as const).map((key) => [key, `${record.gates.replayWithOriginalFacts[key].numerator}/${record.gates.replayWithOriginalFacts[key].denominator} ${record.gates.replayWithOriginalFacts[key].passed ? "PASS" : "FAIL"}`])),
      verdictPending: record.verdict.pendingHumanReview,
      verdictWithOwnerRecordOfOriginalRun: record.verdict.withOwnerRecordOfOriginalRun,
      newlyAcceptedWithoutOwnerReview: record.verdict.newlyAcceptedOutputsWithoutOwnerReview,
      review: record.review,
      report: relative(process.cwd(), result.reportPath),
      guardedOriginalFiles: result.guardedFiles,
      changedOriginals: result.changedOriginals.length,
    }, null, 2));
  }, 300_000);
});
