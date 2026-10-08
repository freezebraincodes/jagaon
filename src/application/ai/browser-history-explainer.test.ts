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
import { AI_SHELL_ROUTE_PATH } from "./ai-shell-route-contract";
import * as wiring from "./browser-history-explainer";
import { createBrowserAiAssistance, createBrowserHistoryExplainer } from "./browser-history-explainer";
import { createAiRemoteUseSession, type AiRemoteUseDisclosure, type BrowserShellFetcher } from "./browser-shell-client";
import { shellPlanView } from "./language/shell-projector";
import { createAiHybridTaskService } from "./ai-hybrid-task-service";
import { createAiInvocationAuditRepository } from "./ai-audit-persistence";
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
const ACCEPTED: AiRemoteUseDisclosure = { decide: async () => "ACCEPTED" };
const USAGE = { inputTokens: 600, outputTokens: 80, costMicroUsd: 5 };

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
    // The shipped defaults: the shipped manifest and the interim fail-closed disclosure.
    expect(source).toMatch(/manifest \?\? AI_ACTIVATION_MANIFEST/);
    expect(source).toMatch(/disclosure \?\? INTERIM_FAIL_CLOSED_DISCLOSURE/);
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

  it("activated (test manifest) with the default interim disclosure: still DETERMINISTIC and never a POST; the audit row records nothing sent", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, fetcher });
    // Without a session there is nothing the patient could accept: no dialog is offered and remote use fails closed.
    expect(explainer.disclosureRequired()).toBe(false);
    const result = await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ outcomeCode: "MISSING_CONFIGURATION", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [] });
  });

  it("activated with a test-only accepted disclosure and a fake route: an AI explanation from one value-blind POST", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const result = await createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, disclosure: ACCEPTED, fetcher }).explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(AI_SHELL_ROUTE_PATH);
    expect(fetcher.mock.calls[0]![1].body as string).not.toMatch(/periodSummary|facts|sources|revisionId|recordId|\d{4}-\d{2}-\d{2}/);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" }, measurements: USAGE });
  });

  it("offline (activated): DETERMINISTIC without asking the disclosure or sending", async () => {
    const { history } = await higherFixture();
    const decide = vi.fn<AiRemoteUseDisclosure["decide"]>(async () => "ACCEPTED");
    const fetcher = fakeRoute();
    const log = audit();
    const result = await createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, disclosure: { decide }, fetcher, online: () => false }).explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(decide).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows[0]!.outcomeCode).toBe("TRANSPORT_FAILED");
  });
});

/**
 * Packet 11C Addendum B, Task B3: the session disclosure. The app passes one in-memory session per app session; the screen asks
 * `disclosureRequired()` on the patient's action and shows the dialog BEFORE `explain` (so before the hybrid service and its timers).
 * Accepting records the session's acceptance; cancelling still explains, deterministically, with nothing sent.
 */
