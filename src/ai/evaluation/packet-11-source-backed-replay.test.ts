// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeepSeekShellResponsesProvider } from "@/ai/deepseek/deepseek-responses-provider";
import { AI_HYBRID_RUNTIME_BUNDLES, AI_HYBRID_VERSIONS } from "@/application/ai/ai-hybrid-runtime-bundles";
import { composeAiResult } from "@/application/ai/language/ai-composition";
import { verifyComposition } from "@/application/ai/language/assembler";
import { ATOM_RENDERER_VERSION, renderSummaryRoleNotice } from "@/application/ai/language/atom-renderer";
import { composeDeterministic } from "@/application/ai/language/deterministic-composition";
import { projectShellTaskRequest } from "@/application/ai/language/shell-projector";
import { validateShellCandidate } from "@/application/ai/language/shell-validator";
import { planSlots, remoteBudgetAccount } from "@/application/ai/language/slot-planner";
import type { ExplainablePatternView, HistoryComparison } from "@/application/history/recorded-history-contracts";
import { formatDateRange } from "@/components/jagaon/history/history-format";
import { supportingReadingsCopy, type SupportingReadingsCopy } from "@/components/jagaon/history/PatternExplanationPanel";
import { SLOT_PLAN_VERSION, type AiLocale, type AiTaskRequest, type AtomTable, type SlotPlan } from "@/domain/ai";
import { getMessages } from "@/i18n/get-messages";
import type { HybridGate } from "./packet-11-hybrid-evaluation";
import { buildHybridHumanReview, escapeReviewHtml, HYBRID_REVIEW_PAGE_PARTS, type HumanReviewEntry, type HumanReviewItem } from "./packet-11-hybrid-human-review";
import { deepSeekFlash, loadStored, type StoredCall } from "./packet-11-offline-presentation-replay.test";
import { existingFixtureDigest, versionNormalisedFixtureDigest } from "./packet-11-presentation-guard.test";
import { CURRENT_SLOT_PLAN_VERSION, HISTORICAL_SLOT_PLAN_VERSION, normaliseSlotPlanVersion, RESPONSE_ECHO_OCCURRENCES_PER_RESPONSE, rewriteStoredResponseEcho, SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY } from "./packet-11-slot-plan-version-normalisation";
import { eligibilityBudget, SOURCE_BACKED_SCENARIOS, sourceBackedFixture, type SourceBackedFixture, type SourceBackedScenario } from "./packet-11-source-backed-fixtures";

/**
 * OFFLINE SOURCE-BACKED REPLAY (Packet 11C; offline, never a live run, never a qualification and never product acceptance). The global
 * fetch is stubbed to throw and asserted never called; the replay refuses to start while a provider key is set. Stored source: the
 * INDEPENDENT_CONFIRMATION_RUN trace (sent under ai-slot-plan.11b.8), read only. Every scenario is real-evaluator synthetic demo data.
 *
 * P2b (after owner option (a), ai-slot-plan.11b.9 / ai-atoms.11b.7; coordinator ruling 2026-10-08), separately labelled modes, one
 * shared replay function (`replayOne`) and one shared structural helper per side (`normaliseSlotPlanVersion` for the request,
 * `rewriteStoredResponseEcho` for the response):
 * - CURRENT_CONTRACT (11b.9), unmodified: the real current plan and body for every scenario x locale. The fake fetcher answers only a
 *   request that equals the stored class body after the documented version-only normalisation (exactly 2 version fields), and returns
 *   the stored response unmodified. Honest outcome: no historical response validates under 11b.9 (their 11b.8 echo fails S2).
 * - VERSION_NORMALISED_REPLAY (evidence only): the same, but the stored response's slotPlanVersion echo is rewritten in memory, exactly
 *   once, 11b.8 -> 11b.9; then adapter -> validateShellCandidate -> composeAiResult -> verifyComposition (r7). This exercises the 11b.9
 *   pipeline with historical wording. It is NOT evidence that a model would echo 11b.9, NOT qualification, NOT product acceptance.
 * - HISTORICAL_CONTRACT_EVIDENCE (11b.8): not re-run (no version seam exists, by ruling). The Checkpoint 1 page and JSON produced by
 *   11b.8 code are cited read-only, with their sha256 verified.
 * - Deterministic composition (no provider) per scenario x locale, with r7.
 * The earlier DIAGNOSTIC_FORCED_ELIGIBILITY is superseded: en-SG eligibility is now genuine (it never was product acceptance).
 * Checkpoint 2 Task 9: each card's supporting-readings block shows the implemented Task 7 panel copy (see TASK_7_MARK), not proposed copy.
 * Packet 11C B5 contract freeze (text only; this gated replay was not re-run): the page's status text reflects Addendum B (the 7A IQR
 * label, the notices in the printed artifact, the app wiring) and the resolved schema and harness labels. Existing pages and JSON are
 * historical evidence and are never rewritten; only a NEW run would carry this text.
 *
 * Writes a NEW bilingual private (0600) review page and JSON under the Git-ignored test-results/packet-11-source-backed-review/
 * (directory 0700; files opened with "wx", so nothing existing is ever overwritten). Skipped unless RUN_SOURCE_BACKED_REPLAY=1.
 */
const LABEL = "OFFLINE_SOURCE_BACKED_REPLAY";
const CURRENT_MODE = `CURRENT_CONTRACT (${SLOT_PLAN_VERSION})`;
const NORMALISED_MODE = "VERSION_NORMALISED_REPLAY (evidence only)";
const HISTORICAL_MODE = `HISTORICAL_CONTRACT_EVIDENCE (${HISTORICAL_SLOT_PLAN_VERSION}; cited, not re-run)`;
const NOT_A_CLAIM = "not qualification, not product acceptance, not fresh live evidence";
const TRACE = "test-results/packet-11-hybrid-live-trace/20261007T131032Z-6a13e8630a3464c8";
const OUTPUT_ROOT = "test-results/packet-11-source-backed-review";
/** The Checkpoint 1 run produced by ai-slot-plan.11b.8 code (read only). */
const HISTORICAL_RUN = Object.freeze({
  page: "test-results/packet-11-source-backed-review/20261007T201439Z-OFFLINE_SOURCE_BACKED_REPLAY-review.html",
  json: "test-results/packet-11-source-backed-review/20261007T201439Z-OFFLINE_SOURCE_BACKED_REPLAY.json",
  pageSha256: "79261677b8c372478e9f1f38d973f63326470d16b9ddedafcf948e9758cf1114",
});
/**
 * The scenarios of that Checkpoint 1 run (its JSON has 10 rows: these 5 scenarios x 2 locales), frozen. That evidence predates the
 * Task 6R BOUNDARY_DAY scenario, so its rows are compared against this list; the current-contract rows cover every SOURCE_BACKED_SCENARIOS
 * entry, BOUNDARY_DAY included.
 */
const CHECKPOINT_1_SCENARIOS: readonly SourceBackedScenario[] = Object.freeze(["HIGHER", "LOWER", "VARIABILITY", "CORRECTED", "MANY_READINGS"] as const);
const HISTORICAL_FIXTURE_DIGEST = "a77a79aa1c56b1530758147f12573051c4d786035f8926901bbbdaa19d3edd92";
const CURRENT_FIXTURE_DIGEST = "5e7c96959d1d60b441abc54e7384cc0cb30dc33594ba9603f4e64c16de423ff8";
/** The stored (historical, 11b.8) class bodies, and the current (11b.9) bodies that equal them after the version-only normalisation. */
const CLASS_BODY_SHA: Readonly<Record<AiLocale, string>> = {
  "en-SG": "c46ab171eac08602ea3d9e4913c447c7c71643e67971ce725a085ad08cfb2d7d",
  "zh-SG": "b9398514d6b931c94e8acfa78c7faf421606cc9cf2d6f80ee448eedee9e32855",
};
const CURRENT_CLASS_BODY_SHA: Readonly<Record<AiLocale, string>> = {
  "en-SG": "1756934e47137b7434d3499c6952f30adf6056161fc5f6523c53ec526f22a13b",
  "zh-SG": "63f161dcddc2195bec407c79aec6abf4a5edb3f73db2f37b0df51ea382c136ae",
};
const LOCALES = ["en-SG", "zh-SG"] as const;
const BUNDLE = AI_HYBRID_RUNTIME_BUNDLES.EXPLAIN_PATTERN;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const esc = escapeReviewHtml;

