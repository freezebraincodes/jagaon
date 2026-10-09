import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import { aiInvocationAuditRowSchema, shellTaskRequestSchema, slotToken, type AiInvocationAuditRow, type ShellFieldPath } from "@/domain/ai";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import type { RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import { databases, FACT, higherFixture, NOW } from "@/application/history/history-test-support";
import type { PatternExplainerPort } from "@/components/jagaon/history/PatternExplanationPanel";
import { AI_ACTIVATION_MANIFEST, type AiActivationManifest } from "./ai-activation-manifest";
import { AI_SHELL_ACCESS_HEADER, AI_SHELL_ROUTE_PATH } from "./ai-shell-route-contract";
import * as wiring from "./browser-history-explainer";
import { createBrowserAiAssistance, createBrowserHistoryExplainer } from "./browser-history-explainer";
import type { BrowserShellFetcher } from "./browser-shell-client";
import { buildSourceBackedExplainRequest } from "./explain-pattern-request";
import { resolveAiHybridBundle } from "./ai-hybrid-runtime-bundles";
import { projectShellTaskRequest, shellPlanView } from "./language/shell-projector";
import { planSlots } from "./language/slot-planner";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import { createAiInvocationAuditRepository } from "./ai-audit-persistence";
import { AI_REQUEST_CLASS_DEFINITIONS } from "./request-class-definitions";
import { AI_REQUEST_CLASS_QUALIFICATION_RECORDS, createRequestClassGate, requestClassIdentity, SHIPPED_REQUEST_CLASS_GATE } from "./request-class-qualification";
// Packet 11C Addendum C (C1): every activated (test manifest) path below also injects test-only QUALIFIED records; the shipped records
// are all PENDING (proven in the C1 block).
import { qualifiedTestRequestClassGate } from "./request-class-test-support";
import { closeCarePreparationHarnesses, createCarePreparationHarness, ENABLED_CARE_MANIFEST, exact, fakeModelCareShells, testIds } from "@/application/care-preparation/care-preparation-test-support";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { projectValidatedAiCareSummary } from "@/application/care-preparation/ai-care-summary-replacement";
import type { CareSummaryAiWordingPort } from "@/components/jagaon/screens/CareSummaryPreviewScreen";

// Packet 11C B4b: a pass-through spy, so a test can count the hybrid services one wiring builds (behaviour unchanged).
vi.mock("./ai-hybrid-task-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-hybrid-task-service")>();
  return { ...actual, createAiHybridTaskService: vi.fn(actual.createAiHybridTaskService) };
});

/**
 * Packet 11C Addendum B, Task B2b: the browser wiring of the history explanation (one hybrid service, one pattern explainer). The shipped
 * app passes only the history and audit ports: the shipped manifest, the interim fail-closed disclosure and the browser network primitive.
 * Activated behaviour is exercised only with an injected test manifest and a fake fetcher; never a live provider.
 */

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalIDBKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalIDBKeyRange;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

const ENABLED: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } };
const USAGE = { inputTokens: 600, outputTokens: 80, costMicroUsd: 5 };

/** Packet 11C Addendum C (C6): a row's usage basis (current rows only; the wiring never writes a legacy row). */
const basisOf = (row: AiInvocationAuditRow) => ("usageBasis" in row ? row.usageBasis : "LEGACY");

function audit() {
  const rows: AiInvocationAuditRow[] = [];
  return { rows, port: { append: vi.fn(async (row: AiInvocationAuditRow) => void rows.push(row)) } };
}

/** A fake POST /api/ai/shell that answers valid value-blind shells for whatever approved request it receives. */
function fakeRoute() {
  return vi.fn<BrowserShellFetcher>(async (_url, init) => {
    const request = shellTaskRequestSchema.parse(JSON.parse(init.body as string));
    const plan = shellPlanView(request);
    const home = (path: ShellFieldPath) => plan.slots.find((slot) => slot.homeField === path)!.slotId;
    const candidate = shellCandidate(plan, new Map<ShellFieldPath, string>([["headline", `A look at ${slotToken(home("headline"))}.`], ["evidence", `This is based on ${slotToken(home("evidence"))}.`]]));
    return new Response(JSON.stringify({ kind: "CANDIDATE", candidate, retention: "CONFIRMED_NOT_STORED", usage: USAGE }), { headers: { "content-type": "application/json" } });
  });
}