describe("browser history explainer: session disclosure (Packet 11C B3)", () => {
  it("never requires the disclosure while NOT_ACTIVATED (shipped manifest), even with a session that has not accepted", async () => {
    const { history } = await higherFixture();
    const remoteUse = createAiRemoteUseSession();
    const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, remoteUse });
    expect(explainer.disclosureRequired()).toBe(false);
    const result = await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(result).not.toHaveProperty("remoteUse");
  });

  it("activated: required until accepted, then not again for the session; asking reads, writes and sends nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const history: RecordedHistoryQueryPort = { load: vi.fn(), loadExplainablePattern: vi.fn() };
    const log = audit();
    const remoteUse = createAiRemoteUseSession();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, remoteUse });
    expect(explainer.disclosureRequired()).toBe(true);
    expect(explainer.disclosureRequired()).toBe(true);
    expect(remoteUse.accepted()).toBe(false);
    explainer.acceptDisclosure();
    expect(remoteUse.accepted()).toBe(true);
    expect(explainer.disclosureRequired()).toBe(false);
    // Another explainer over the same session (a re-opened dataset): the session's acceptance holds.
    expect(createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, remoteUse }).disclosureRequired()).toBe(false);
    expect(history.load).not.toHaveBeenCalled();
    expect(history.loadExplainablePattern).not.toHaveBeenCalled();
    expect(log.port.append).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cancelled (not accepted): the deterministic explanation marked not used, no POST, one audit row with no attempt, provider or source", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const remoteUse = createAiRemoteUseSession();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, remoteUse, fetcher });
    const result = await explainer.explain({ factId: FACT, locale: "zh-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(log.rows[0]).success).toBe(true);
    expect(log.rows[0]).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "zh-SG", outcomeCode: "MISSING_CONFIGURATION", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [] });
    expect(log.rows[0]!.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
  });

  it("accepted: an AI explanation from one value-blind POST, the D2 identity and the sources in the audit row", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const remoteUse = createAiRemoteUseSession();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, remoteUse, fetcher });
    explainer.acceptDisclosure();
    const result = await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(result).not.toHaveProperty("remoteUse");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" }, attempts: { count: 1 } });
    expect(log.rows[0]!.sourceRevisions.length).toBeGreaterThan(0);
  });

  it("Packet 11C B4a: an explicit decline (the dialog's Cancel) is audited as REQUEST_CANCELLED; nothing sent; the session is not changed", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const remoteUse = createAiRemoteUseSession();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, remoteUse, fetcher });
    const result = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "DECLINED" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(remoteUse.accepted()).toBe(false);
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(log.rows[0]).success).toBe(true);
    expect(log.rows[0]).toMatchObject({ outcomeCode: "REQUEST_CANCELLED", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [] });
    expect(log.rows[0]!.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });

    // The decline belongs to that one request: the next request without it is the ordinary not-accepted (fail-closed) path.
    await explainer.explain({ factId: FACT, locale: "en-SG" });
    expect(log.rows[1]).toMatchObject({ outcomeCode: "MISSING_CONFIGURATION", attempts: { count: 0 } });
    // A decline never overrides into a send, even after the session accepted (each decline is its own request's answer).
    explainer.acceptDisclosure();
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "DECLINED" }, new AbortController().signal);
    expect(log.rows[2]).toMatchObject({ outcomeCode: "REQUEST_CANCELLED", attempts: { count: 0 } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("Packet 11C B4a: never requires the disclosure while offline (nothing would be sent), even when activated and not accepted", async () => {
    const { history } = await higherFixture();
    let online = false;
    const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, remoteUse: createAiRemoteUseSession(), online: () => online });
    expect(explainer.disclosureRequired()).toBe(false);
    online = true;
    expect(explainer.disclosureRequired()).toBe(true);
  });

  it("the session takes precedence over a test-only disclosure seam (production passes the session only)", async () => {
    const { history } = await higherFixture();
    const fetcher = fakeRoute();
    const result = await createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, remoteUse: createAiRemoteUseSession(), disclosure: ACCEPTED, fetcher }).explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
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
    const assistance = createBrowserAiAssistance({ history, carePreparation: { query, commands: care.carePreparation.commands }, audit: care.audits, remoteUse: createAiRemoteUseSession() });
    expect(vi.mocked(createAiHybridTaskService).mock.calls.length - before).toBe(1);
    // The one service's provider is the browser shell client behind this session's disclosure, writing to the one audit port.
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

  it("is assignable to the care-summary preview's wording port", async () => {
    const care = await careSetup();
    const port: CareSummaryAiWordingPort | null = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits }).careSummary;
    expect(typeof port?.compose).toBe("function");
  });

  it("shipped manifest: never available, never a disclosure; an explicit request keeps the deterministic preview, one audit row, no POST", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careSetup();
    const remoteUse = createAiRemoteUseSession();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, remoteUse, now: () => LATER }).careSummary!;
    expect(wording.available()).toBe(false);
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    expect(await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "TASK_DISABLED" });
    expect(await care.snapshots()).toBe(1);
    expect((await care.audits.list()).map((row) => [row.taskType, row.outcomeCode, row.attempts.count, row.providerModel])).toEqual([["DRAFT_CARE_PREPARATION_SUMMARY", "TASK_DISABLED", 0, null]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("activated (test manifest): available only online; the disclosure is required until this session accepts, in either flow", async () => {
    const care = await careSetup();
    let online = true;
    const remoteUse = createAiRemoteUseSession();
    const assistance = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, remoteUse, manifest: BOTH, online: () => online });
    const wording = assistance.careSummary!;
    expect(wording.available()).toBe(true);
    expect(wording.disclosureRequired(care.payload)).toBe(true);
    online = false;
    expect(wording.available()).toBe(false);
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    online = true;
    // One session for the app: accepting in the history flow covers the care flow too (and the reverse).
    assistance.history.acceptDisclosure();
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    expect(remoteUse.accepted()).toBe(true);
    // Only the care task's own activation counts.
    const historyOnly = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, remoteUse: createAiRemoteUseSession(), manifest: ENABLED });
    expect(historyOnly.careSummary!.available()).toBe(false);
    expect(historyOnly.careSummary!.disclosureRequired(care.payload)).toBe(false);
    expect(await care.audits.list()).toEqual([]);
  });

  it("activated and accepted: one value-blind POST and the AI-assisted replacement preview (PREPARED; approval untouched)", async () => {
    const care = await careSetup();
    const fetcher = fakeCareRoute();
    const remoteUse = createAiRemoteUseSession();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, remoteUse, manifest: BOTH, fetcher, now: () => LATER }).careSummary!;
    wording.acceptDisclosure();
    const outcome = await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG" });
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

  it("an explicit decline (the dialog's Cancel): nothing sent, no replacement, one REQUEST_CANCELLED audit row with no attempt", async () => {
    const care = await careSetup();
    const fetcher = fakeCareRoute();
    const remoteUse = createAiRemoteUseSession();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, remoteUse, manifest: BOTH, fetcher, now: () => LATER }).careSummary!;
    expect(await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG", disclosure: "DECLINED" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "REQUEST_CANCELLED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(remoteUse.accepted()).toBe(false);
    expect(await care.snapshots()).toBe(1);
    const rows = await care.audits.list();
    expect(rows.map((row) => [row.outcomeCode, row.attempts.count, row.providerModel, row.sourceRevisions.length])).toEqual([["REQUEST_CANCELLED", 0, null, 0]]);
  });

  it("a preview with nothing to phrase is not eligible: no disclosure, no hybrid call, no audit row, no POST", async () => {
    const care = await careSetup({ questionsOnly: true });
    const fetcher = fakeCareRoute();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, remoteUse: createAiRemoteUseSession(), manifest: BOTH, fetcher, now: () => LATER }).careSummary!;
    expect(wording.available()).toBe(true);
    expect(wording.disclosureRequired(care.payload)).toBe(false);
    expect(await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG" })).toEqual({ kind: "NOT_ELIGIBLE", reason: "NOTHING_TO_PHRASE" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await care.audits.list()).toEqual([]);
  });
});