/** Minimum additional evidence under the version policy (requirements and options for the owner; not a decision). Also in the record. */
const MINIMUM_EVIDENCE: readonly string[] = [
  "Owner ruling on the version-only body difference. Every guarded model-facing body (82: the 70 existing fixtures, care included, and the 12 source-backed bodies) now differs from the evaluated bytes in exactly two fields: the shell input's slotPlanVersion and the provider output-schema enum. Other bodies follow by the single-builder argument: every shell body is built by the one request builder (kie-responses-provider.ts:358-362). Spec §13: evidence under an earlier contract cannot qualify. Addendum A: if bytes differ, propose one targeted evaluation of the new class. No stored response validates under 11b.9 (S2:SCHEMA_INVALID).",
  "Necessary for A1 (source-backed EXPLAIN), but it qualifies nothing by itself: an owner-authorized, targeted live evaluation under the 11b.9 contract of the two source-backed classes, en-SG body 1756934e… and zh-SG body 63f161dc…. One body per locale serves all six current scenarios (BOUNDARY_DAY included), because the body is value-blind. Coverage at least the stored per-class coverage (9 responses per locale), showing the model echoes ai-slot-plan.11b.9 and passes S1–S10 and r7. Only a live run can show the echo; no offline replay can.",
  "Hybrid qualification under the current contract: hybrid spec §13 says evidence under an earlier contract cannot qualify the hybrid (internal-docs/superpowers/specs/2026-10-06-packet-11-hybrid-fact-slot-language-layer-design.md:516). Qualification therefore needs a FULL-policy run (hybrid-full-policy.2: the 70 fixtures and HYBRID_FULL_UTILITY_THRESHOLDS in packet-11-hybrid-evaluation.ts) under the frozen Packet 11C contract (ai-slot-plan.11b.9 / ai-atoms.11b.7; harness packet11-eval.19 since the B5 contract freeze), unless the owner amends §13.",
  "Care (A3 appointment preparation) and the other EXPLAIN bodies also changed in version only. Addendum A's “covered by the existing care evidence” assumed unchanged bytes. Options: (i) add a care sample in both locales to the targeted run of item 2; (ii) the FULL-policy run of item 3, which also covers care; (iii) an owner exception to §13: an explicit owner ruling that an echo-only difference needs no fresh care evidence, recorded with its reasons.",
  "Owner human review of the new presentation, still required by Addendum A even with byte identity: this page, the IQR copy, the observation template exception, the date formats, the 7A card's IQR label (Addendum B Task B4a) and the Addendum B presentation (Singapore-time cutoff, foreign-offset readings, notices in the printed artifact, disclosure, AI-assisted care states).",
  `Provider output-schema label: resolved at the Packet 11C B5 contract freeze (coordinator ruling; the owner may decide otherwise). The schema's enum carries the slot-plan version, so the label moved from kie-schema.11b.6 to ${AI_HYBRID_VERSIONS.providerSchema}. Label only: it is in no model-facing body.`,
  `Owner acceptance of ai-atoms.11b.7 and of the moved contract pins: APPROVED_HYBRID_CONTRACT names 11b.9 / 11b.7 under harness ${AI_HYBRID_VERSIONS.evaluationReport} (B5 contract freeze), so eval.18-era run evidence is an earlier contract.`,
  "The open owner items in docs/status/packet-11ab-baseline.md (“Open items carried forward”): the hybrid confirmation run is still pending owner human review and sign-off, and the version-basis decision is still outstanding.",
  "Further prerequisites for any product claim: the owner's review of the remaining 11C integration (Addendum B, CP3–CP5: implemented and verified offline, not human-review approved; docs/status/packet-11c-integration.md), one owner-authorized FULL evaluation under the frozen contract, the owner's human review of its results, and a separate activation decision. Every task stays NOT_ACTIVATED (deterministic-only).",
];
const MINIMUM_EVIDENCE_NOT = "These are requirements and options only; no decision is taken. Neither the HISTORICAL_CONTRACT_EVIDENCE (11b.8 bytes) nor the VERSION_NORMALISED_REPLAY (historical wording through the 11b.9 pipeline, echo rewritten in memory) meets any of them. Nothing was sent. Nothing here authorizes a live run; any live call needs the owner's separate, explicit authorization.";
/** M1: why the 11b.9 service would not go straight to the deterministic composition after S2 (the repair call this replay cannot answer). */
const REPAIR_NOTE = "S2:SCHEMA_INVALID is repairable for EXPLAIN (structuralRepairAllowed and maxAttempts 2, ai-runtime-bundles.ts:55; shell-validator.ts:243). The 11b.9 hybrid service would first spend its one structural-repair call (ai-hybrid-task-service.ts:68-70), which this offline replay cannot answer. Only if that call also failed would it show the deterministic composition.";
const CHECKPOINT_2_PREREQUISITE = "Checkpoint 2 prerequisite (before integration): a request carrying taskPayload.periodSummary must never enter the legacy fact-sending route (src/application/ai/ai-task-service.ts, src/app/api/ai/task/ai-task-handler.ts). It may only take the value-blind hybrid shell path or be composed deterministically.";
const CHECKPOINT_2_PREREQUISITE_STATUS = "Status (Checkpoint 2, Task 6A; Addendum B, Task B2a; owner review pending): implemented offline. The legacy service refuses a periodSummary request with PAYLOAD_INVALID before the bundle check, activation, projection or any send (ai-task-service-source-backed.test.ts). The legacy route /api/ai/task is retired: it refuses every request before any credential read (route.test.ts). The app reaches a provider only through the value-blind /api/ai/shell route, which never receives a periodSummary, value, date or source. The pattern-explanation use case (Task 6, explain-pattern.ts) uses the hybrid service only.";
const VITE_NODE_NOTE = "Process note: vite-node (unlike vitest) loads .env.local into process.env. Any future offline probe run through vite-node must use a config with an empty envDir and must keep the provider-key refusal.";

/**
 * Checkpoint 2 Task 9 refresh: the supporting-readings block renders the IMPLEMENTED Task 7 panel copy (history.explanation), through
 * the panel's own pure formatter `supportingReadingsCopy` (PatternExplanationPanel.tsx), so the page shows exactly the panel's strings:
 * the heading, per-period headings, endpoint ranges with the shared cutoff (HH:MM when the cutoff instant has no seconds or
 * milliseconds, otherwise HH:MM:SS, floored), every reading, the boundary note and the reconciliation line. The copy is
 * coordinator-proposed and still awaits owner review.
 */
const TASK_7_MARK = "Task 7 panel copy (implemented; owner review pending)";
/** The cutoff precision rule the panel applies, stated for the reviewer. */
const cutoffPrecision = (instant: string) => {
  const ms = Date.parse(instant);
  return ms % 60_000 === 0 ? "HH:MM (the cutoff instant has no seconds or milliseconds)" : "HH:MM:SS (floored; the cutoff instant has seconds or milliseconds)";
};

type Mode = "CURRENT_CONTRACT" | "VERSION_NORMALISED";
type ReplayOutcome = Readonly<{ sequence: number; requestNormalisedIdentical: boolean; bodySha: string | null; versionFields: number; echoRewrites: number; shellsValid: boolean; composedAccepted: boolean; r7Accepted: boolean; failure: string | null }>;
type Replayed = ReplayOutcome & Readonly<{ candidate: unknown; fallback: { gate: HybridGate | null; reason: string } | null; versionPaths: readonly string[] }>;
type Counts = Readonly<{ of: number; requestsNormalisedIdentical: number; shellsValid: number; composedAccepted: number; r7Accepted: number }>;
const countsOf = (outcomes: readonly ReplayOutcome[]): Counts => ({
  of: outcomes.length,
  requestsNormalisedIdentical: outcomes.filter((entry) => entry.requestNormalisedIdentical).length,
  shellsValid: outcomes.filter((entry) => entry.shellsValid).length,
  composedAccepted: outcomes.filter((entry) => entry.composedAccepted).length,
  r7Accepted: outcomes.filter((entry) => entry.r7Accepted).length,
});
const codesOf = (outcomes: readonly ReplayOutcome[]) => outcomes.reduce<Record<string, number>>((codes, entry) => ({ ...codes, [entry.failure ?? "ACCEPTED"]: (codes[entry.failure ?? "ACCEPTED"] ?? 0) + 1 }), {});
const codeText = (codes: Record<string, number>) => Object.entries(codes).map(([code, n]) => `${n}× ${code}`).join(", ");
const triple = (counts: Counts) => `${counts.shellsValid}/${counts.composedAccepted}/${counts.r7Accepted}`;