describe("browser history explainer wiring (Packet 11C B2b)", () => {
  it("exports only its factories; it names no credential, endpoint, provider adapter or legacy service and sends nothing itself", () => {
    // Packet 11C B4b (deliberate retarget): plus the shared wiring of history and care-summary wording over ONE hybrid service.
    expect(Object.keys(wiring).sort()).toEqual(["createBrowserAiAssistance", "createBrowserHistoryExplainer"]);
    const source = readFileSync(join(process.cwd(), "src/application/ai/browser-history-explainer.ts"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(|process\.env|NEXT_PUBLIC_|API_KEY|https?:\/\/|@\/ai\/|@\/app\/|ai-task-service|createAiTaskService|detached-payload-projector|\/api\/ai\/task/);
    // The shipped defaults: the shipped manifest; Packet 11C Addendum C (C3): the per-request decisions, with no acceptance seam at all
    // (no session, no injectable disclosure): only a request's own explicit decision can accept remote use.
    expect(source).toMatch(/manifest \?\? AI_ACTIVATION_MANIFEST/);
    expect(source).toMatch(/const decisions = createAiRemoteUseDecisions\(\);/);
    // Packet 11C Addendum C (C6, deliberate): plus the in-memory passcode reader and the route-refusal listener (no acceptance seam).
    expect(source).toMatch(/createBrowserShellClient\(\{ disclosure: decisions\.disclosure, fetcher: dependencies\.fetcher, accessPasscode: passcode\.read, onRefusal \}\)/);
    expect(source).not.toMatch(/AiRemoteUseSession|createAiRemoteUseSession|dependencies\.disclosure|dependencies\.remoteUse|acceptDisclosure/);
  });

  it("is assignable to the history panel's explainer port", async () => {
    const { history } = await higherFixture();
    const port: PatternExplainerPort = createBrowserHistoryExplainer({ history, audit: audit().port });
    expect(typeof port.explain).toBe("function");
  });

  it("construction does nothing: no history read, no audit row, no network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const history: RecordedHistoryQueryPort = { load: vi.fn(), loadExplainablePattern: vi.fn() };
    const log = audit();
    createBrowserHistoryExplainer({ history, audit: log.port });
    expect(history.load).not.toHaveBeenCalled();
    expect(history.loadExplainablePattern).not.toHaveBeenCalled();
    expect(log.port.append).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([["en-SG"], ["zh-SG"]] as const)("shipped (%s): a DETERMINISTIC explanation, one audit row, no network call", async (locale) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const log = audit();
    const result = await createBrowserHistoryExplainer({ history, audit: log.port }).explain({ factId: FACT, locale });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(log.rows[0]).success).toBe(true);
    expect(log.rows[0]).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale, outcomeCode: "TASK_DISABLED", providerModel: null, attempts: { count: 0 }, sourceRevisions: [] });
  });

  it("every request gets its own request id and the clock's instant", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, now: () => NOW as Instant });
    await explainer.explain({ factId: FACT, locale: "en-SG" });
    await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(log.rows).toHaveLength(2);
    expect(log.rows[0]!.requestId).not.toBe(log.rows[1]!.requestId);
    expect(log.rows.map((row) => row.requestedAt)).toEqual([NOW, NOW]);
  });

  it("activated (test manifest): a request without its own decision is DETERMINISTIC, never a POST, audited REMOTE_USE_NOT_ACCEPTED (C3)", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    // The request reached the remote decision with no acceptance of its own: fail closed, and the row says so truthfully (C3; it was
    // MISSING_CONFIGURATION before, carried from the C5 review). The closed reason stays MISSING_CONFIGURATION (matrix codes unchanged).
    const result = await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.parse(log.rows[0])).toMatchObject({ outcomeCode: "REMOTE_USE_NOT_ACCEPTED", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], usageBasis: "NONE" });
  });

  it("activated with the request's own acceptance and a fake route: an AI explanation from one value-blind POST", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const result = await createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher }).explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(AI_SHELL_ROUTE_PATH);
    expect(fetcher.mock.calls[0]![1].body as string).not.toMatch(/periodSummary|facts|sources|revisionId|recordId|\d{4}-\d{2}-\d{2}/);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" }, measurements: USAGE });
  });

  it("offline (activated): DETERMINISTIC without a disclosure or a send, even for an accepted request", async () => {
    const { history } = await higherFixture();
    const fetcher = fakeRoute();
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, online: () => false });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    const result = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(result).not.toHaveProperty("remoteUse");
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows[0]!.outcomeCode).toBe("TRANSPORT_FAILED");
  });
});

/** The EXPLAIN class of this comparison's own request in `locale` (the same pure builder, planner and projection as the wiring). */
async function explainClassOf(history: RecordedHistoryQueryPort, locale: "en-SG" | "zh-SG"): Promise<string> {
  const loaded = await history.loadExplainablePattern({ factId: FACT });
  if (loaded.kind !== "EXPLAINABLE") throw new Error("fixture");
  const request = buildSourceBackedExplainRequest({ view: loaded.view, locale, requestId: "8b3d4e5f-6a70-4b1c-9d2e-000000000000", requestedAt: NOW as Instant });
  const planned = planSlots(request, resolveAiHybridBundle("EXPLAIN_PATTERN", locale));
  if (planned.kind !== "PLANNED") throw new Error("plan");
  return requestClassIdentity(projectShellTaskRequest(planned.plan)).classId;
}

/** A gate built over the shipped definitions with test-only owner records QUALIFIED for exactly `classIds` (all others PENDING). */
function gateQualifying(classIds: readonly string[]) {
  const signed = { evidenceRef: "test/evidence", signedOffBy: "test", signedOffAt: "2026-10-08T00:00:00.000Z" };
  return createRequestClassGate({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: AI_REQUEST_CLASS_QUALIFICATION_RECORDS.map((record) => (classIds.includes(record.classId) ? { ...record, status: "QUALIFIED" as const, ...signed } : record)) });
}

/**
 * Packet 11C Addendum C, Task C3 (owner decision: disclosure acceptance is per explicit request; one permitted structural repair shares
 * that request's decision; a new request needs a new decision). Replaces the B3 session disclosure. The screen asks
 * `disclosureRequired(request)` on the patient's action for THAT request (activated, online, remote switch not known off, and that
 * request's own class QUALIFIED) and shows the dialog BEFORE `explain`; its answer travels with that one request (`disclosure:
 * "ACCEPTED" | "DECLINED"`) and is bound to the request's own signal. Nothing else can accept.
 */