/**
 * One stored class response through the real adapter, the shell gates, the service composer and r7 (the one replay function both modes
 * share). The fake fetcher answers only a request whose body equals the stored body after the documented version-only normalisation
 * (exactly the 2 version fields), with the same endpoint, method, content-type and accept. CURRENT_CONTRACT returns the stored response
 * unmodified; VERSION_NORMALISED returns it with only the model's slotPlanVersion echo rewritten in memory (rewriteStoredResponseEcho).
 */
async function replayOne(call: StoredCall, plan: SlotPlan, request: AiTaskRequest, atoms: AtomTable, mode: Mode): Promise<Replayed> {
  const seen = { body: null as string | null, identical: false, versionFields: 0, versionPaths: [] as readonly string[], echoRewrites: 0 };
  const provider = createDeepSeekShellResponsesProvider({ token: "replay-placeholder", model: deepSeekFlash(), fetcher: async (url, init) => {
    seen.body = String(init.body);
    const normalised = normaliseSlotPlanVersion(seen.body);
    seen.versionFields = normalised.occurrences;
    seen.versionPaths = normalised.paths;
    const headers = new Headers(init.headers);
    if (url !== call.endpoint || init.method !== call.method || normalised.occurrences !== SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY || normalised.body !== call.bodyText || headers.get("content-type") !== call.headers["content-type"] || headers.get("accept") !== call.headers.accept) throw new Error("REPLAY_REQUEST_MISMATCH");
    seen.identical = true;
    let raw = call.raw;
    if (mode === "VERSION_NORMALISED") {
      const rewrite = rewriteStoredResponseEcho(call.raw);
      seen.echoRewrites = rewrite.occurrences;
      raw = rewrite.raw;
    }
    return new Response(raw, { status: call.httpStatus, headers: { "content-type": call.contentType } });
  } });
  const result = await provider.invoke(projectShellTaskRequest(plan), new AbortController().signal);
  const base = { sequence: call.sequence, requestNormalisedIdentical: seen.identical, bodySha: seen.body === null ? null : sha256(seen.body), versionFields: seen.versionFields, versionPaths: seen.versionPaths, echoRewrites: seen.echoRewrites, candidate: null, fallback: null };
  const rejected = { shellsValid: false, composedAccepted: false, r7Accepted: false };
  if (!seen.identical) return { ...base, ...rejected, failure: seen.body === null ? "NO_REQUEST_SENT" : "REQUEST_NOT_IDENTICAL_AFTER_VERSION_NORMALISATION" };
  if (result.kind !== "COMPLETED") return { ...base, ...rejected, failure: `PROVIDER_${result.kind}` };
  const shells = validateShellCandidate(plan, BUNDLE, result.candidate);
  if (shells.kind !== "VALID") return { ...base, ...rejected, failure: `${shells.gate}:${shells.reason}`, fallback: { gate: shells.gate, reason: shells.reason } };
  const composed = composeAiResult(request, plan, atoms, shells.shells, BUNDLE);
  if (composed.kind !== "ACCEPTED") return { ...base, ...rejected, shellsValid: true, failure: `${composed.gate}:${composed.reason}`, fallback: { gate: composed.gate as HybridGate, reason: composed.reason } };
  const verdict = verifyComposition(request, BUNDLE, composed.composition);
  const accepted = verdict.kind === "ACCEPTED";
  return { ...base, shellsValid: true, composedAccepted: true, r7Accepted: accepted, failure: accepted ? null : `r7:${verdict.reason}`, candidate: accepted ? result.candidate : null, fallback: accepted ? null : { gate: "S10", reason: "FACT_FIDELITY_FAILED" } };
}
const strip = ({ candidate: _candidate, fallback: _fallback, versionPaths: _paths, ...outcome }: Replayed): ReplayOutcome => outcome;

type ModeResult = Readonly<{ outcomes: readonly ReplayOutcome[]; counts: Counts; codes: Record<string, number> }>;
type Row = Readonly<{
  locale: AiLocale;
  scenario: SourceBackedScenario;
  fixture: SourceBackedFixture;
  plan: SlotPlan;
  /** The historical ai-slot-plan.11b.8 rule readout (fixed budget for a LOCAL field): the "before" figure. */
  before: ReturnType<typeof eligibilityBudget>;
  /** The planner's own 11b.9 account (a LOCAL field reserves its final wording): the "after" figure. */
  account: ReturnType<typeof remoteBudgetAccount>;
  currentBodySha: string | null;
  versionPaths: readonly string[];
  current: ModeResult;
  normalised: ModeResult;
  deterministicR7: string;
  /** VERSION_NORMALISED_REPLAY compositions (historical model wording; evidence only), first = shown. */
  normalisedItems: readonly HumanReviewItem[];
  /** What the 11b.9 hybrid service would show with a stored response: the deterministic fallback after S2. */
  fallbackItem: HumanReviewItem | null;
  excluded: number;
}>;

/** The existing approved 7A comparison card text for the same fact (unchanged copy and formatter), with its detail lines. */
function approvedCard(locale: AiLocale, comparison: HistoryComparison | null): { text: string; details: string[] } | null {
  if (comparison === null) return null;
  const msg = getMessages(locale).history;
  const slot = msg.slotLabels[comparison.slot];
  const unit = "mmol/L";
  const text =
    comparison.kind === "HIGHER"
      ? msg.comparisonHigher(slot, comparison.recent ?? "", comparison.reference ?? "", unit)
      : comparison.kind === "LOWER"
        ? msg.comparisonLower(slot, comparison.recent ?? "", comparison.reference ?? "", unit)
        : comparison.kind === "VARIABILITY"
          ? msg.comparisonVariability(slot, comparison.recent ?? "", comparison.reference ?? "", unit)
          : msg.noMaterialComparison(slot);
  const details = [
    msg.evidenceWindow(formatDateRange(locale, comparison.recentWindow.startDate, comparison.recentWindow.endDate), formatDateRange(locale, comparison.referenceWindow.startDate, comparison.referenceWindow.endDate)),
    ...(comparison.correctionUpdated ? [msg.correctionUpdated] : []),
  ];
  return { text, details };
}

/**
 * The Task 7 panel's supporting-readings block, from the panel's own formatter (every reading, by the view's periods, with the endpoint
 * ranges, the boundary note and the reconciliation line). Returns the html, the listed item count and the copy (for the JSON).
 */
function supportingReadings(locale: AiLocale, view: ExplainablePatternView): { html: string; listed: number; copy: SupportingReadingsCopy } {
  const copy = supportingReadingsCopy(getMessages(locale), locale, view);
  let listed = 0;
  const periods = copy.periods.map((period) => {
    const items = period.readings.map((reading) => {
      listed += 1;
      return `<li><span class="rd">${esc(reading.when)}</span> <span class="rv">${esc(reading.value)}</span></li>`;
    }).join("");
    const range = period.range === null ? "" : `<p class="panel-copy range">${esc(period.range)}</p>`;
    return `<h5 class="panel-copy">${esc(period.heading)}</h5>${range}<ol class="readings" data-role="${period.role}" data-count="${period.readings.length}">${items}</ol>`;
  }).join("");
  const boundary = copy.boundaryNote === null ? `<p class="warn">No shared cutoff: no boundary note.</p>` : `<p class="panel-copy boundary">${esc(copy.boundaryNote)}</p>`;
  const html = `<div class="supporting" lang="${locale}"><p class="panel-mark">${esc(TASK_7_MARK)}: every string in this block is the panel's (history.explanation through supportingReadingsCopy); the readings are the view's deterministic data, grouped as the view groups them. Cutoff shown at ${esc(cutoffPrecision(view.sharedBoundary.instant))}.</p><h4 class="panel-copy">${esc(copy.heading)}</h4>${periods}${boundary}<p class="panel-copy reconciliation">${esc(copy.reconciliation)}</p></div>`;
  return { html, listed, copy };
}

const asFixture = (locale: AiLocale, id: string, request: AiTaskRequest) => ({ id, taskType: "EXPLAIN_PATTERN" as const, locale, category: "ORDINARY" as const, expectedOutcome: "SUCCESS" as const, request });

/** The Checkpoint 1 (11b.8 code) evidence, read only: its JSON's per-scenario counts and its page sha256. */
function historicalEvidence() {
  const html = readFileSync(HISTORICAL_RUN.page, "utf8");
  const summary = JSON.parse(readFileSync(HISTORICAL_RUN.json, "utf8")) as {
    pageSha256: string;
    versions: { slotPlan: string; atomRenderer: string };
    scenarios: Array<{ locale: AiLocale; scenario: SourceBackedScenario; servicePath: { kind: string; counts?: Counts & { requestsIdentical: number }; observedBodySha?: string | null; reason?: string } }>;
  };
  const pageSha256 = sha256(html);
  // Only the 11b.8 service path counts. The en-SG rows of that run exist only under the superseded forced-eligibility diagnostic and are
  // never counted (no triple is read from it).
  const rows = summary.scenarios.map((row) => {
    const counted = row.servicePath.kind === "AI_REPLAYED" && row.servicePath.counts !== undefined;
    return {
      locale: row.locale,
      scenario: row.scenario,
      counted,
      source: counted ? "SERVICE_PATH (eligible under 11b.8)" : `${row.servicePath.kind}${row.servicePath.reason ? ` ${row.servicePath.reason}` : ""} under 11b.8`,
      triple: counted ? triple(row.servicePath.counts!) : null,
      requestsIdentical: counted ? row.servicePath.counts!.requestsIdentical : null,
      bodyEqualsClass: counted ? row.servicePath.observedBodySha === CLASS_BODY_SHA[row.locale] : null,
    };
  });
  return { page: HISTORICAL_RUN.page, json: HISTORICAL_RUN.json, pageSha256, recordedPageSha256: summary.pageSha256, expectedPageSha256: HISTORICAL_RUN.pageSha256, versions: { slotPlan: summary.versions.slotPlan, atomRenderer: summary.versions.atomRenderer }, rows };
}

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
  vi.unstubAllGlobals();
});

describe.runIf(process.env.RUN_SOURCE_BACKED_REPLAY === "1")("OFFLINE source-backed replay (RUN_SOURCE_BACKED_REPLAY=1)", () => {
  it("records CURRENT_CONTRACT and VERSION_NORMALISED_REPLAY per scenario x locale, cites the 11b.8 evidence, and writes a new owner review page", async () => {
    if (process.env.DEEPSEEK_API_KEY || process.env.KIE_API_KEY) throw new Error("REPLAY_REQUIRES_PROVIDER_KEYS_UNSET");
    const network = vi.fn(() => { throw new Error("NETWORK_FORBIDDEN_IN_SOURCE_BACKED_REPLAY"); });
    vi.stubGlobal("fetch", network);

    const stored = loadStored();
    const classCalls = Object.fromEntries(LOCALES.map((locale) => [locale, stored.filter((call) => sha256(call.bodyText) === CLASS_BODY_SHA[locale]).sort((a, b) => a.sequence - b.sequence)])) as Record<AiLocale, StoredCall[]>;
    const historical = historicalEvidence();

    const rows: Row[] = [];
    for (const locale of LOCALES) {
      for (const scenario of SOURCE_BACKED_SCENARIOS) {
        const fixture = await sourceBackedFixture(locale, scenario);
        const planned = planSlots(fixture.request, BUNDLE);
        if (planned.kind !== "PLANNED") throw new Error(`REPLAY_UNPLANNABLE:${locale}:${scenario}:${planned.reason}`);
        const { plan, atoms } = planned;
        if (!plan.remote.eligible) throw new Error(`REPLAY_PLAN_NOT_ELIGIBLE:${locale}:${scenario}:${plan.remote.reason}`);
        const current: Replayed[] = [];
        const normalised: Replayed[] = [];
        for (const call of classCalls[locale]) current.push(await replayOne(call, plan, fixture.request, atoms, "CURRENT_CONTRACT"));
        for (const call of classCalls[locale]) normalised.push(await replayOne(call, plan, fixture.request, atoms, "VERSION_NORMALISED"));
        const entries: HumanReviewEntry[] = [];
        for (const entry of normalised) {
          const reviewFixture = asFixture(locale, `${fixture.id}#seq-${String(entry.sequence).padStart(3, "0")}`, fixture.request);
          if (entry.candidate !== null) entries.push({ fixture: reviewFixture, candidate: entry.candidate });
        }
        const firstFallback = current.find((entry) => entry.fallback !== null)?.fallback ?? null;
        if (firstFallback) entries.push({ fixture: asFixture(locale, `${fixture.id}#current-contract`, fixture.request), fallback: firstFallback as never });
        const review = buildHybridHumanReview(entries, { generatedAt: "offline" });
        const deterministic = composeDeterministic(fixture.request, plan, atoms, BUNDLE);
        const bodies = new Set(current.map((entry) => entry.bodySha));
        const currentOutcomes = current.map(strip);
        const normalisedOutcomes = normalised.map(strip);
        rows.push({
          locale,
          scenario,
          fixture,
          plan,
          before: eligibilityBudget(plan, atoms),
          account: remoteBudgetAccount(plan, atoms, BUNDLE),
          currentBodySha: bodies.size === 1 ? [...bodies][0]! : null,
          versionPaths: current[0]?.versionPaths ?? [],
          current: { outcomes: currentOutcomes, counts: countsOf(currentOutcomes), codes: codesOf(currentOutcomes) },
          normalised: { outcomes: normalisedOutcomes, counts: countsOf(normalisedOutcomes), codes: codesOf(normalisedOutcomes) },
          deterministicR7: verifyComposition(fixture.request, BUNDLE, deterministic).kind,
          normalisedItems: review.items.filter((item) => item.source === "AI"),
          fallbackItem: review.items.find((item) => item.source === "DETERMINISTIC") ?? null,
          excluded: review.excluded,
        });
      }
    }
    const currentDigest = await existingFixtureDigest();
    const normalisedDigest = await versionNormalisedFixtureDigest();

    // --- the page ---
    const renderBlock = HYBRID_REVIEW_PAGE_PARTS.renderBlock;
    const listedPerRow = new Map<string, number>();
    const panelCopyPerRow = new Map<string, SupportingReadingsCopy>();
    const fieldsText = (account: Row["account"]) => account.fields.map((field) => `${field.path} ${field.owner === "LOCAL" ? "L" : "R"} ${field.reserved}`).join(" + ");
    const banner = `<p class="banner"><b>${LABEL}</b>: not a live run. Nothing was sent: the global fetch was stubbed to throw and was called ${network.mock.calls.length} times. The stored INDEPENDENT_CONFIRMATION_RUN responses (${esc(TRACE)}, sent under ${esc(HISTORICAL_SLOT_PLAN_VERSION)}) whose request body equals the locale's class hash (${classCalls["en-SG"].length} en-SG, ${classCalls["zh-SG"].length} zh-SG) were replayed offline in two separately labelled modes. Every scenario is real-evaluator synthetic demo data. Nothing on this page is qualification, product acceptance or fresh live evidence. Your review decisions remain open.</p>`;

    const resolvedBox = `<section class="box resolved"><h2>en-SG eligibility blocker: RESOLVED by owner option (a)</h2>
<p>Owner option (a), implemented offline: the planner's remote-eligibility account now reserves an application-owned (LOCAL) field at its final composed wording (the maximum over every permitted local variant) instead of its fixed budget. REMOTE fields keep their fixed budgets; the ceiling, caps, prompt, rules and r7 are unchanged. This is <code>${esc(CURRENT_SLOT_PLAN_VERSION)}</code> (was <code>${esc(HISTORICAL_SLOT_PLAN_VERSION)}</code>). Every plan below is eligible because of the planner's own decision, not a forced copy.</p>
<table><thead><tr><th>Scenario</th><th>Locale</th><th>Before: 11b.8 rule Σ (over by)</th><th>After: 11b.9 account Σ</th><th>Ceiling</th><th>After: fields (L = LOCAL reservation, R = REMOTE budget + atoms)</th><th>plan.remote</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.scenario}</td><td>${row.locale}</td><td>${row.before.sum}${row.before.overBy > 0 ? ` (over by ${row.before.overBy})` : ""}</td><td><b>${row.account.total}</b></td><td>${row.account.ceiling}</td><td>${esc(fieldsText(row.account))}</td><td><code>${esc(JSON.stringify(row.plan.remote))}</code></td></tr>`).join("")}</tbody></table></section>`;

    const versionPaths = rows[0]?.versionPaths ?? [];
    const versionBox = `<section class="box versions"><h2>Version change</h2><ul>
<li>Slot plan <code>${esc(HISTORICAL_SLOT_PLAN_VERSION)}</code> → <code>${esc(AI_HYBRID_VERSIONS.slotPlan)}</code> (eligibility accounting only). Atoms <code>ai-atoms.11b.6</code> → <code>${esc(ATOM_RENDERER_VERSION)}</code> (PERIOD_SUMMARY kind and lead joiner, application-only).</li>
<li>Every guarded body (82: the 70 fixtures and the 12 source-backed bodies) differs from its historical body in exactly these ${SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY} paths, and nowhere else (structural guards): ${versionPaths.map((path) => `<code>${esc(path)}</code>`).join(" and ")}. Other bodies follow by the single-builder argument: every shell body is built by the one request builder (<code>kie-responses-provider.ts:358-362</code>).</li>
<li>70 existing fixtures (bodies and eligibility): historical <code>${HISTORICAL_FIXTURE_DIGEST}</code>; current <code>${esc(currentDigest)}</code>; current after version-only normalisation <code>${esc(normalisedDigest.digest)}</code> (${normalisedDigest.occurrences} version fields rewritten; ${normalisedDigest.digest === HISTORICAL_FIXTURE_DIGEST ? "equals the historical digest" : "DIFFERS"}).</li>
${LOCALES.map((locale) => `<li>${locale} source-backed class body: historical <code>${CLASS_BODY_SHA[locale]}</code>; current <code>${CURRENT_CLASS_BODY_SHA[locale]}</code>.</li>`).join("\n")}
<li>Unchanged: prompt ${esc(AI_HYBRID_VERSIONS.prompt)}, ${esc(AI_HYBRID_VERSIONS.shellRules)}, ${esc(AI_HYBRID_VERSIONS.shellRequest)}, ${esc(AI_HYBRID_VERSIONS.providerSchema)} (label; its enum now carries the new slot-plan version), ${esc(AI_HYBRID_VERSIONS.validatorRules)}, ${esc(BUNDLE.bundleKey)}.</li></ul></section>`;

    const currentSection = `<section class="box mode current"><h2>${esc(CURRENT_MODE)}</h2>
<p>The real current plan and body for every scenario and locale, unmodified. Each request equals the stored class body only after the documented version-only normalisation (exactly ${SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY} version fields). The stored responses were returned unmodified through the real adapter and <code>validateShellCandidate</code>. <b>No historical response validates under ${esc(SLOT_PLAN_VERSION)}:</b> each echoes <code>${esc(HISTORICAL_SLOT_PLAN_VERSION)}</code>, and the current output schema rejects it at S2 (before the S3 echo check). ${esc(REPAIR_NOTE)}</p>
<table><thead><tr><th>Scenario</th><th>Locale</th><th>Current body</th><th>Requests equal to stored after normalisation</th><th>Shells valid / composed / r7</th><th>Codes</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.scenario}</td><td>${row.locale}</td><td><code>${esc((row.currentBodySha ?? "MIXED/NONE").slice(0, 12))}…</code></td><td>${row.current.counts.requestsNormalisedIdentical}/${row.current.counts.of}</td><td><b>${triple(row.current.counts)}</b> of ${row.current.counts.of}</td><td>${esc(codeText(row.current.codes))}</td></tr>`).join("")}</tbody></table></section>`;

    const normalisedSection = `<section class="box mode normalised"><h2>${esc(NORMALISED_MODE)}</h2>
<p><b>The stored response's <code>slotPlanVersion</code> echo was rewritten in memory, exactly once, ${esc(HISTORICAL_SLOT_PLAN_VERSION)} → ${esc(CURRENT_SLOT_PLAN_VERSION)}</b>. Nothing else was touched: not the shells, and not the envelope's request-parameter echo. The request still had to equal the stored body after the documented normalisation. The response then went through the real adapter, the shell gates, the service composer and r7. This exercises the 11b.9 pipeline with historical model wording. It is <b>not</b> evidence that a model would echo 11b.9, and it is ${esc(NOT_A_CLAIM)}.</p>
<table><thead><tr><th>Scenario</th><th>Locale</th><th>Echo rewrites</th><th>Requests equal after normalisation</th><th>Shells valid / composed accepted / r7 accepted</th><th>Failures</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${row.scenario}</td><td>${row.locale}</td><td>${row.normalised.outcomes.reduce((sum, entry) => sum + entry.echoRewrites, 0)}</td><td>${row.normalised.counts.requestsNormalisedIdentical}/${row.normalised.counts.of}</td><td><b>${triple(row.normalised.counts)}</b> of ${row.normalised.counts.of}</td><td>${esc(row.normalised.outcomes.filter((entry) => entry.failure).map((entry) => `seq ${entry.sequence} ${entry.failure}`).join("; ") || "none")}</td></tr>`).join("")}</tbody></table></section>`;

    const historicalSection = `<section class="box mode historical"><h2>${esc(HISTORICAL_MODE)}</h2>