describe("browser history explainer: per-request disclosure (Packet 11C Addendum C, C3)", () => {
  it("never requires the disclosure while NOT_ACTIVATED (shipped manifest), reads nothing for it, and an accepted request still sends nothing", async () => {
    const { history } = await higherFixture();
    const probe = vi.fn((request: { factId: string }) => history.loadExplainablePattern(request));
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history: { load: history.load, loadExplainablePattern: probe }, audit: log.port });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    const result = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(result).not.toHaveProperty("remoteUse");
    expect(log.rows.map((row) => row.outcomeCode)).toEqual(["TASK_DISABLED"]);
  });

  it("activated: required for every request (asking twice answers twice); asking reads only the comparison, writes and sends nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const probe = vi.fn((request: { factId: string }) => history.loadExplainablePattern(request));
    const load = vi.fn(history.load);
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history: { load, loadExplainablePattern: probe }, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate() });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith({ factId: FACT });
    expect(load).not.toHaveBeenCalled();
    expect(log.port.append).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // A comparison that is not explainable, or a read that fails, needs no disclosure (nothing could be sent).
    const ineligible = createBrowserHistoryExplainer({ history: { load, loadExplainablePattern: async () => ({ kind: "INELIGIBLE" as const, reason: "STALE_SOURCE" as const }) }, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate() });
    expect(await ineligible.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    const failing = createBrowserHistoryExplainer({ history: { load, loadExplainablePattern: async () => Promise.reject(new Error("storage")) }, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate() });
    expect(await failing.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    expect(log.port.append).not.toHaveBeenCalled();
  });

  it("the admission is per request: only this comparison's own class in this locale counts, never 'some class of the task' (C1 carry)", async () => {
    const { history } = await higherFixture();
    const own = await explainClassOf(history, "en-SG");
    const others = AI_REQUEST_CLASS_DEFINITIONS.filter((definition) => definition.taskType === "EXPLAIN_PATTERN" && definition.classId !== own).map((definition) => definition.classId);
    const log = audit();
    const fetcher = fakeRoute();
    // Every OTHER EXPLAIN class is QUALIFIED (the C1 task-level check would have offered the dialog); this request's class is not.
    const elsewhere = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: gateQualifying(others), fetcher });
    expect(gateQualifying(others).anyAdmissible("EXPLAIN_PATTERN")).toBe(true);
    expect(await elsewhere.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    // Even if the screen sent an acceptance, the service refuses the class before the decision: nothing sent, one truthful row.
    expect(await elsewhere.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" })).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows.map((row) => [row.outcomeCode, row.attempts.count])).toEqual([["REQUEST_CLASS_NOT_QUALIFIED", 0]]);
    // Only this request's own en-SG class: offered in en-SG, not for the same comparison in zh-SG (a different request class).
    const ownOnly = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: gateQualifying([own]), fetcher });
    expect(await ownOnly.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(await ownOnly.disclosureRequired({ factId: FACT, locale: "zh-SG" })).toBe(false);
    // A gate that throws offers nothing.
    const throwing = { admit: () => { throw new Error("broken"); }, anyAdmissible: () => true };
    expect(await createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: throwing }).disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
  });

  it("the server-side remote switch check is pluggable (C6 may supply it): known off means no disclosure; a throwing check counts as off", async () => {
    const { history } = await higherFixture();
    let off = true;
    const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), remoteSwitchKnownOff: () => off });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    off = false;
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    const throwing = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), remoteSwitchKnownOff: () => { throw new Error("unknown"); } });
    expect(await throwing.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
  });

  it("C6 (coordinator addition): with the switch known off, an explicit request is audited REMOTE_AI_DISABLED, not REMOTE_USE_NOT_ACCEPTED; no POST", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, remoteSwitchKnownOff: () => true });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG" }, new AbortController().signal)).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows.map((row) => [row.outcomeCode, row.attempts.count, basisOf(row)])).toEqual([["REMOTE_AI_DISABLED", 0, "NONE"]]);
  });

  it("two consecutive requests need two decisions: an acceptance covers its own request only (one POST); the next is not accepted", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ source: "AI" });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG" }, new AbortController().signal)).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG" })).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The next explicit acceptance is its own new decision.
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ source: "AI" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(log.rows.map((row) => [row.outcomeCode, row.attempts.count])).toEqual([["ACCEPTED", 1], ["REMOTE_USE_NOT_ACCEPTED", 0], ["REMOTE_USE_NOT_ACCEPTED", 0], ["ACCEPTED", 1]]);
    expect(new Set(log.rows.map((row) => row.requestId)).size).toBe(4);
  });

  it("a repairable rejection under one acceptance: one decision, repaired once (two POSTs), one row", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const answer = fakeRoute();
    let posts = 0;
    const fetcher = vi.fn<BrowserShellFetcher>(async (url, init) => {
      posts += 1;
      if (posts === 1) return new Response(JSON.stringify({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: USAGE }), { headers: { "content-type": "application/json" } });
      return answer(url, init);
    });
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", attempts: { count: 2, structuralRepairUsed: true, timedOut: false } });
  });

  it("an aborted request (a new click, Retry, locale, period or view change, unmount) carries no acceptance: nothing sent", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    const controller = new AbortController();
    const pending = explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: "UNAVAILABLE", reason: "CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("not accepted (no decision of its own): the deterministic explanation marked not used, no POST, one REMOTE_USE_NOT_ACCEPTED row with no attempt", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    const result = await explainer.explain({ factId: FACT, locale: "zh-SG" }, new AbortController().signal);
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(log.rows[0]).success).toBe(true);
    expect(log.rows[0]).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "zh-SG", outcomeCode: "REMOTE_USE_NOT_ACCEPTED", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], usageBasis: "NONE" });
    expect(log.rows[0]!.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
  });

  it("accepted: an AI explanation from one value-blind POST, the D2 identity and the sources in the audit row", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    const result = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(result).not.toHaveProperty("remoteUse");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" }, attempts: { count: 1 } });
    expect(log.rows[0]!.sourceRevisions.length).toBeGreaterThan(0);
  });

  it("Packet 11C B4a: an explicit decline (the dialog's Cancel) is audited (C5: as REMOTE_USE_DECLINED); nothing sent; it covers that request only", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    const result = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "DECLINED" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(log.rows[0]).success).toBe(true);
    // Packet 11C Addendum C (C5): the truthful audit-only outcome (REQUEST_CANCELLED under the B4a interim ruling).
    expect(log.rows[0]).toMatchObject({ auditSchemaVersion: "ai-invocation-audit.11c.2", outcomeCode: "REMOTE_USE_DECLINED", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], usageBasis: "NONE" });
    expect(log.rows[0]!.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });

    // The decline belongs to that one request: the next request without a decision is the not-accepted (fail-closed) path (C3).
    await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(log.rows[1]).toMatchObject({ outcomeCode: "REMOTE_USE_NOT_ACCEPTED", attempts: { count: 0 } });
    // A decline never overrides into a send, even after another request was accepted (each decision is its own request's answer).
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "DECLINED" }, new AbortController().signal);
    expect(log.rows.map((row) => row.outcomeCode)).toEqual(["REMOTE_USE_DECLINED", "REMOTE_USE_NOT_ACCEPTED", "ACCEPTED", "REMOTE_USE_DECLINED"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Packet 11C B5 / C3: a reused AbortSignal never carries a decision into a later request; a declined signal stays DECLINED (fails safe)", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    // C3: an accepted signal reused for a later request carries no acceptance (and a second acceptance on it is refused).
    const acceptedOnce = new AbortController().signal;
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, acceptedOnce)).toMatchObject({ source: "AI" });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG" }, acceptedOnce)).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, acceptedOnce)).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    log.rows.splice(0);
    fetcher.mockClear();
    const reused = new AbortController().signal;
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "DECLINED" }, reused);
    // The same signal without the decline flag: still DECLINED, deterministic and nothing sent (never an unintended send).
    const again = await explainer.explain({ factId: FACT, locale: "en-SG" }, reused);
    expect(again).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(log.rows.map((row) => [row.outcomeCode, row.attempts.count])).toEqual([["REMOTE_USE_DECLINED", 0], ["REMOTE_USE_DECLINED", 0]]);
    expect(fetcher).not.toHaveBeenCalled();
    // A fresh signal per request (what every caller does) with its own acceptance sends one value-blind POST.
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Packet 11C B4a: never requires the disclosure while offline (nothing would be sent)", async () => {
    const { history } = await higherFixture();
    let online = false;
    const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), online: () => online });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    online = true;
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
  });

  it("there is no acceptance seam: no session, no injectable disclosure; an unknown decision value is no decision", async () => {
    const { history } = await higherFixture();
    const fetcher = fakeRoute();
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, ...({ disclosure: { decide: async () => "ACCEPTED" }, remoteUse: { accepted: () => true } } as object) });
    // Packet 11C Addendum C (C6, deliberate): plus the in-memory demo passcode entry (it accepts nothing).
    expect(Object.keys(explainer).sort()).toEqual(["accessPasscode", "disclosureClosed", "disclosureRequired", "explain"]);
    expect(await explainer.explain({ factId: FACT, locale: "en-SG" })).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "accepted" as never })).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows.map((row) => row.outcomeCode)).toEqual(["REMOTE_USE_NOT_ACCEPTED", "REMOTE_USE_NOT_ACCEPTED"]);
  });
});