<p>Not re-run: no version seam exists, by ruling. The Checkpoint 1 run was produced by ${esc(historical.versions.slotPlan)} / ${esc(historical.versions.atomRenderer)} code with byte-identical bodies, and it is cited here read-only: <code>${esc(historical.page)}</code> (sha256 <code>${esc(historical.pageSha256)}</code>, ${historical.pageSha256 === historical.recordedPageSha256 && historical.pageSha256 === historical.expectedPageSha256 ? "equals the sha recorded in its JSON" : "DOES NOT equal the recorded sha"}) and <code>${esc(historical.json)}</code>. It is offline evidence about 11b.8 bytes only, and ${esc(NOT_A_CLAIM)}. zh-SG was eligible under 11b.8, and its service-path counts are shown. en-SG was not eligible under 11b.8; its rows in that run come only from the superseded forced-eligibility diagnostic and are not counted.</p>
<table><thead><tr><th>Scenario</th><th>Locale</th><th>Source in that run</th><th>Body = class</th><th>Shells valid / composed / r7 (of 9)</th></tr></thead><tbody>${historical.rows.map((row) => `<tr><td>${row.scenario}</td><td>${row.locale}</td><td>${esc(row.source)}</td><td>${row.bodyEqualsClass === null ? "—" : row.bodyEqualsClass ? "yes" : "NO"}</td><td>${esc(row.triple ?? "not counted (superseded forced-eligibility diagnostic)")}</td></tr>`).join("")}</tbody></table>
<p class="codes">The earlier DIAGNOSTIC_FORCED_ELIGIBILITY is superseded (en-SG eligibility is now genuine); it never was product acceptance.</p></section>`;

    const deterministicSection = `<section class="box"><h2>Deterministic composition (no provider)</h2><p>${rows.map((row) => `${row.locale} ${row.scenario}: r7 ${esc(row.deterministicR7)}`).join(" · ")}</p></section>`;

    const draftNoticeLabel = Object.fromEntries(LOCALES.map((locale) => [locale, getMessages(locale).careSummary.draftNotices.label])) as Record<AiLocale, string>;
    const openItems = `<section class="box open"><h2>Presentation and contract items (Checkpoint 1, Phase 2, Checkpoint 2 and their Addendum B status; every presentation item awaits owner review)</h2><ol>