/**
 * Packet 11C Addendum C, Task C6: the demo passcode (entered in the disclosure, held in this runtime's memory only, sent as a header on
 * each remote POST) and the server switch learned from the route's own refusal (boolean only; the route stays the enforcement point).
 */
describe("browser AI assistance: demo passcode and the server switch (Packet 11C Addendum C, C6)", () => {
  const PASSCODE = "TEST-ONLY-passcode-value";
  const refusing = (reason: string) => vi.fn<BrowserShellFetcher>(async () => new Response(JSON.stringify({ kind: "REFUSED", reason, notSentToProvider: true }), { status: 403, headers: { "content-type": "application/json" } }));
  const headerOf = (fetcher: ReturnType<typeof vi.fn<BrowserShellFetcher>>, call = 0) => (fetcher.mock.calls[call]![1].headers as Record<string, string>)[AI_SHELL_ACCESS_HEADER];

  it("the passcode entry is needed until provided, held in this runtime's memory and sent as a header on each remote POST", async () => {
    const { history } = await higherFixture();
    const fetcher = fakeRoute();
    const assistance = createBrowserAiAssistance({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    const entry = assistance.history.accessPasscode;
    expect(entry.needed()).toBe(true);
    // Not a sendable header value: refused, still needed.
    for (const invalid of ["", "pässcode", "two words", "x".repeat(129)]) expect(entry.provide(invalid), invalid).toBe(false);
    expect(entry.needed()).toBe(true);
    // Before any passcode, an accepted request is sent without one (the route refuses it: ACCESS_DENIED).
    await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(headerOf(fetcher, 0)).toBeUndefined();
    expect(entry.provide(PASSCODE)).toBe(true);
    expect(entry.needed()).toBe(false);
    await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    await assistance.history.explain({ factId: FACT, locale: "zh-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect([headerOf(fetcher, 1), headerOf(fetcher, 2)]).toEqual([PASSCODE, PASSCODE]);
    for (const [, init] of fetcher.mock.calls) expect(String(init.body)).not.toContain(PASSCODE);
    // A new runtime starts without it (never persisted).
    expect(createBrowserAiAssistance({ history, audit: audit().port, manifest: ENABLED }).history.accessPasscode.needed()).toBe(true);
  });

  it("an ACCESS_DENIED refusal forgets the passcode (the next disclosure asks again) and is audited ACCESS_DENIED with no attempt", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = refusing("ACCESS_DENIED");
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    explainer.accessPasscode.provide("TEST-ONLY-wrong-passcode");
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(explainer.accessPasscode.needed()).toBe(true);
    expect(log.rows.map((row) => [row.outcomeCode, row.attempts.count, basisOf(row), row.providerModel])).toEqual([["ACCESS_DENIED", 0, "NONE", null]]);
  });

  it("a REMOTE_AI_DISABLED refusal is the client's switch signal: no further disclosure or POST; later requests are audited REMOTE_AI_DISABLED", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = refusing("REMOTE_AI_DISABLED");
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    await explainer.explain({ factId: FACT, locale: "en-SG" }, new AbortController().signal);
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log.rows.map((row) => [row.outcomeCode, row.attempts.count, basisOf(row)])).toEqual([["REMOTE_AI_DISABLED", 0, "NONE"], ["REMOTE_AI_DISABLED", 0, "NONE"], ["REMOTE_AI_DISABLED", 0, "NONE"]]);
  });

  it("other refusals change no client state (the route decides every request again)", async () => {
    const { history } = await higherFixture();
    for (const reason of ["ORIGIN_REJECTED", "SPEND_CEILING_REACHED", "SPEND_NOT_CONFIGURED", "SPEND_LEDGER_UNAVAILABLE", "REQUEST_CLASS_NOT_QUALIFIED"]) {
      const log = audit();
      const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher: refusing(reason) });
      explainer.accessPasscode.provide(PASSCODE);
      await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
      expect(explainer.accessPasscode.needed(), reason).toBe(false);
      expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" }), reason).toBe(true);
      expect(log.rows.map((row) => [row.outcomeCode, row.attempts.count]), reason).toEqual([[reason, 0]]);
    }
  });

  it("the passcode is never persisted or logged: no storage API, no console, nothing in an audit row", async () => {
    const source = readFileSync(join(process.cwd(), "src/application/ai/browser-history-explainer.ts"), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
    const { history } = await higherFixture();
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher: fakeRoute() });
    explainer.accessPasscode.provide(PASSCODE);
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(JSON.stringify(log.rows)).not.toContain(PASSCODE);
  });
});

/**
 * Packet 11C Addendum B, Task B4b: the care-summary AI wording shares the history explanation's wiring: ONE hybrid service (the same
 * browser shell client, session disclosure and audit port) behind both flows. The care flow is `composeCareSummaryWithAi` over the
 * runtime's care-preparation ports. Shipped manifest: never available, never a disclosure, never a POST, never a replacement. Activated
 * behaviour only with an injected test manifest and a fake route.
 */
describe("browser AI assistance: care-summary wording (Packet 11C B4b)", () => {
  afterEach(() => closeCarePreparationHarnesses());

  const LATER = "2026-10-04T02:05:00.000Z" as Instant;
  const BOTH: AiActivationManifest = { ...ENABLED_CARE_MANIFEST, tasks: { ...ENABLED_CARE_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } };
  const glucosePayload = { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L" as const, normalization: null }, measurementMethod: "FINGERSTICK_METER" as const, context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const } };

  /** A fake POST /api/ai/shell answering valid care shells (fake model wording) for whatever approved request it receives. */
  function fakeCareRoute() {
    return vi.fn<BrowserShellFetcher>(async (_url, init) => {
      const plan = shellPlanView(shellTaskRequestSchema.parse(JSON.parse(init.body as string)));
      const candidate = shellCandidate(plan, fakeModelCareShells(plan));
      return new Response(JSON.stringify({ kind: "CANDIDATE", candidate, retention: "CONFIRMED_NOT_STORED", usage: USAGE }), { headers: { "content-type": "application/json" } });
    });
  }

  /** A current unapproved deterministic preview (one reading and the questions; or questions only, which has nothing to phrase). */
  async function careSetup(options: { questionsOnly?: boolean } = {}) {
    const h = await createCarePreparationHarness();
    const commands = createCarePreparationService(h.database, { now: () => LATER, ids: testIds, projectAiCareSummary: projectValidatedAiCareSummary });
    const audits = createAiInvocationAuditRepository(h.database);
    const reading = await h.journal.recordGlucose({ payload: glucosePayload, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: LATER });
    const question = await h.organisation.createCareQuestion({ questionText: { text: "Can I keep the pen in my bag? (demo)", language: "en-SG" } });
    if (reading.kind !== "COMMITTED" || question.kind !== "COMMITTED") throw new Error("fixture");
    const selection = await h.selection();
    const prepared = await commands.prepare(options.questionsOnly ? { ...selection, appointment: null, groups: [] } : selection);
    if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    const snapshotRef = { recordId: prepared.recordId, expectedRevisionId: prepared.revisionId, expectedRevisionNumber: prepared.revisionNumber };
    const snapshots = async () => (await h.database.table("recordHeads").where("recordType").equals("CARE_SUMMARY_SNAPSHOT").count()) as number;
    return { h, audits, carePreparation: { query: h.query, commands }, snapshotRef, payload: view.payload, snapshots };
  }

  it("builds exactly ONE hybrid service for both flows; construction reads, writes and sends nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careSetup();
    const history: RecordedHistoryQueryPort = { load: vi.fn(), loadExplainablePattern: vi.fn() };
    const query = { loadSummary: vi.fn(care.carePreparation.query.loadSummary) };
    const before = vi.mocked(createAiHybridTaskService).mock.calls.length;
    const assistance = createBrowserAiAssistance({ history, carePreparation: { query, commands: care.carePreparation.commands }, audit: care.audits });
    expect(vi.mocked(createAiHybridTaskService).mock.calls.length - before).toBe(1);
    // The one service's provider is the browser shell client behind the per-request decisions (C3), writing to the one audit port.
    const deps = vi.mocked(createAiHybridTaskService).mock.calls.at(-1)![0];
    expect(deps.audit).toBe(care.audits);
    expect(deps.provider?.providerModel).toEqual({ providerKey: "deepseek", modelSnapshot: "deepseek-flash" });
    expect(assistance.careSummary).not.toBeNull();
    expect(query.loadSummary).not.toHaveBeenCalled();
    expect(history.load).not.toHaveBeenCalled();
    expect(await care.audits.list()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Without the care-preparation ports the history flow is unchanged and there is no care wording.
    expect(createBrowserAiAssistance({ history, audit: care.audits }).careSummary).toBeNull();
  });

  describe("Packet 11C Addendum C, C1: unqualified request classes, before any disclosure or send", () => {
    it("the production default (no gate: the shipped, all-PENDING records), even activated and accepted: no disclosure, no POST, one REQUEST_CLASS_NOT_QUALIFIED row per flow", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const care = await careSetup();
      const { history } = await higherFixture();
      const fetcher = fakeCareRoute();
      const before = vi.mocked(createAiHybridTaskService).mock.calls.length;
      const assistance = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, fetcher, now: () => LATER });
      // The one service gets the shipped gate.
      expect(vi.mocked(createAiHybridTaskService).mock.calls.slice(before).map((call) => call[0].requestClassGate)).toEqual([SHIPPED_REQUEST_CLASS_GATE]);
      expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      // Packet 11C Addendum C (C3, C1 carry): the care AI action is hidden when this preview's class is not QUALIFIED (shipped: never shown).
      expect(assistance.careSummary!.available(care.payload)).toBe(false);
      expect(assistance.careSummary!.disclosureRequired(care.payload)).toBe(false);
      // Even with an explicit per-request acceptance, the class decides first: nothing is sent.
      expect(await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" })).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
      expect(await assistance.careSummary!.compose({ snapshotRef: care.snapshotRef, locale: "en-SG", disclosure: "ACCEPTED" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "TASK_DISABLED" });
      expect(fetcher).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await care.snapshots()).toBe(1);
      const rows = await care.audits.list();
      expect(rows.map((row) => [row.taskType, row.outcomeCode, row.attempts.count, row.providerModel, row.sourceRevisions.length, (row as { usageBasis?: string }).usageBasis]).sort()).toEqual([
        ["DRAFT_CARE_PREPARATION_SUMMARY", "REQUEST_CLASS_NOT_QUALIFIED", 0, null, 0, "NONE"],
        ["EXPLAIN_PATTERN", "REQUEST_CLASS_NOT_QUALIFIED", 0, null, 0, "NONE"],
      ]);
      for (const row of rows) expect(aiInvocationAuditRowSchema.safeParse(row).success).toBe(true);
    });

    it("the care action and disclosure are offered only for this preview's own QUALIFIED class; the history disclosure only for that comparison's own class", async () => {
      const care = await careSetup();
      const { history } = await higherFixture();
      const load = vi.fn(history.load);
      const ports: RecordedHistoryQueryPort = { load, loadExplainablePattern: (request) => history.loadExplainablePattern(request) };
      // An owner record for this comparison's own EXPLAIN class and for one care class that is NOT this preview's (its section counts
      // differ from every evaluated class): the history request may disclose; the care preview may not, and its action is hidden.
      const explain = await explainClassOf(history, "en-SG");
      const careClass = AI_REQUEST_CLASS_DEFINITIONS.find((definition) => definition.taskType === "DRAFT_CARE_PREPARATION_SUMMARY")!.classId;
      const assistance = createBrowserAiAssistance({ history: ports, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: gateQualifying([explain, careClass]), now: () => LATER });
      expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
      expect(assistance.careSummary!.available(care.payload)).toBe(false);
      expect(assistance.careSummary!.disclosureRequired(care.payload)).toBe(false);
      // The test-only gate qualifies this preview's class: the action and the disclosure are offered.
      const qualified = createBrowserAiAssistance({ history: ports, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), now: () => LATER });
      expect(qualified.careSummary!.available(care.payload)).toBe(true);
      expect(qualified.careSummary!.disclosureRequired(care.payload)).toBe(true);
      // A gate that throws offers nothing. The probes read nothing beyond the comparison, and write and send nothing.
      const throwing = { admit: () => { throw new Error("broken"); }, anyAdmissible: () => { throw new Error("broken"); } };
      const broken = createBrowserAiAssistance({ history: ports, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: throwing, now: () => LATER });
      expect(await broken.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      expect(broken.careSummary!.available(care.payload)).toBe(false);
      expect(broken.careSummary!.disclosureRequired(care.payload)).toBe(false);
      expect(load).not.toHaveBeenCalled();
      expect(await care.audits.list()).toEqual([]);
    });

    it("the shipped app passes no request-class gate (production uses the shipped records)", () => {
      const app = readFileSync(join(process.cwd(), "src/components/jagaon/JagaOnApp.tsx"), "utf8");
      // Packet 11C Addendum C (C3, deliberate retarget): no session either; the app passes exactly the three runtime ports.
      expect(app).toMatch(/aiAssistanceFactory\(\{ history: runtime\.history, carePreparation: runtime\.carePreparation, audit: runtime\.aiAudit \}\)/);
      expect(app).not.toMatch(/remoteUse|RemoteUseSession|acceptDisclosure/);
      expect(app).not.toMatch(/requestClassGate|request-class/);
      const wiringSource = readFileSync(join(process.cwd(), "src/application/ai/browser-history-explainer.ts"), "utf8");
      expect(wiringSource).toMatch(/const requestClassGate = dependencies\.requestClassGate \?\? SHIPPED_REQUEST_CLASS_GATE;/);
    });
  });

  it("is assignable to the care-summary preview's wording port", async () => {
    const care = await careSetup();
    const port: CareSummaryAiWordingPort | null = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits }).careSummary;
    expect(typeof port?.compose).toBe("function");
  });

  it("shipped manifest: never available, never a disclosure; an explicit request keeps the deterministic preview, one audit row, no POST", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careSetup();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, now: () => LATER }).careSummary!;
    expect(wording.available(care.payload)).toBe(false);
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    expect(await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG", disclosure: "ACCEPTED" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "TASK_DISABLED" });
    expect(await care.snapshots()).toBe(1);
    expect((await care.audits.list()).map((row) => [row.taskType, row.outcomeCode, row.attempts.count, row.providerModel])).toEqual([["DRAFT_CARE_PREPARATION_SUMMARY", "TASK_DISABLED", 0, null]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("activated (test manifest): available only online and with the remote switch not known off; the disclosure is required for every request", async () => {
    const care = await careSetup();
    let online = true;
    let switchOff = false;
    const assistance = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), online: () => online, remoteSwitchKnownOff: () => switchOff });
    const wording = assistance.careSummary!;
    expect(wording.available(care.payload)).toBe(true);
    expect(wording.disclosureRequired(care.payload)).toBe(true);
    expect(wording.disclosureRequired(care.payload)).toBe(true);
    online = false;
    expect(wording.available(care.payload)).toBe(false);
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    online = true;
    switchOff = true;
    expect(wording.available(care.payload)).toBe(false);
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    switchOff = false;
    // Only the care task's own activation counts.
    const historyOnly = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate() });
    expect(historyOnly.careSummary!.available(care.payload)).toBe(false);
    expect(historyOnly.careSummary!.disclosureRequired(care.payload)).toBe(false);
    expect(await care.audits.list()).toEqual([]);
  });

  it("C3: an acceptance in one flow never covers the other flow (both directions); each flow's next request needs its own decision", async () => {
    const care = await careSetup();
    const { history } = await higherFixture();
    const fetcher = vi.fn<BrowserShellFetcher>(async (url, init) => ((JSON.parse(init.body as string) as { taskType: string }).taskType === "EXPLAIN_PATTERN" ? fakeRoute() : fakeCareRoute())(url, init));
    const assistance = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER });
    // An accepted history request is in flight while the care request (no decision of its own) runs: the care request sends nothing.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slowHistory = vi.fn<BrowserShellFetcher>(async (url, init) => (await held, fetcher(url, init)));
    const concurrent = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher: slowHistory, now: () => LATER });
    const accepted = concurrent.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    await vi.waitFor(() => expect(slowHistory).toHaveBeenCalledTimes(1));
    expect(await concurrent.careSummary!.compose({ snapshotRef: care.snapshotRef, locale: "en-SG" }, new AbortController().signal)).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "MISSING_CONFIGURATION" });
    release();
    expect(await accepted).toMatchObject({ source: "AI" });
    expect(slowHistory).toHaveBeenCalledTimes(1);
    // The reverse: an accepted care request does not cover the next history request.
    const care2 = await careSetup();
    const reverse = createBrowserAiAssistance({ history, carePreparation: care2.carePreparation, audit: care2.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER });
    expect((await reverse.careSummary!.compose({ snapshotRef: care2.snapshotRef, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).kind).toBe("REPLACED");
    expect(await reverse.history.explain({ factId: FACT, locale: "en-SG" }, new AbortController().signal)).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher.mock.calls.map((call) => (JSON.parse(call[1].body as string) as { taskType: string }).taskType)).toEqual(["EXPLAIN_PATTERN", "DRAFT_CARE_PREPARATION_SUMMARY"]);
    expect((await care.audits.list()).map((row) => `${row.taskType}:${row.outcomeCode}`).sort()).toEqual(["DRAFT_CARE_PREPARATION_SUMMARY:REMOTE_USE_NOT_ACCEPTED", "EXPLAIN_PATTERN:ACCEPTED"]);
    expect((await care2.audits.list()).map((row) => `${row.taskType}:${row.outcomeCode}`).sort()).toEqual(["DRAFT_CARE_PREPARATION_SUMMARY:ACCEPTED", "EXPLAIN_PATTERN:REMOTE_USE_NOT_ACCEPTED"]);
  });

  it("activated and accepted: one value-blind POST and the AI-assisted replacement preview (PREPARED; approval untouched)", async () => {
    const care = await careSetup();
    const fetcher = fakeCareRoute();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER }).careSummary!;
    const outcome = await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG", disclosure: "ACCEPTED" });
    if (outcome.kind !== "REPLACED") throw new Error(JSON.stringify(outcome));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(AI_SHELL_ROUTE_PATH);
    expect(fetcher.mock.calls[0]![1].body as string).not.toMatch(/6\.6|mmol|pen in my bag|revisionId|recordId|\d{4}-\d{2}-\d{2}/);
    const replaced = await care.carePreparation.query.loadSummary(outcome.recordId);
    expect(replaced.status === "READY" && [replaced.snapshotStatus, replaced.payload.composition.method, replaced.payload.patientApproval.state]).toEqual(["PREPARED", "AI_ASSISTED", "NOT_APPROVED"]);
    const old = await care.carePreparation.query.loadSummary(care.snapshotRef.recordId);
    expect(old.status === "READY" && old.snapshotStatus).toBe("SUPERSEDED");
    expect((await care.audits.list()).map((row) => [row.outcomeCode, row.providerModel])).toEqual([["ACCEPTED", { providerKey: "deepseek", modelSnapshot: "deepseek-flash" }]]);
  });

  it("an explicit decline (the dialog's Cancel): nothing sent, no replacement, one REMOTE_USE_DECLINED audit row (C5) with no attempt", async () => {
    const care = await careSetup();
    const fetcher = fakeCareRoute();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER }).careSummary!;
    expect(await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG", disclosure: "DECLINED" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "REQUEST_CANCELLED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await care.snapshots()).toBe(1);
    const rows = await care.audits.list();
    expect(rows.map((row) => [row.outcomeCode, row.attempts.count, row.providerModel, row.sourceRevisions.length])).toEqual([["REMOTE_USE_DECLINED", 0, null, 0]]);
  });

  // Packet 11C Addendum C (C5; owner decision (e) resolved: each explicit request writes one audit row, including zero-attempt ones).
  it("a preview with nothing to phrase is not eligible: no action, no disclosure, no hybrid call, no POST, and one NOT_ELIGIBLE audit row (C5)", async () => {
    const care = await careSetup({ questionsOnly: true });
    const fetcher = fakeCareRoute();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER }).careSummary!;
    // Packet 11C Addendum C (C3): no request of this preview could be sent, so its AI action is not offered either.
    expect(wording.available(care.payload)).toBe(false);
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    // The eligibility probes are not requests: still no row.
    expect(await care.audits.list()).toEqual([]);
    expect(await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG" })).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOTHING_TO_PHRASE" });
    expect(fetcher).not.toHaveBeenCalled();
    const rows = await care.audits.list();
    expect(rows.map((row) => [row.taskType, row.locale, row.outcomeCode, row.attempts.count, row.providerModel, row.sourceRevisions.length, (row as { usageBasis?: string }).usageBasis])).toEqual([["DRAFT_CARE_PREPARATION_SUMMARY", "en-SG", "NOT_ELIGIBLE", 0, null, 0, "NONE"]]);
  });

  it("C5: a care disclosure closed as moot writes one DISCLOSURE_CLOSED_MOOT row for the request's locale; nothing sent", async () => {
    const care = await careSetup();
    const fetcher = fakeCareRoute();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER }).careSummary!;
    await wording.disclosureClosed({ locale: "zh-SG" });
    const rows = await care.audits.list();
    expect(rows.map((row) => [row.taskType, row.locale, row.outcomeCode, row.attempts.count, row.providerModel])).toEqual([["DRAFT_CARE_PREPARATION_SUMMARY", "zh-SG", "DISCLOSURE_CLOSED_MOOT", 0, null]]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

/** Packet 11C Addendum C, Task C5: every explicit history request writes exactly one audit row; the background probes write none. */
describe("browser history explainer: one audit row per explicit request (Packet 11C Addendum C, C5)", () => {
  it("an explanation asked for a comparison that is no longer explainable writes one NOT_ELIGIBLE row; nothing sent", async () => {
    const log = audit();
    const fetcher = fakeRoute();
    const history: RecordedHistoryQueryPort = { load: vi.fn(), loadExplainablePattern: vi.fn(async () => ({ kind: "INELIGIBLE" as const, reason: "STALE_SOURCE" as const })) };
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => NOW as Instant });
    expect(await explainer.explain({ factId: FACT, locale: "zh-SG", disclosure: "ACCEPTED" })).toMatchObject({ kind: "UNAVAILABLE" });
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.parse(log.rows[0])).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "zh-SG", outcomeCode: "NOT_ELIGIBLE", providerModel: null, attempts: { count: 0 }, sourceRevisions: [], usageBasis: "NONE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a disclosure closed as moot writes one DISCLOSURE_CLOSED_MOOT row; the probes (disclosureRequired) write none", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => NOW as Instant });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(log.rows).toHaveLength(0);
    await explainer.disclosureClosed({ locale: "en-SG" });
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.parse(log.rows[0])).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcomeCode: "DISCLOSURE_CLOSED_MOOT", providerModel: null, attempts: { count: 0 }, usageBasis: "NONE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shipped manifest: the probes never write; one explicit explanation writes exactly one row", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port });
    await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" });
    await history.loadExplainablePattern({ factId: FACT });
    expect(log.rows).toHaveLength(0);
    await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(log.rows.map((row) => row.outcomeCode)).toEqual(["TASK_DISABLED"]);
  });
});