<li><b>Addendum B (Task B4a, owner decision B0.1):</b> the 7A VARIABILITY comparison card now labels its value as the interquartile range (IQR) in en and zh, matching the explanation's “interquartile range” / “四分位距”; it no longer says “recorded spread” / “记录范围”. Only that one 7A message changed. Human acceptance pending.</li>
<li>The IQR wording (“interquartile range”, “(IQR: the spread of the middle half of the readings)” / “四分位距”, “（IQR，即中间一半读数的分布宽度）”; summary-role notice ai-language-copy.11b.10) follows the owner's implementation decision of 2026-10-08. It still awaits owner human review.</li>
<li>The observation template “Readings by period — …” / “按期间的读数：…” is a deliberate exception to the presentation-correction rule that banned “readings” next to earlier/recent labels and dates.</li>
<li>Date formats differ side by side (an observation for the owner; no recommendation). The 7A card uses the history formatter (for example “20 Sep – 4 Oct 2026” / “2026年9月20日至10月4日”). The explanation uses the care-summary locale pack (for example “20 Sept 2026” / “2026年9月20日至2026年10月4日”). The supporting-reading dates on this page also carry the year, unlike the plan's example (“1 Sept”).</li>
<li>The boundary date (for example 20 Sept) appears in both periods: the earlier period ends on it and the recent period starts on it. This is the existing 7A instant-window behaviour, shown as inclusive local dates (an observation for the owner; no recommendation).</li>
<li><b>Resolved at the B5 contract freeze (coordinator ruling; the owner may decide otherwise):</b> the provider output schema's <code>slotPlanVersion</code> enum carries the slot-plan version (${esc(CURRENT_SLOT_PLAN_VERSION)}), so its label moved from kie-schema.11b.6 to <code>${esc(AI_HYBRID_VERSIONS.providerSchema)}</code>. Label only: it is in no model-facing body.</li>
<li><b>Resolved at the B5 contract freeze:</b> the evaluation harness label moved from packet11-eval.18 to <code>${esc(AI_HYBRID_VERSIONS.evaluationReport)}</code> (eval.18's logic and policy), so evidence under the frozen contract is distinguishable from eval.18-era evidence.</li>
<li><b>Resolved at the B5 contract freeze:</b> the live runners' header comments now state the current frozen contract, with their revision history kept. The whole frozen contract is pinned in <code>packet-11c-contract-freeze.test.ts</code>.</li>
<li><b>Checkpoint 2 (Task 6R):</b> the summary-role line, ${esc(AI_HYBRID_VERSIONS.languageCopy)}: “${esc(renderSummaryRoleNotice("en-SG"))}” / “${esc(renderSummaryRoleNotice("zh-SG"))}”. It names and explains the IQR; the PERIOD_SUMMARY atom and renderer are unchanged (${esc(ATOM_RENDERER_VERSION)}). Owner review pending.</li>
<li><b>Checkpoint 2 (Task 7):</b> the explanation-panel copy (<code>history.explanation</code>, marked “${esc(TASK_7_MARK)}” in every card below): headings, endpoint ranges (“up to, but not including” / “至…之前”, “…起至…之前”), the cutoff at HH:MM or HH:MM:SS, the boundary note and the reconciliation line. Coordinator-proposed; owner review pending. Since Addendum B (Tasks B2b, B4a) the panel is wired in the app; with the shipped manifest it composes deterministically, sends nothing and shows no disclosure. B4a added the Singapore-time cutoff label, the actual offset and Singapore-time equivalent of every foreign-offset reading, and the heading “Readings included in this comparison” (human acceptance pending).</li>
<li><b>Checkpoint 2 (Task 8), superseded by Addendum B (Task B1a):</b> the care-draft notices (the approved text verbatim) are now part of the printable, hashed summary artifact for new snapshots (care-summary-template.11c.1), as the last section under the heading “${esc(draftNoticeLabel["en-SG"])}” / “${esc(draftNoticeLabel["zh-SG"])}”. The Checkpoint 2 screen-only region no longer exists; approved and older snapshots are unchanged. Human acceptance pending.</li>
</ol></section>`;

    const minimumBox = `<section class="box minimum"><h2>Minimum additional evidence under the version policy (requirements and options; not a decision)</h2><ol>${MINIMUM_EVIDENCE.map((line) => `<li>${esc(line)}</li>`).join("")}</ol><p><b>${esc(MINIMUM_EVIDENCE_NOT)}</b></p></section>`;
    const prerequisite = `<div class="box prerequisite"><p><b>${esc(CHECKPOINT_2_PREREQUISITE)}</b></p><p>${esc(CHECKPOINT_2_PREREQUISITE_STATUS)}</p></div><p class="sub">${esc(VITE_NODE_NOTE)}</p>`;

    const card = (row: Row) => {
      const { fixture, locale, scenario } = row;
      const shown = row.normalisedItems[0];
      const cardText = approvedCard(locale, fixture.comparison);
      const supporting = supportingReadings(locale, fixture.view);
      listedPerRow.set(`${locale}:${scenario}`, supporting.listed);
      panelCopyPerRow.set(`${locale}:${scenario}`, supporting.copy);
      const blocksOf = (item: HumanReviewItem | undefined | null) => (item ? item.blocks.filter((block) => block.path !== null).map((block) => renderBlock(block, locale)).join("") : `<p class="warn">No reviewable composition (excluded: ${row.excluded}).</p>`);
      const limitationSource = row.fallbackItem ?? shown;
      const limitations = limitationSource ? limitationSource.blocks.filter((block) => block.label === "Limitation").map((block) => renderBlock(block, locale)).join("") : "";
      const others = row.normalisedItems.length > 1
        ? `<details><summary>All ${row.normalisedItems.length} ${esc(NORMALISED_MODE)} compositions for this scenario (headline and evidence)</summary>${row.normalisedItems.map((item) => `<div class="alt"><div class="label">stored response seq ${esc(item.fixtureId.split("#seq-")[1] ?? "?")}</div>${item.blocks.filter((block) => block.path === "headline" || block.path === "evidence").map((block) => renderBlock(block, locale)).join("")}</div>`).join("")}</details>`
        : "";
      const notes = [
        `Request class: stored (11b.8) <code>${CLASS_BODY_SHA[locale]}</code>; current body <code>${esc(row.currentBodySha ?? "MIXED/NONE")}</code> (${row.currentBodySha === CURRENT_CLASS_BODY_SHA[locale] ? "the pinned current class" : "NOT the pinned current class"}); ${row.current.counts.requestsNormalisedIdentical}/${row.current.counts.of} requests equal the stored bodies after the version-only normalisation`,
        `Eligibility: <code>${esc(JSON.stringify(row.plan.remote))}</code> · 11b.9 Σ ${row.account.total} vs ceiling ${row.account.ceiling} (${esc(fieldsText(row.account))}) · 11b.8 rule Σ was ${row.before.sum}${row.before.overBy > 0 ? `, over by ${row.before.overBy}` : ""}`,
        `${esc(CURRENT_MODE)}: ${triple(row.current.counts)} of ${row.current.counts.of} · ${esc(codeText(row.current.codes))}`,
        `${esc(NORMALISED_MODE)}: <b>${triple(row.normalised.counts)}</b> of ${row.normalised.counts.of}`,
        `Deterministic composition: r7 ${esc(row.deterministicR7)}`,
        `View (real evaluator): ${fixture.view.kind} · ${fixture.view.periods.map((period) => `${period.role} ${period.count} (${period.summary.kind} ${esc(period.summary.valueMmolL)})`).join(" + ")} = ${fixture.view.totalCount} · readings listed: ${supporting.listed}`,
        `Shared cutoff (view.sharedBoundary): instant <code>${esc(fixture.view.sharedBoundary.instant)}</code>, home-offset local ${esc(fixture.view.sharedBoundary.localDate)} ${esc(fixture.view.sharedBoundary.localTime)}; the panel shows it at ${esc(cutoffPrecision(fixture.view.sharedBoundary.instant))}`,
        ...(fixture.correction ? [`Correction: record ${esc(fixture.correction.recordId)} corrected on ${esc(fixture.correction.localDate)} ${esc(fixture.correction.localTime)}; the listed revision differs from the original revision ${esc(fixture.correction.previousRevisionId)}`] : []),
      ];
      return `<article class="card" data-scenario="${scenario}" data-locale="${locale}" lang="${locale}">
<header><h3>${esc(scenario)} · ${locale}</h3><span class="pill">${esc(`current contract ${triple(row.current.counts)} · version-normalised ${triple(row.normalised.counts)}`)}</span></header>
<p class="codes">${esc(fixture.id)}</p>
${cardText ? `<div class="row approved7a"><div class="label">Existing 7A card (approved copy, unchanged)</div><p>${esc(cardText.text)}</p>${cardText.details.map((detail) => `<p class="detail">${esc(detail)}</p>`).join("")}</div>` : `<p class="warn">No READY 7A comparison was found for this fact.</p>`}
<p class="codes mode-label">${esc(CURRENT_MODE)}: every stored response is rejected at <code>${esc(row.fallbackItem?.fallback ? `${row.fallbackItem.fallback.gate}:${row.fallbackItem.fallback.reason}` : "none")}</code>. ${esc(REPAIR_NOTE)} Shown below: that <b>deterministic composition</b> (application wording and fact atoms only; no model wording).</p>
${blocksOf(row.fallbackItem)}
<p class="codes mode-label">${esc(NORMALISED_MODE)}: historical model wording (stored response seq ${shown ? esc(shown.fixtureId.split("#seq-")[1] ?? "?") : "?"}) composed by the 11b.9 pipeline with its echo rewritten in memory. Headline and evidence are model wording; the observation is the application's deterministic composition. This is ${esc(NOT_A_CLAIM)}.</p>
${blocksOf(shown)}
${others}
${supporting.html}
<div class="row"><div class="label">Summary role (summaryRoleNotice)</div><p><span class="det">${esc(renderSummaryRoleNotice(locale))}</span></p></div>
${limitations}
<aside class="box evalnotes" lang="en"><b>Evaluation-only notes (not product output)</b><ul>${notes.map((note) => `<li>${note}</li>`).join("")}</ul></aside>
</article>`;
    };
    const sections = LOCALES.map((locale) => `<h2>${locale === "en-SG" ? "en-SG · English" : "zh-SG · 中文"}</h2>${rows.filter((row) => row.locale === locale).map(card).join("\n")}`).join("\n");

    const versionsLine = `${AI_HYBRID_VERSIONS.slotPlan} · ${AI_HYBRID_VERSIONS.atomRenderer} (ATOM_RENDERER_VERSION ${ATOM_RENDERER_VERSION}) · ${AI_HYBRID_VERSIONS.languageCopy} · ${AI_HYBRID_VERSIONS.defaultShells} · ${AI_HYBRID_VERSIONS.shellRules} · ${AI_HYBRID_VERSIONS.shellRequest} · prompt ${AI_HYBRID_VERSIONS.prompt} · ${AI_HYBRID_VERSIONS.providerSchema} · ${AI_HYBRID_VERSIONS.validatorRules} · ${BUNDLE.bundleKey}`;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Source-Backed Review</title>
<style>${HYBRID_REVIEW_PAGE_PARTS.style}
.box { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 20px; font-size: .9rem; }
.box h2 { margin: 0 0 8px; font-size: 1.05rem; } .resolved { border: 2px solid var(--fact-line); } .mode { border: 2px solid var(--line); } .normalised, .historical { border-style: dashed; border-color: var(--warn); } .minimum { border: 2px solid var(--warn); } .open { border-left: 4px solid var(--fact-line); }
.banner { border: 2px solid var(--warn); border-radius: 10px; padding: 10px 14px; margin: 0 0 16px; } .prerequisite { border: 2px solid var(--warn); }
.evalnotes { margin-top: 14px; border-style: dashed; color: var(--muted); } .evalnotes ul { margin: 6px 0 0; padding-left: 18px; } code { overflow-wrap: anywhere; font-size: .8rem; }
table { border-collapse: collapse; width: 100%; font-size: .82rem; margin: 8px 0; } th, td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
.box { overflow-x: auto; } .approved7a p { margin: 2px 0; } .detail { color: var(--muted); font-size: .85rem; } .mode-label { margin: 14px 0 4px; }
.supporting { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; } .supporting h4 { margin: 4px 0; } .supporting h5 { margin: 8px 0 2px; font-size: .9rem; }
.readings { margin: 0; padding-left: 22px; columns: 2; column-gap: 24px; font-size: .88rem; } @media (max-width: 600px) { .readings { columns: 1; } }
.panel-copy { outline: 1px dashed var(--fact-line); outline-offset: 2px; } .panel-mark { font-size: .75rem; color: var(--warn); margin: 0 0 6px; } .supporting .range, .supporting .boundary { margin: 2px 0 4px; font-size: .88rem; }
.reconciliation { margin: 8px 0 0; } .warn { color: var(--warn); } details { margin: 8px 0; font-size: .9rem; } .alt { margin: 6px 0 10px; padding-left: 8px; border-left: 2px solid var(--line); }
</style></head><body><main data-label="${LABEL}">
<h1>Source-backed explanations · offline review (after owner option (a))</h1>
${banner}
<p class="sub">Versions: ${esc(versionsLine)}.</p>
${resolvedBox}
${versionBox}
${currentSection}
${normalisedSection}
${historicalSection}
${deterministicSection}
${openItems}
${minimumBox}
${prerequisite}
<p class="legend"><span class="ai">model wording</span><span class="det">application wording</span><span class="fact">supplied fact, shown verbatim</span><span class="panel-copy">${esc(TASK_7_MARK)}</span></p>
${sections}
</main></body></html>`;

    // --- the JSON summary ---
    const modeJson = (result: ModeResult) => ({ counts: result.counts, codes: result.codes, outcomes: result.outcomes });
    const summary = {
      kind: LABEL,
      label: LABEL,
      liveEvaluation: false,
      providerCalls: network.mock.calls.length,
      claims: { qualification: false, productAcceptance: false, freshLiveEvidence: false, modelQualified: false },
      trace: TRACE,
      storedClassResponses: Object.fromEntries(LOCALES.map((locale) => [locale, classCalls[locale].map((call) => call.sequence)])),
      versions: { ...AI_HYBRID_VERSIONS, atomRendererConstant: ATOM_RENDERER_VERSION, bundleKey: BUNDLE.bundleKey, shellRequestVersion: BUNDLE.shellRequestVersion, historicalSlotPlan: HISTORICAL_SLOT_PLAN_VERSION, historicalAtomRenderer: "ai-atoms.11b.6" },
      digests: {
        fixtures70: { historical: HISTORICAL_FIXTURE_DIGEST, current: currentDigest, currentPinned: CURRENT_FIXTURE_DIGEST, versionNormalised: normalisedDigest.digest, versionFieldsRewritten: normalisedDigest.occurrences },
        classBodies: Object.fromEntries(LOCALES.map((locale) => [locale, { historical: CLASS_BODY_SHA[locale], currentPinned: CURRENT_CLASS_BODY_SHA[locale] }])),
        versionOnlyPaths: versionPaths,
      },
      modes: {
        CURRENT_CONTRACT: { label: CURRENT_MODE, note: `Unmodified stored responses against the current contract. No historical response validates under ${SLOT_PLAN_VERSION}. ${REPAIR_NOTE}` },
        VERSION_NORMALISED_REPLAY: { label: NORMALISED_MODE, note: `The stored response's slotPlanVersion echo was rewritten in memory, exactly once (${HISTORICAL_SLOT_PLAN_VERSION} -> ${CURRENT_SLOT_PLAN_VERSION}). This exercises the 11b.9 pipeline with historical wording. It is NOT evidence that a model would echo 11b.9, NOT qualification, NOT product acceptance.` },
        HISTORICAL_CONTRACT_EVIDENCE: { label: HISTORICAL_MODE, note: "Not re-run (no version seam, by ruling). Cited read-only: offline evidence about 11b.8 bytes only. zh-SG service-path rows are counted. en-SG rows are not counted (superseded forced-eligibility diagnostic): triple null, counted false.", ...historical },
      },
      supersededDiagnostic: "DIAGNOSTIC_FORCED_ELIGIBILITY is superseded: en-SG eligibility is now genuine; it never was product acceptance.",
      scenarios: rows.map((row) => ({
        locale: row.locale,
        scenario: row.scenario,
        fixtureId: row.fixture.id,
        view: { kind: row.fixture.view.kind, periods: row.fixture.view.periods.map((period) => ({ role: period.role, window: period.window, count: period.count, readingsListed: period.readings.length, summary: period.summary })), totalCount: row.fixture.view.totalCount },
        readingsOnPage: listedPerRow.get(`${row.locale}:${row.scenario}`) ?? 0,
        sharedBoundary: { ...row.fixture.view.sharedBoundary, shownAt: cutoffPrecision(row.fixture.view.sharedBoundary.instant) },
        task7PanelCopy: (({ heading, periods, boundaryNote, reconciliation }: SupportingReadingsCopy) => ({ label: TASK_7_MARK, heading, periods: periods.map((period) => ({ role: period.role, heading: period.heading, range: period.range, readingsListed: period.readings.length })), boundaryNote, reconciliation }))(panelCopyPerRow.get(`${row.locale}:${row.scenario}`)!),
        eligibility: { remote: row.plan.remote, before: { rule: HISTORICAL_SLOT_PLAN_VERSION, sum: row.before.sum, ceiling: row.before.ceiling, overBy: row.before.overBy }, after: { rule: CURRENT_SLOT_PLAN_VERSION, total: row.account.total, ceiling: row.account.ceiling, fields: row.account.fields } },
        currentBodySha: row.currentBodySha,
        currentBodyIsPinnedClass: row.currentBodySha === CURRENT_CLASS_BODY_SHA[row.locale],
        CURRENT_CONTRACT: modeJson(row.current),
        VERSION_NORMALISED_REPLAY: modeJson(row.normalised),
        deterministicR7: row.deterministicR7,
        reviewExcluded: row.excluded,
      })),
      openOwnerItems: ["7A VARIABILITY card now labelled IQR (Addendum B Task B4a; human acceptance pending)", "proposed IQR copy", "observation template exception", "date formats side by side", "boundary date in both periods", `Checkpoint 2 Task 6R: summary-role line ${AI_HYBRID_VERSIONS.languageCopy} (owner review)`, `Checkpoint 2 Task 7: ${TASK_7_MARK}; wired in the app since Addendum B (deterministic while NOT_ACTIVATED); B4a Singapore-time and foreign-offset presentation (human acceptance pending)`, `Addendum B Task B1a: care-draft notices printed in the hashed artifact under "${draftNoticeLabel["en-SG"]}" / "${draftNoticeLabel["zh-SG"]}" (human acceptance pending)`],
      resolvedAtContractFreeze: [`provider output-schema label ${AI_HYBRID_VERSIONS.providerSchema} (was kie-schema.11b.6; label only, in no model-facing body; coordinator ruling, owner may decide otherwise)`, `harness label ${AI_HYBRID_VERSIONS.evaluationReport} (was packet11-eval.18; eval.18 logic and policy)`, "live runner header comments state the current frozen contract (packet-11c-contract-freeze.test.ts pins it)"],
      minimumAdditionalEvidence: { requirementsAndOptions: MINIMUM_EVIDENCE, notMetBy: MINIMUM_EVIDENCE_NOT, decision: "NONE (owner)" },
      checkpoint2Prerequisite: CHECKPOINT_2_PREREQUISITE,
      checkpoint2PrerequisiteStatus: CHECKPOINT_2_PREREQUISITE_STATUS,
      processNote: VITE_NODE_NOTE,
      ownerDecisions: "UNRESOLVED",
    };

    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", `${OUTPUT_ROOT}/probe`], { stdio: "ignore" });
    } catch {
      throw new Error("REPLAY_ROOT_NOT_IGNORED");
    }
    const directory = resolve(process.cwd(), OUTPUT_ROOT);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const page = join(directory, `${stamp}-${LABEL}-review.html`);
    await writeFile(page, html, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(page, 0o600);
    const summaryPath = join(directory, `${stamp}-${LABEL}.json`);
    await writeFile(summaryPath, `${JSON.stringify({ ...summary, page: relative(process.cwd(), page), pageSha256: sha256(html) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(summaryPath, 0o600);
    console.log(JSON.stringify({ sourceBackedReplay: {
      page: relative(process.cwd(), page),
      summary: relative(process.cwd(), summaryPath),
      currentContract: rows.map((row) => `${row.locale} ${row.scenario}: ${triple(row.current.counts)} ${codeText(row.current.codes)}`),
      versionNormalised: rows.map((row) => `${row.locale} ${row.scenario}: ${triple(row.normalised.counts)} echo ${row.normalised.outcomes.reduce((sum, entry) => sum + entry.echoRewrites, 0)}`),
      deterministic: rows.map((row) => `${row.locale} ${row.scenario}: ${row.deterministicR7}`),
      sums: rows.map((row) => `${row.locale} ${row.scenario}: ${row.before.sum} -> ${row.account.total} / ${row.account.ceiling}`),
      historical: { pageSha256: historical.pageSha256, rows: historical.rows.map((row) => `${row.locale} ${row.scenario}: ${row.triple ?? "not counted (superseded forced-eligibility diagnostic)"}`) },
      digests: { current: currentDigest, normalised: normalisedDigest },
      providerCalls: network.mock.calls.length,
    } }));

    // --- assertions (after the evidence is written, so a failure is never hidden) ---
    expect(network).not.toHaveBeenCalled();
    expect(classCalls["en-SG"]).toHaveLength(9);
    expect(classCalls["zh-SG"]).toHaveLength(9);
    expect(currentDigest).toBe(CURRENT_FIXTURE_DIGEST);
    expect(normalisedDigest).toEqual({ digest: HISTORICAL_FIXTURE_DIGEST, occurrences: 70 * SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY });
    expect([historical.pageSha256, historical.recordedPageSha256]).toEqual([HISTORICAL_RUN.pageSha256, HISTORICAL_RUN.pageSha256]);
    // Only the 11b.8 service path counts: zh-SG 9/9/9; en-SG (superseded forced-eligibility diagnostic only) is never counted.
    expect(historical.rows.map((row) => [row.locale, row.scenario, row.counted, row.triple])).toEqual(
      LOCALES.flatMap((locale) => CHECKPOINT_1_SCENARIOS.map((scenario) => [locale, scenario, locale === "zh-SG", locale === "zh-SG" ? "9/9/9" : null])),
    );
    for (const row of rows) {
      const id = `${row.locale} ${row.scenario}`;
      expect(listedPerRow.get(`${row.locale}:${row.scenario}`), `${id}: every reading listed`).toBe(row.fixture.view.totalCount);
      const panelCopy = panelCopyPerRow.get(`${row.locale}:${row.scenario}`)!;
      expect(panelCopy, `${id}: Task 7 panel copy`).toEqual(supportingReadingsCopy(getMessages(row.locale), row.locale, row.fixture.view));
      expect([panelCopy.boundaryNote === null, panelCopy.periods.map((period) => period.range === null)], `${id}: cutoff shown`).toEqual([false, [false, false]]);
      expect(row.excluded, `${id}: review exclusions`).toBe(0);
      expect(row.account.total, `${id}: 11b.9 account within the ceiling`).toBeLessThanOrEqual(row.account.ceiling);
      expect(row.currentBodySha, `${id}: current body`).toBe(CURRENT_CLASS_BODY_SHA[row.locale]);
      expect(row.versionPaths, `${id}: version-only paths`).toHaveLength(SLOT_PLAN_VERSION_OCCURRENCES_PER_BODY);
      expect(row.deterministicR7, `${id}: deterministic r7`).toBe("ACCEPTED");
    }
    expect(rows.find((row) => row.scenario === "MANY_READINGS")!.fixture.view.periods.some((period) => period.readings.length > 32)).toBe(true);
    // Six scenarios x two locales, BOUNDARY_DAY included (9 + 7 = 16 in both locales).
    expect(rows.map((row) => `${row.locale} ${row.scenario}`)).toEqual(LOCALES.flatMap((locale) => SOURCE_BACKED_SCENARIOS.map((scenario) => `${locale} ${scenario}`)));
    expect(rows.filter((row) => row.scenario === "BOUNDARY_DAY").map((row) => panelCopyPerRow.get(`${row.locale}:BOUNDARY_DAY`)!.periods.map((period) => period.readings.length))).toEqual([[9, 7], [9, 7]]);
    // CURRENT_CONTRACT, as observed: every request equals the stored body after normalisation; no stored response validates (S2).
    expect(rows.map((row) => [row.locale, row.scenario, row.current.counts.requestsNormalisedIdentical, triple(row.current.counts), row.current.codes])).toEqual(
      rows.map((row) => [row.locale, row.scenario, 9, "0/0/0", { "S2:SCHEMA_INVALID": 9 }]),
    );
    // VERSION_NORMALISED_REPLAY, as observed: exactly one echo rewrite per response; any failure (an r7 rejection is a stop) is listed.
    const normalisedFailures = rows.flatMap((row) => row.normalised.outcomes.filter((entry) => entry.failure !== null).map((entry) => `${row.locale} ${row.scenario} seq ${entry.sequence}: ${entry.failure}`));
    expect(rows.map((row) => [row.locale, row.scenario, row.normalised.outcomes.map((entry) => entry.echoRewrites).join(""), row.normalised.counts.requestsNormalisedIdentical, triple(row.normalised.counts)]), `version-normalised failures: ${normalisedFailures.join("; ") || "none"}`).toEqual(
      rows.map((row) => [row.locale, row.scenario, String(RESPONSE_ECHO_OCCURRENCES_PER_RESPONSE).repeat(9), 9, "9/9/9"]),
    );
  }, 300_000);
});

describe("source-backed replay: the frozen Checkpoint 1 scenario list (ungated)", () => {
  it("is the current scenario list minus only the Task 6R BOUNDARY_DAY scenario, in order", () => {
    expect(CHECKPOINT_1_SCENARIOS.every((scenario) => SOURCE_BACKED_SCENARIOS.includes(scenario))).toBe(true);
    expect(SOURCE_BACKED_SCENARIOS.filter((scenario) => !CHECKPOINT_1_SCENARIOS.includes(scenario))).toEqual(["BOUNDARY_DAY"]);
    expect(SOURCE_BACKED_SCENARIOS.filter((scenario) => CHECKPOINT_1_SCENARIOS.includes(scenario))).toEqual([...CHECKPOINT_1_SCENARIOS]);
  });
});
