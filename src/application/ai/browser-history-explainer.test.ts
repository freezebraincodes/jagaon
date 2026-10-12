import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createRequestClassGate, requestClassIdentity, SHIPPED_REQUEST_CLASS_GATE, SHIPPED_REQUEST_CLASS_REGISTRY } from "./request-class-qualification";
// Packet 11C Addendum C (C1): every activated (test manifest) path below also injects test-only QUALIFIED records. Packet 11C English
// activation (owner decisions Q and A): the shipped records qualify the six en-SG classes and the shipped manifest enables both tasks;
// tests whose subject is "not activated" or "not qualified" inject DETERMINISTIC_ONLY_TEST_MANIFEST or pendingTestRequestClassGate().
import { DETERMINISTIC_ONLY_TEST_MANIFEST, pendingTestRequestClassGate, qualifiedTestRequestClassGate, testManifestEnabling } from "./request-class-test-support";
import { closeCarePreparationHarnesses, createCarePreparationHarness, ENABLED_CARE_MANIFEST, exact, fakeModelCareShells, testIds } from "@/application/care-preparation/care-preparation-test-support";
import { createCarePreparationService } from "@/application/care-preparation/care-preparation-service";
import { projectValidatedAiCareSummary } from "@/application/care-preparation/ai-care-summary-replacement";
import { buildCareSummaryAiRequest } from "@/application/care-preparation/ai-care-summary-request";
import type { CareSummaryAiWordingPort } from "@/components/jagaon/screens/CareSummaryPreviewScreen";
import { createBrowserJournalRuntime, type JagaOnRuntime } from "@/application/journal/browser-journal-runtime";
import { SYNTHETIC_CARE_QUESTION_TEXT } from "@/application/care-organisation/synthetic-care-organisation-seed";

// Packet 11C B4b: a pass-through spy, so a test can count the hybrid services one wiring builds (behaviour unchanged).
vi.mock("./ai-hybrid-task-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-hybrid-task-service")>();
  return { ...actual, createAiHybridTaskService: vi.fn(actual.createAiHybridTaskService) };
});

/**
 * Packet 11C Addendum B, Task B2b: the browser wiring of the history explanation (one hybrid service, one pattern explainer). The shipped
 * app passes only the history and audit ports: the shipped manifest, the interim fail-closed disclosure and the browser network primitive.
 * Activated behaviour is exercised only with an injected test manifest and a fake fetcher; never a live provider.
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12): the shipped manifest enables both tasks and the shipped records
 * qualify the en-SG classes, so the "shipped" tests below pin the per-locale outcome (en-SG: the disclosure first, nothing sent without
 * the request's own acceptance; zh-SG: never admitted, nothing sent), with the global fetch stubbed; the I-5 block pins the demo dataset.
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
/**
 * Owner decision 2026-10-12 (optional passcodes): without an injected test fetcher, the wiring's production passcode probe (GET
 * /api/ai/shell through the browser's fetch) is asked whenever a disclosure is required. By default this file answers it as unknown (a
 * 503, so the passcode stays required, as before) and refuses anything else loudly; nothing leaves the test. A test that stubs fetch
 * itself replaces this.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (input === AI_SHELL_ROUTE_PATH && init?.method === "GET") return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
      throw new Error(`UNEXPECTED_NETWORK ${String(input)}`);
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

// Packet 11C English activation: built on the pre-activation manifest, so it enables EXPLAIN_PATTERN only.
const ENABLED: AiActivationManifest = testManifestEnabling("EXPLAIN_PATTERN");
const USAGE = { inputTokens: 600, outputTokens: 80, costMicroUsd: 5 };
/**
 * Integration (shipped English activation + optional passcodes, 2026-10-12): with the activated shipped wiring, the ONLY network call
 * allowed before an accepted request is the credential-free passcode probe, made when a disclosure is about to be required: exactly
 * this GET (no body, no passcode header, its own timeout signal). Never a POST.
 */
const PASSCODE_PROBE_CALL = [AI_SHELL_ROUTE_PATH, { method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }] as const;

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
    // Owner UI decision U12 (deliberate): plus the POST observer (it only records that this request's POST left the browser).
    // Owner decision 2026-10-12 (AI credit dialog; deliberate): plus the credit-limit observer (it only records the request's token).
    expect(source).toMatch(/createBrowserShellClient\(\{ disclosure: decisions\.disclosure, fetcher: dependencies\.fetcher, accessPasscode: passcode\.read, onRefusal, onPost: notePost, onCreditLimit: noteCreditLimit \}\)/);
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

  // Packet 11C English activation (owner decisions Q and A; was: both locales TASK_DISABLED): the shipped manifest and records admit the
  // en-SG request (it needs the request's own acceptance: none here, so nothing is sent) and never the zh-SG request (PENDING).
  it.each([
    ["en-SG", true, "REMOTE_USE_NOT_ACCEPTED"],
    ["zh-SG", false, "REQUEST_CLASS_NOT_QUALIFIED"],
  ] as const)("shipped (%s): a DETERMINISTIC explanation without a decision, one audit row, no request sent (en-SG: only the passcode probe)", async (locale, disclosureRequired, outcomeCode) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port });
    expect(await explainer.disclosureRequired({ factId: FACT, locale })).toBe(disclosureRequired);
    const result = await explainer.explain({ factId: FACT, locale });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    // Integration (2026-10-12, deliberate): the en-SG disclosure check asks the passcode probe (one GET); zh-SG asks nothing. No POST.
    expect(fetchSpy.mock.calls).toEqual(disclosureRequired ? [PASSCODE_PROBE_CALL] : []);
    expect(log.rows).toHaveLength(1);
    expect(aiInvocationAuditRowSchema.safeParse(log.rows[0]).success).toBe(true);
    expect(log.rows[0]).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale, outcomeCode, providerModel: null, attempts: { count: 0 }, sourceRevisions: [] });
  });

  it.each([["en-SG"], ["zh-SG"]] as const)("not activated (the pre-activation manifest, %s): a DETERMINISTIC explanation, one TASK_DISABLED row, no network call", async (locale) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const log = audit();
    const result = await createBrowserHistoryExplainer({ history, audit: log.port, manifest: DETERMINISTIC_ONLY_TEST_MANIFEST }).explain({ factId: FACT, locale });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
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

/**
 * A gate built over the shipped definitions with test-only owner records QUALIFIED for exactly `classIds` (all others PENDING). Packet 11C
 * English activation: built on all-PENDING records (the pre-activation state), not on the shipped records (which qualify en-SG).
 */
function gateQualifying(classIds: readonly string[]) {
  const signed = { evidenceRef: "test/evidence", signedOffBy: "test", signedOffAt: "2026-10-08T00:00:00.000Z" };
  const pending = AI_REQUEST_CLASS_DEFINITIONS.map((definition) => ({ classId: definition.classId, contractDigest: definition.contractDigest, status: "PENDING" as const, evidenceRef: null, signedOffBy: null, signedOffAt: null }));
  return createRequestClassGate({ definitions: AI_REQUEST_CLASS_DEFINITIONS, records: pending.map((record) => (classIds.includes(record.classId) ? { ...record, status: "QUALIFIED" as const, ...signed } : record)) });
}

/**
 * Packet 11C Addendum C, Task C3 (owner decision: disclosure acceptance is per explicit request; one permitted structural repair shares
 * that request's decision; a new request needs a new decision). Replaces the B3 session disclosure. The screen asks
 * `disclosureRequired(request)` on the patient's action for THAT request (activated, online, remote switch not known off, and that
 * request's own class QUALIFIED) and shows the dialog BEFORE `explain`; its answer travels with that one request (`disclosure:
 * "ACCEPTED" | "DECLINED"`) and is bound to the request's own signal. Nothing else can accept.
 */
describe("browser history explainer: per-request disclosure (Packet 11C Addendum C, C3)", () => {
  it("never requires the disclosure while NOT_ACTIVATED (the pre-activation manifest), reads nothing for it, and an accepted request still sends nothing", async () => {
    const { history } = await higherFixture();
    const probe = vi.fn((request: { factId: string }) => history.loadExplainablePattern(request));
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history: { load: history.load, loadExplainablePattern: probe }, audit: log.port, manifest: DETERMINISTIC_ONLY_TEST_MANIFEST });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    const result = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(result).not.toHaveProperty("remoteUse");
    expect(log.rows.map((row) => row.outcomeCode)).toEqual(["TASK_DISABLED"]);
  });

  // Owner decision 2026-10-12 (optional passcodes; deliberate change): a required disclosure also asks the credential-free passcode
  // probe once per runtime (GET, no body, no passcode): the only request it makes; no request data is ever sent by asking.
  it("activated: required for every request (asking twice answers twice); asking reads only the comparison, writes and sends no request data", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ passcodeRequired: true }), { status: 200, headers: { "content-type": "application/json" } }));
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
    expect(fetchSpy.mock.calls).toEqual([[AI_SHELL_ROUTE_PATH, { method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }]]);
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
    it("an all-PENDING gate (pre-activation), even activated and accepted: no disclosure, no POST, one REQUEST_CLASS_NOT_QUALIFIED row per flow; the production default passes the shipped gate", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const care = await careSetup();
      const { history } = await higherFixture();
      const fetcher = fakeCareRoute();
      // Without an injected gate, the one service gets the shipped gate.
      const before = vi.mocked(createAiHybridTaskService).mock.calls.length;
      createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, fetcher, now: () => LATER });
      expect(vi.mocked(createAiHybridTaskService).mock.calls.slice(before).map((call) => call[0].requestClassGate)).toEqual([SHIPPED_REQUEST_CLASS_GATE]);
      // Packet 11C English activation: the shipped records qualify the en-SG classes, so "nothing qualified" is an all-PENDING gate.
      const assistance = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: pendingTestRequestClassGate(), fetcher, now: () => LATER });
      expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      // Packet 11C Addendum C (C3, C1 carry): the care AI action is hidden when this preview's class is not QUALIFIED.
      expect(assistance.careSummary!.available(care.payload)).toBe(false);
      expect(await assistance.careSummary!.disclosureRequired(care.payload)).toBe(false);
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
      expect(await assistance.careSummary!.disclosureRequired(care.payload)).toBe(false);
      // The test-only gate qualifies this preview's class: the action and the disclosure are offered.
      const qualified = createBrowserAiAssistance({ history: ports, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), now: () => LATER });
      expect(qualified.careSummary!.available(care.payload)).toBe(true);
      expect(await qualified.careSummary!.disclosureRequired(care.payload)).toBe(true);
      // A gate that throws offers nothing. The probes read nothing beyond the comparison, and write and send nothing.
      const throwing = { admit: () => { throw new Error("broken"); }, anyAdmissible: () => { throw new Error("broken"); } };
      const broken = createBrowserAiAssistance({ history: ports, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: throwing, now: () => LATER });
      expect(await broken.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      expect(broken.careSummary!.available(care.payload)).toBe(false);
      expect(await broken.careSummary!.disclosureRequired(care.payload)).toBe(false);
      expect(load).not.toHaveBeenCalled();
      expect(await care.audits.list()).toEqual([]);
    });

    it("the shipped app passes no request-class gate (production uses the shipped records)", () => {
      const app = readFileSync(join(process.cwd(), "src/components/jagaon/JagaOnApp.tsx"), "utf8");
      // Packet 11C Addendum C (C3, deliberate retarget): no session either; the app passes exactly the three runtime ports.
      // Packet 11C Addendum C (C2, deliberate retarget; fix round 1 I-1): plus the "Keep wording on this device" setting: the awaited
      // per-request value (this tab's choice, else the stored value) and the in-memory value for render-time offers.
      expect(app).toMatch(/aiAssistanceFactory\(\{ history: runtime\.history, carePreparation: runtime\.carePreparation, audit: runtime\.aiAudit, privateMode: keepWordingAwaitedFor\(runtime\), privateModeHint: readKeepWordingOnDevice \}\)/);
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

  // Packet 11C English activation (owner decisions Q and A; was: "shipped manifest ... TASK_DISABLED"): the shipped manifest enables the
  // care task, but this preview's shape (an appointment, one reading and one question) is not an evaluated class: never available, no
  // disclosure; an explicit request keeps the deterministic preview, one REQUEST_CLASS_NOT_QUALIFIED row, no POST.
  // Owner demo override (owner decision 2026-10-12): the SHIPPED gate offers this en-SG preview (first case); the tested-shapes-only
  // gate (override off) keeps the earlier fail-closed behaviour (second case).
  it("shipped manifest and records, an en-SG preview outside the evaluated classes: offered by the owner demo override, the disclosure first, nothing sent by offering it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careSetup();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, now: () => LATER }).careSummary!;
    expect(wording.available(care.payload)).toBe(true);
    // Offering the action (render-time `available`) makes no network call at all.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await wording.disclosureRequired(care.payload)).toBe(true);
    expect(await care.audits.list()).toEqual([]);
    // Integration (2026-10-12, deliberate): the disclosure check asks only the credential-free passcode probe; nothing is POSTed.
    expect(fetchSpy.mock.calls).toEqual([PASSCODE_PROBE_CALL]);
  });

  it("tested-shapes-only gate (override off), a preview outside the evaluated classes: never available, never a disclosure; an explicit request keeps the deterministic preview, one audit row, no POST", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careSetup();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, requestClassGate: createRequestClassGate(SHIPPED_REQUEST_CLASS_REGISTRY), now: () => LATER }).careSummary!;
    expect(wording.available(care.payload)).toBe(false);
    expect(await wording.disclosureRequired(care.payload)).toBe(false);
    expect(await wording.compose({ snapshotRef: care.snapshotRef, locale: "en-SG", disclosure: "ACCEPTED" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "TASK_DISABLED" });
    expect(await care.snapshots()).toBe(1);
    expect((await care.audits.list()).map((row) => [row.taskType, row.outcomeCode, row.attempts.count, row.providerModel])).toEqual([["DRAFT_CARE_PREPARATION_SUMMARY", "REQUEST_CLASS_NOT_QUALIFIED", 0, null]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("not activated (the pre-activation manifest): never available, never a disclosure; an explicit request keeps the deterministic preview, one TASK_DISABLED row, no POST", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const care = await careSetup();
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: DETERMINISTIC_ONLY_TEST_MANIFEST, now: () => LATER }).careSummary!;
    expect(wording.available(care.payload)).toBe(false);
    expect(await wording.disclosureRequired(care.payload)).toBe(false);
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
    expect(await wording.disclosureRequired(care.payload)).toBe(true);
    expect(await wording.disclosureRequired(care.payload)).toBe(true);
    online = false;
    expect(wording.available(care.payload)).toBe(false);
    expect(await wording.disclosureRequired(care.payload)).toBe(false);
    online = true;
    switchOff = true;
    expect(wording.available(care.payload)).toBe(false);
    expect(await wording.disclosureRequired(care.payload)).toBe(false);
    switchOff = false;
    // Only the care task's own activation counts.
    const historyOnly = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: care.carePreparation, audit: care.audits, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate() });
    expect(historyOnly.careSummary!.available(care.payload)).toBe(false);
    expect(await historyOnly.careSummary!.disclosureRequired(care.payload)).toBe(false);
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
    expect(await wording.disclosureRequired(care.payload)).toBe(false);
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

  /**
   * Packet 11C Addendum C, Task C2 (hybrid spec D11): the patient's "Keep wording on this device" setting, passed to the ONE hybrid
   * service of both flows and read per request. When on: zero network calls, no disclosure (so no passcode field), no care AI action, a
   * deterministic history explanation and exactly one PRIVACY_REJECTED row (mode PRIVATE) per explicit request; probes write none.
   * Proven under the shipped manifest and records (Packet 11C English activation: both tasks enabled, the en-SG classes QUALIFIED) AND an
   * injected activated manifest with test-only QUALIFIED classes (fetch spy and fake route).
   */
  describe("Packet 11C Addendum C, C2: private mode (Keep wording on this device)", () => {
    const privateRow = (row: AiInvocationAuditRow, taskType: string, locale: string) => {
      expect(aiInvocationAuditRowSchema.parse(row)).toMatchObject({
        auditSchemaVersion: "ai-invocation-audit.11c.2",
        taskType,
        locale,
        outcomeCode: "PRIVACY_REJECTED",
        attempts: { count: 0, structuralRepairUsed: false, timedOut: false },
        providerModel: null,
        sourceRevisions: [],
        usageBasis: "NONE",
      });
      expect(row.measurements).toMatchObject({ inputTokens: null, outputTokens: null, costMicroUsd: null });
    };

    it.each([
      ["the shipped manifest and records (no test seam; the en-SG history class is QUALIFIED)", false],
      ["an injected activated manifest with test-only QUALIFIED classes and a fake route", true],
    ])("under %s: no POST, no disclosure, no care action, deterministic explanation, one exact PRIVACY_REJECTED row per explicit request", async (_label, activated) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const care = await careSetup();
      const { history } = await higherFixture();
      const fetcher = fakeRoute();
      const seams = activated ? { manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher } : {};
      const assistance = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, now: () => LATER, privateMode: () => true, ...seams });
      // The probes: no disclosure (so no passcode field) and no care AI action; they write and send nothing.
      expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      expect(assistance.careSummary!.available(care.payload)).toBe(false);
      expect(await assistance.careSummary!.disclosureRequired(care.payload)).toBe(false);
      expect(await care.audits.list()).toEqual([]);
      // One explicit history request, even one that carries an acceptance: deterministic, local, one PRIVATE row.
      for (const locale of ["en-SG", "zh-SG"] as const) {
        expect(await assistance.history.explain({ factId: FACT, locale, disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
      }
      // The care flow offers no action; an explicit call anyway (defence in depth) keeps the deterministic preview.
      expect(await assistance.careSummary!.compose({ snapshotRef: care.snapshotRef, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "PRIVACY_REJECTED" });
      expect(await care.snapshots()).toBe(1);
      const rows = await care.audits.list();
      expect(rows).toHaveLength(3);
      privateRow(rows.find((row) => row.taskType === "EXPLAIN_PATTERN" && row.locale === "en-SG")!, "EXPLAIN_PATTERN", "en-SG");
      privateRow(rows.find((row) => row.taskType === "EXPLAIN_PATTERN" && row.locale === "zh-SG")!, "EXPLAIN_PATTERN", "zh-SG");
      privateRow(rows.find((row) => row.taskType === "DRAFT_CARE_PREPARATION_SUMMARY")!, "DRAFT_CARE_PREPARATION_SUMMARY", "en-SG");
      expect(fetcher).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("read per request, no rebuild: on hides the disclosure and the care action and keeps the next request local; off restores both", async () => {
      const care = await careSetup();
      const { history } = await higherFixture();
      const fetcher = fakeRoute();
      let keep = true;
      const before = vi.mocked(createAiHybridTaskService).mock.calls.length;
      const assistance = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER, privateMode: () => keep });
      expect(vi.mocked(createAiHybridTaskService).mock.calls.length - before).toBe(1);
      expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      expect(assistance.careSummary!.available(care.payload)).toBe(false);
      keep = false;
      expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
      expect(assistance.careSummary!.available(care.payload)).toBe(true);
      expect(await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ source: "AI" });
      keep = true;
      expect(await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ source: "DETERMINISTIC" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await care.audits.list()).map((row) => row.outcomeCode).sort()).toEqual(["ACCEPTED", "PRIVACY_REJECTED"]);
    });

    it("a check that throws keeps the wording on the device: no disclosure, no care action, nothing sent", async () => {
      const care = await careSetup();
      const { history } = await higherFixture();
      const fetcher = fakeRoute();
      const assistance = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER, privateMode: () => { throw new Error("unknown"); } });
      expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      expect(assistance.careSummary!.available(care.payload)).toBe(false);
      expect(await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ source: "DETERMINISTIC" });
      expect(fetcher).not.toHaveBeenCalled();
      expect((await care.audits.list()).map((row) => row.outcomeCode)).toEqual(["PRIVACY_REJECTED"]);
    });

    it("coordinator ruling: switched on while an accepted request is in flight, that request completes unchanged (one POST, ACCEPTED); the next is private", async () => {
      const care = await careSetup();
      const { history } = await higherFixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const route = fakeRoute();
      const slow = vi.fn<BrowserShellFetcher>(async (url, init) => (await held, route(url, init)));
      let keep = false;
      const assistance = createBrowserAiAssistance({ history, carePreparation: care.carePreparation, audit: care.audits, manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher: slow, now: () => LATER, privateMode: () => keep });
      const inFlight = assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
      await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
      keep = true;
      release();
      expect(await inFlight).toMatchObject({ kind: "EXPLAINED", source: "AI" });
      expect(await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ source: "DETERMINISTIC" });
      expect(slow).toHaveBeenCalledTimes(1);
      expect((await care.audits.list()).map((row) => row.outcomeCode).sort()).toEqual(["ACCEPTED", "PRIVACY_REJECTED"]);
    });

    it("fix round 1 (M-2): switched on during the explainer's held local source read, the request resolves as PRIVATE: one PRIVACY_REJECTED row, no POST", async () => {
      const { history } = await higherFixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const reading = vi.fn();
      const slowHistory: RecordedHistoryQueryPort = { load: history.load, loadExplainablePattern: async (request) => (reading(), await held, history.loadExplainablePattern(request)) };
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const fetcher = fakeRoute();
      const log = audit();
      let keep = false;
      const assistance = createBrowserAiAssistance({ history: slowHistory, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => NOW as Instant, privateMode: () => keep });
      const request = assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
      await vi.waitFor(() => expect(reading).toHaveBeenCalled());
      keep = true;
      release();
      expect(await request).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
      expect(log.rows).toHaveLength(1);
      expect(aiInvocationAuditRowSchema.parse(log.rows[0])).toMatchObject({ outcomeCode: "PRIVACY_REJECTED", attempts: { count: 0 }, providerModel: null, sourceRevisions: [], usageBasis: "NONE" });
      expect(fetcher).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

/**
 * Packet 11C Addendum C, C2 fix round 1 (I-1): the setting reaches every open tab. Two runtimes share one (fake) IndexedDB, as two tabs
 * share one browser dataset. The wiring awaits the stored value per request (the app passes `ref || await read()`), and a change notice
 * on a BroadcastChannel lets the other tab update its in-memory value and UI. Either alone keeps the other tab's next request local.
 */
describe("browser AI assistance: the setting across tabs (Packet 11C C2 fix round 1, I-1)", () => {
  const LATER = "2026-10-04T02:05:00.000Z" as Instant;
  const names: string[] = [];
  afterEach(async () => {
    for (const name of names.splice(0)) await Dexie.delete(name);
  });
  async function twoTabs() {
    const name = `c2-tabs-${crypto.randomUUID()}`;
    names.push(name);
    const tabA = await createBrowserJournalRuntime(name, { now: () => LATER, seedSyntheticScenarioOnCreate: false });
    const tabB = await createBrowserJournalRuntime(name, { now: () => LATER, seedSyntheticScenarioOnCreate: false });
    return { tabA, tabB };
  }
  async function wiringOf(tab: JagaOnRuntime, ref: { current: boolean }) {
    const { history } = await higherFixture();
    const fetcher = fakeRoute();
    const log = audit();
    // Exactly what the app passes: the tab's in-memory value, else the stored value (unreadable: on).
    const assistance = createBrowserAiAssistance({
      history,
      audit: log.port,
      manifest: ENABLED,
      requestClassGate: qualifiedTestRequestClassGate(),
      fetcher,
      now: () => LATER,
      privateMode: async () => ref.current || (await tab.keepWordingOnDevice.read().catch(() => true)),
      privateModeHint: () => ref.current,
    });
    return { assistance, fetcher, log };
  }

  it("with the change notice: tab A turns it on; tab B learns it, offers no disclosure and keeps its next request local", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { tabA, tabB } = await twoTabs();
    const refB = { current: false };
    const notices = vi.fn();
    const unsubscribe = tabB.keepWordingOnDevice.subscribe(() => {
      notices();
      void tabB.keepWordingOnDevice.read().then((stored) => (refB.current = stored));
    });
    const b = await wiringOf(tabB, refB);
    expect(await b.assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    await tabA.keepWordingOnDevice.persist(true);
    await vi.waitFor(() => expect(refB.current).toBe(true));
    expect(notices).toHaveBeenCalledTimes(1);
    expect(await b.assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    expect(await b.assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(b.log.rows.map((row) => row.outcomeCode)).toEqual(["PRIVACY_REJECTED"]);
    expect(b.fetcher).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // A tab never notifies itself.
    const ownNotices = vi.fn();
    const ownUnsubscribe = tabA.keepWordingOnDevice.subscribe(ownNotices);
    await tabA.keepWordingOnDevice.persist(false);
    await vi.waitFor(() => expect(notices).toHaveBeenCalledTimes(2));
    expect(ownNotices).not.toHaveBeenCalled();
    ownUnsubscribe();
    unsubscribe();
    tabA.close();
    tabB.close();
  });

  it("without any change notice (no BroadcastChannel): the awaited stored value alone keeps tab B's next request local", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { tabA, tabB } = await twoTabs();
    const refB = { current: false };
    const unsubscribe = tabB.keepWordingOnDevice.subscribe(() => (refB.current = true));
    const b = await wiringOf(tabB, refB);
    expect(await b.assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    await tabA.keepWordingOnDevice.persist(true);
    // Tab B's in-memory value is stale (no notice exists), yet the awaited read decides.
    expect(refB.current).toBe(false);
    expect(await b.assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    expect(await b.assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(b.log.rows.map((row) => row.outcomeCode)).toEqual(["PRIVACY_REJECTED"]);
    expect(b.fetcher).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    unsubscribe();
    tabA.close();
    tabB.close();
  });

  it("the care flow uses the same awaited value: its disclosure check is false once the stored value is on", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const { tabA, tabB } = await twoTabs();
    const h = await createCarePreparationHarness();
    const commands = createCarePreparationService(h.database, { now: () => LATER, ids: testIds, projectAiCareSummary: projectValidatedAiCareSummary });
    const reading = await h.journal.recordGlucose({ payload: { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } }, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: LATER });
    if (reading.kind !== "COMMITTED") throw new Error("fixture");
    const prepared = await commands.prepare(await h.selection());
    if (prepared.kind !== "COMMITTED") throw new Error("prepared");
    const view = await h.query.loadSummary(prepared.recordId);
    if (view.status !== "READY") throw new Error("ready");
    const refB = { current: false };
    const BOTH: AiActivationManifest = { ...ENABLED_CARE_MANIFEST, tasks: { ...ENABLED_CARE_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } };
    const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: { query: h.query, commands }, audit: createAiInvocationAuditRepository(h.database), manifest: BOTH, requestClassGate: qualifiedTestRequestClassGate(), fetcher: fakeRoute(), now: () => LATER, privateMode: async () => refB.current || (await tabB.keepWordingOnDevice.read()), privateModeHint: () => refB.current }).careSummary!;
    expect(await wording.disclosureRequired(view.payload)).toBe(true);
    await tabA.keepWordingOnDevice.persist(true);
    expect(await wording.disclosureRequired(view.payload)).toBe(false);
    tabA.close();
    tabB.close();
    closeCarePreparationHarnesses();
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
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { history } = await higherFixture();
    const log = audit();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port });
    expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    await history.loadExplainablePattern({ factId: FACT });
    expect(log.rows).toHaveLength(0);
    await explainer.explain({ factId: FACT, locale: "en-SG" });
    // Packet 11C English activation (was TASK_DISABLED): the en-SG class is QUALIFIED; without the request's own decision nothing is sent.
    expect(log.rows.map((row) => row.outcomeCode)).toEqual(["REMOTE_USE_NOT_ACCEPTED"]);
    // Integration (2026-10-12, deliberate): the one disclosure check asked the passcode probe (one GET); no POST, no row from it.
    expect(fetchSpy.mock.calls).toEqual([PASSCODE_PROBE_CALL]);
  });
});

/**
 * Owner UI decision U12 (owner-ui-decisions-2026-10-09): after an ATTEMPTED remote request fails or is refused, the history explanation
 * carries `remoteUse: "UNAVAILABLE_AFTER_REQUEST"` (the panel then shows the owner's fallback line). "Attempted" means: the browser
 * shell client actually POSTed to the route for THIS request (its decision token). A route answer with `notSentToProvider` (a 403 refusal
 * or a pre-call FAILED) still counts, because the POST happened; a request refused before any POST (not activated, private, not
 * qualified, offline, the switch known off, declined, no decision, a client-side refusal) never does.
 */
describe("browser history explainer: fallback after an attempted remote request (owner UI decision U12)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const failedAfterCall = () => vi.fn<BrowserShellFetcher>(async () => json({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "UPPER_BOUND" } }));
  const failedBeforeCall = () => vi.fn<BrowserShellFetcher>(async () => json({ kind: "FAILED", reason: "MISSING_CONFIGURATION", notSentToProvider: true }));
  const refused = (reason: string) => vi.fn<BrowserShellFetcher>(async () => json({ kind: "REFUSED", reason, notSentToProvider: true }, 403));
  const serverError = () => vi.fn<BrowserShellFetcher>(async () => new Response("x", { status: 500 }));

  async function explainWith(options: { fetcher: BrowserShellFetcher; manifest?: AiActivationManifest; qualified?: boolean; privateMode?: boolean; switchOff?: boolean; online?: boolean }, disclosure?: "ACCEPTED" | "DECLINED") {
    const { history } = await higherFixture();
    const explainer = createBrowserHistoryExplainer({
      history,
      audit: audit().port,
      manifest: options.manifest ?? ENABLED,
      fetcher: options.fetcher,
      // Packet 11C English activation: "not qualified" is an all-PENDING gate (the shipped records qualify this en-SG class).
      requestClassGate: options.qualified === false ? pendingTestRequestClassGate() : qualifiedTestRequestClassGate(),
      ...(options.privateMode ? { privateMode: () => true } : {}),
      ...(options.switchOff ? { remoteSwitchKnownOff: () => true } : {}),
      ...(options.online === false ? { online: () => false } : {}),
    });
    explainer.accessPasscode.provide("TEST-ONLY-passcode-value");
    return explainer.explain({ factId: FACT, locale: "en-SG", ...(disclosure ? { disclosure } : {}) }, new AbortController().signal);
  }

  it.each([
    ["FAILED after a provider call", failedAfterCall],
    ["FAILED before a provider call (notSentToProvider, but POSTed)", failedBeforeCall],
    // Owner decision 2026-10-12 (AI credit dialog; deliberate change): SPEND_CEILING_REACHED now carries the credit-limit marker
    // instead (see "AI credit limit" below); the other refusals keep U12's marker.
    ["REFUSED SPEND_NOT_CONFIGURED (403)", () => refused("SPEND_NOT_CONFIGURED")],
    ["REFUSED SPEND_LEDGER_UNAVAILABLE (403)", () => refused("SPEND_LEDGER_UNAVAILABLE")],
    ["REFUSED ACCESS_DENIED (403)", () => refused("ACCESS_DENIED")],
    ["REFUSED REMOTE_AI_DISABLED (403)", () => refused("REMOTE_AI_DISABLED")],
    ["an HTTP 500", serverError],
  ] as const)("shown: an accepted request that was POSTed and answered %s explains with the standard wording and the marker", async (_label, make) => {
    const fetcher = make();
    const result = await explainWith({ fetcher }, "ACCEPTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "UNAVAILABLE_AFTER_REQUEST" });
  });

  it("not shown: an accepted AI explanation (POSTed and accepted)", async () => {
    const result = await explainWith({ fetcher: fakeRoute() }, "ACCEPTED");
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(result).not.toHaveProperty("remoteUse");
  });

  it.each([
    ["ordinary deterministic use (a task that is not activated)", { manifest: DETERMINISTIC_ONLY_TEST_MANIFEST }, "ACCEPTED"],
    ["private mode", { privateMode: true }, "ACCEPTED"],
    ["not qualified (an all-PENDING gate)", { qualified: false }, "ACCEPTED"],
    ["the server switch known off before any send", { switchOff: true }, "ACCEPTED"],
    ["offline", { online: false }, "ACCEPTED"],
    ["no decision for the request (e.g. its disclosure closed moot)", {}, undefined],
  ] as const)("not shown, nothing POSTed: %s", async (_label, options, disclosure) => {
    const fetcher = failedAfterCall();
    const result = await explainWith({ fetcher, ...options }, disclosure);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(result).not.toMatchObject({ remoteUse: "UNAVAILABLE_AFTER_REQUEST" });
  });

  it("not shown: a declined disclosure keeps its own NOT_ACCEPTED line; nothing POSTed", async () => {
    const fetcher = failedAfterCall();
    const result = await explainWith({ fetcher }, "DECLINED");
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
  });

  it("per request: after a refused POST, the next request with no POST (switch now known off) carries no marker", async () => {
    const { history } = await higherFixture();
    const fetcher = refused("REMOTE_AI_DISABLED");
    const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, fetcher, requestClassGate: qualifiedTestRequestClassGate() });
    explainer.accessPasscode.provide("TEST-ONLY-passcode-value");
    expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ remoteUse: "UNAVAILABLE_AFTER_REQUEST" });
    const second = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(second).not.toHaveProperty("remoteUse");
  });
});

/**
 * Owner decision 2026-10-12 (optional passcodes): the disclosure asks for the demo passcode only when the deployment requires one. The
 * runtime learns that from the passcode probe (`GET /api/ai/shell`), asked only when a disclosure is about to be required (never with
 * the shipped manifest, private mode, offline or an unqualified class), once per runtime; an unknown answer keeps asking for it.
 */
describe("browser AI assistance: optional passcode (Owner decision 2026-10-12, optional passcodes)", () => {
  const headerOf = (fetcher: ReturnType<typeof vi.fn<BrowserShellFetcher>>, call = 0) => (fetcher.mock.calls[call]![1].headers as Record<string, string>)[AI_SHELL_ACCESS_HEADER];

  it("not required: after the disclosure check the entry is not needed; the accepted request is POSTed without a passcode header; the probe is asked once", async () => {
    const { history } = await higherFixture();
    const fetcher = fakeRoute();
    const passcodeProbe = vi.fn(async () => false);
    const assistance = createBrowserAiAssistance({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, passcodeProbe });
    const entry = assistance.history.accessPasscode;
    // Unknown until asked: needed (fail safe).
    expect(entry.needed()).toBe(true);
    expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(entry.needed()).toBe(false);
    expect(await assistance.history.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).toMatchObject({ source: "AI" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(headerOf(fetcher)).toBeUndefined();
    expect(await assistance.history.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(passcodeProbe).toHaveBeenCalledTimes(1);
  });

  it("required, unknown (null) or a failing probe: the entry stays needed; an unknown answer is asked again next time", async () => {
    const { history } = await higherFixture();
    for (const [answer, calls] of [[async () => true, 1], [async () => null, 2], [async () => Promise.reject(new Error("offline")), 2]] as const) {
      const passcodeProbe = vi.fn(answer);
      const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher: fakeRoute(), passcodeProbe });
      expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
      expect(explainer.accessPasscode.needed()).toBe(true);
      expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
      expect(passcodeProbe).toHaveBeenCalledTimes(calls);
    }
  });

  // Integration (2026-10-12, deliberate): the shipped manifest is now activated, so "not activated" uses the pre-activation manifest,
  // and the unqualified class uses the all-PENDING test gate (the shipped gate now qualifies this en-SG class).
  it("never asked when no disclosure is required: not activated, private mode, offline, switch known off, unqualified class", async () => {
    const { history } = await higherFixture();
    const passcodeProbe = vi.fn(async () => false);
    const variants = [
      { manifest: DETERMINISTIC_ONLY_TEST_MANIFEST, requestClassGate: qualifiedTestRequestClassGate() },
      { manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), privateMode: () => true },
      { manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), online: () => false },
      { manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), remoteSwitchKnownOff: () => true },
      { manifest: ENABLED, requestClassGate: pendingTestRequestClassGate() },
    ];
    for (const variant of variants) {
      const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, fetcher: fakeRoute(), passcodeProbe, ...variant });
      expect(await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
      expect(explainer.accessPasscode.needed()).toBe(true);
    }
    expect(passcodeProbe).not.toHaveBeenCalled();
  });

  it("a route ACCESS_DENIED after 'not required' makes the passcode required again (the next disclosure asks for it)", async () => {
    const { history } = await higherFixture();
    const fetcher = vi.fn<BrowserShellFetcher>(async () => new Response(JSON.stringify({ kind: "REFUSED", reason: "ACCESS_DENIED", notSentToProvider: true }), { status: 403, headers: { "content-type": "application/json" } }));
    const passcodeProbe = vi.fn(async () => false);
    const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher, passcodeProbe });
    await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" });
    expect(explainer.accessPasscode.needed()).toBe(false);
    await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(explainer.accessPasscode.needed()).toBe(true);
    await explainer.disclosureRequired({ factId: FACT, locale: "en-SG" });
    expect(explainer.accessPasscode.needed()).toBe(true);
    expect(passcodeProbe).toHaveBeenCalledTimes(1);
  });

  it("the default probe is the same-origin GET through the browser's fetch (no injected fetcher); a test fetcher without a probe is never probed", async () => {
    const { history } = await higherFixture();
    const globalFetch = vi.fn(async () => new Response(JSON.stringify({ passcodeRequired: false }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", globalFetch);
    const production = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate() });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(await production.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledWith(AI_SHELL_ROUTE_PATH, { method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) });
    expect(production.accessPasscode.needed()).toBe(false);
    const fetcher = fakeRoute();
    const seeded = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    expect(await seeded.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(true);
    expect(seeded.accessPasscode.needed()).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it("the care flow learns it the same way (one entry and one probe for both flows)", async () => {
    const h = await createCarePreparationHarness();
    try {
      const passcodeProbe = vi.fn(async () => false);
      const assistance = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: { query: h.query, commands: createCarePreparationService(h.database, { now: () => NOW, ids: testIds, projectAiCareSummary: projectValidatedAiCareSummary }) }, audit: audit().port, manifest: ENABLED_CARE_MANIFEST, requestClassGate: qualifiedTestRequestClassGate(), fetcher: fakeRoute(), passcodeProbe });
      expect(assistance.careSummary!.accessPasscode).toBe(assistance.history.accessPasscode);
      // A preview that could not be sent asks nothing.
      expect(await assistance.careSummary!.disclosureRequired({} as never)).toBe(false);
      expect(passcodeProbe).not.toHaveBeenCalled();
    } finally {
      await closeCarePreparationHarnesses();
    }
  });
});

/**
 * Owner decision 2026-10-12 (AI credit dialog): when an accepted request was refused because the daily AI limit is used up
 * (SPEND_CEILING_REACHED) or the provider's balance is (OPERATIONAL_SPEND_LOCKED), the standard wording comes back marked
 * "CREDIT_LIMIT_REACHED" (the screens then show the credit dialog instead of U12's line); no other outcome carries it.
 */
describe("browser AI assistance: AI credit limit (Owner decision 2026-10-12, AI credit dialog)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const ceiling = () => vi.fn<BrowserShellFetcher>(async () => json({ kind: "REFUSED", reason: "SPEND_CEILING_REACHED", notSentToProvider: true }, 403));
  const balance = () => vi.fn<BrowserShellFetcher>(async () => json({ kind: "FAILED", reason: "OPERATIONAL_SPEND_LOCKED", usage: { ...USAGE, basis: "UPPER_BOUND" } }));

  it.each([
    ["the daily limit (REFUSED SPEND_CEILING_REACHED)", ceiling, "SPEND_CEILING_REACHED"],
    ["the DeepSeek balance (FAILED OPERATIONAL_SPEND_LOCKED)", balance, "OPERATIONAL_SPEND_LOCKED"],
  ] as const)("history: %s → the standard wording marked CREDIT_LIMIT_REACHED; audited with its own code", async (_label, make, code) => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = make();
    const explainer = createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
    explainer.accessPasscode.provide("TEST-ONLY-passcode-value");
    const result = await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "CREDIT_LIMIT_REACHED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(log.rows.map((row) => row.outcomeCode)).toEqual([code]);
    // Per request: the next request that is not POSTed carries no marker.
    const next = await explainer.explain({ factId: FACT, locale: "en-SG" }, new AbortController().signal);
    expect(next).not.toMatchObject({ remoteUse: "CREDIT_LIMIT_REACHED" });
  });

  it("history: no marker for other refusals, failures or a successful AI explanation", async () => {
    const { history } = await higherFixture();
    for (const fetcher of [
      vi.fn<BrowserShellFetcher>(async () => json({ kind: "REFUSED", reason: "SPEND_NOT_CONFIGURED", notSentToProvider: true }, 403)),
      vi.fn<BrowserShellFetcher>(async () => json({ kind: "REFUSED", reason: "ORIGIN_REJECTED", notSentToProvider: true }, 403)),
      vi.fn<BrowserShellFetcher>(async () => json({ kind: "FAILED", reason: "PROVIDER_FAILED", usage: { ...USAGE, basis: "UPPER_BOUND" } })),
      fakeRoute(),
    ]) {
      const explainer = createBrowserHistoryExplainer({ history, audit: audit().port, manifest: ENABLED, requestClassGate: qualifiedTestRequestClassGate(), fetcher });
      explainer.accessPasscode.provide("TEST-ONLY-passcode-value");
      expect(await explainer.explain({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal)).not.toMatchObject({ remoteUse: "CREDIT_LIMIT_REACHED" });
    }
  });

  it.each([
    ["the daily limit", ceiling],
    ["the DeepSeek balance", balance],
  ] as const)("care: %s → KEPT_DETERMINISTIC marked CREDIT_LIMIT_REACHED; no replacement", async (_label, make) => {
    const h = await createCarePreparationHarness();
    try {
      const LATER = "2026-10-04T02:05:00.000Z" as Instant;
      const commands = createCarePreparationService(h.database, { now: () => LATER, ids: testIds, projectAiCareSummary: projectValidatedAiCareSummary });
      const reading = await h.journal.recordGlucose({ payload: { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } }, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: LATER });
      if (reading.kind !== "COMMITTED") throw new Error("fixture");
      const prepared = await commands.prepare(await h.selection());
      if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
      const fetcher = make();
      const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: { query: h.query, commands }, audit: audit().port, manifest: ENABLED_CARE_MANIFEST, requestClassGate: qualifiedTestRequestClassGate(), fetcher, now: () => LATER }).careSummary!;
      wording.accessPasscode.provide("TEST-ONLY-passcode-value");
      const outcome = await wording.compose({ snapshotRef: { recordId: prepared.recordId, expectedRevisionId: prepared.revisionId, expectedRevisionNumber: prepared.revisionNumber }, locale: "en-SG", disclosure: "ACCEPTED" }, new AbortController().signal);
      expect(outcome).toMatchObject({ kind: "KEPT_DETERMINISTIC", remoteUse: "CREDIT_LIMIT_REACHED" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await closeCarePreparationHarnesses();
    }
  });
});

/**
 * Packet 11C English activation (owner decisions Q and A, 2026-10-12): integrated check I-5 of the English AI readiness request (§5).
 * Offline: the transport is an injected fake route (the global fetch is a spy that must stay unused); never a provider. Nothing is
 * injected into the wiring but its ports and the fake route, so the SHIPPED manifest and the SHIPPED request-class gate decide.
 * - History, over the demo dataset the app opens with (a new local dataset is seeded with the prepared demo data, which ends yesterday;
 *   the prepared demo profile only completes onboarding), at the demo clocks Mon 12 Oct 2026 08:40 SGT and Tue 13 Oct 2026 14:00 SGT:
 *   nothing is dated today or later, "Last week" and "30 days" have readings, and the before-breakfast comparison (LOWER) is the one
 *   governed statement. Its en-SG request is class a00d8ad5… (QUALIFIED). The disclosure is required first; a request without its own
 *   decision sends nothing; an accepted one is exactly one value-blind POST of that class. In zh-SG it is class c54c7d67… (PENDING): no
 *   disclosure, the standard wording, nothing sent.
 * - Care: an en-SG preview of the evaluated ORDINARY shape (one reading, one question, no appointment) is class 5d0c75ce… (QUALIFIED):
 *   offered, disclosure first, one POST of that class when accepted; the same preview in zh-SG (8de6bc4e…, PENDING) is never offered or
 *   sent. The demo dataset's OWN care selections (the 14-day visit period, with the seeded appointment) are within the fact limit and,
 *   except for every group at once (TOO_MANY_FACTS), remote-eligible, but map to no evaluated class (NO_DEFINITION): with the shipped gate
 *   they are never offered and nothing is sent (fail closed).
 */
describe("Packet 11C English activation, I-5: the shipped manifest and gate over the demo flows (offline, fake route)", () => {
  const LATER = "2026-10-04T02:05:00.000Z" as Instant;
  /** The demo clocks: Mon 12 Oct 2026 08:40 SGT and Tue 13 Oct 2026 14:00 SGT (the demo cutoff), with each one's local today and yesterday. */
  const DEMO_CLOCKS = [
    { label: "Mon 12 Oct 08:40 SGT", at: "2026-10-12T00:40:00.000Z" as Instant, today: "2026-10-12", yesterday: "2026-10-11", thisWeek: "EMPTY" },
    { label: "Tue 13 Oct 14:00 SGT", at: "2026-10-13T06:00:00.000Z" as Instant, today: "2026-10-13", yesterday: "2026-10-12", thisWeek: "READY" },
  ] as const;
  const EN_EXPLAIN = "a00d8ad562619f605ca03fe406c18abe095410db4d6f53cca02f68601104910d";
  const ZH_EXPLAIN = "c54c7d6754b5a791ab4e5732e82e6e9d8f4e235bd8004484db25f7f1558d9dac";
  const EN_CARE_ORDINARY = "5d0c75cef363c190e726f5cb055f4f9b6b265b76b7f8779b612467203ac6adca";
  const ZH_CARE_ORDINARY = "8de6bc4ed13d6ffac59be50a33ff31c7f0523e554f37173823ad0fc781e8643a";
  const names: string[] = [];
  const opened: JagaOnRuntime[] = [];
  afterEach(async () => {
    for (const runtime of opened.splice(0)) runtime.close();
    for (const name of names.splice(0)) await Dexie.delete(name);
    await closeCarePreparationHarnesses();
  });

  /** The class of the value-blind request one POST carried. */
  const postedClass = (init: RequestInit) => requestClassIdentity(shellTaskRequestSchema.parse(JSON.parse(init.body as string))).classId;
  /** A fake POST /api/ai/shell answering valid shells (fake model wording) for either flow's approved value-blind request. */
  function fakeDemoRoute() {
    return vi.fn<BrowserShellFetcher>(async (_url, init) => {
      const plan = shellPlanView(shellTaskRequestSchema.parse(JSON.parse(init.body as string)));
      const home = (path: ShellFieldPath) => plan.slots.find((slot) => slot.homeField === path)!.slotId;
      const texts = plan.taskType === "EXPLAIN_PATTERN" ? new Map<ShellFieldPath, string>([["headline", `A look at ${slotToken(home("headline"))}.`], ["evidence", `This is based on ${slotToken(home("evidence"))}.`]]) : fakeModelCareShells(plan);
      return new Response(JSON.stringify({ kind: "CANDIDATE", candidate: shellCandidate(plan, texts), retention: "CONFIRMED_NOT_STORED", usage: USAGE }), { headers: { "content-type": "application/json" } });
    });
  }
  /** The demo dataset the app opens with: a new local dataset, seeded with the synthetic scenario (the runtime's default). */
  async function demoRuntime(at: Instant = LATER) {
    const name = `i5-demo-${crypto.randomUUID()}`;
    names.push(name);
    const runtime = await createBrowserJournalRuntime(name, { now: () => at });
    opened.push(runtime);
    return runtime;
  }

  it.each(DEMO_CLOCKS)("History ($label): the prepared data ends yesterday; the demo comparison's en-SG request is admitted (a00d8ad5…), disclosure first, one POST of that class when accepted; zh-SG is never admitted", async ({ at, today, yesterday, thisWeek }) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = await demoRuntime(at);
    // Nothing is dated today or later: the newest recorded position is yesterday's ("30 days" ends today).
    const thirty = await runtime.history.load({ period: "THIRTY_DAYS" });
    if (thirty.status !== "READY") throw new Error(thirty.status);
    const recordedDates = thirty.projection.chart.filter((position) => position.state === "RECORDED").map((position) => position.date).sort();
    expect(recordedDates.at(-1)).toBe(yesterday);
    expect(recordedDates.every((date) => date < today)).toBe(true);
    expect(thirty.projection.readingCount).toBe(33);
    // "Last week" and "30 days" have readings on any day; "This week" is empty on a Monday (the data ends yesterday).
    const lastWeek = await runtime.history.load({ period: "LAST_WEEK" });
    expect(lastWeek.status).toBe("READY");
    expect((await runtime.history.load({ period: "THIS_WEEK" })).status).toBe(thisWeek);
    // The one governed statement: before breakfast, recent readings lower than the reference period's (the improvement).
    for (const view of [thirty, lastWeek]) {
      expect(view.status === "READY" && view.comparisons.map((fact) => [fact.factId, fact.kind, fact.recent, fact.reference, fact.correctionUpdated])).toEqual([["COMPARISON:BEFORE_BREAKFAST", "LOWER", "6.1", "7.5", true]]);
    }
    const factId = "COMPARISON:BEFORE_BREAKFAST";
    expect(await explainClassOfFact(runtime.history, factId, "en-SG")).toBe(EN_EXPLAIN);
    expect(await explainClassOfFact(runtime.history, factId, "zh-SG")).toBe(ZH_EXPLAIN);
    const fetcher = fakeDemoRoute();
    const before = vi.mocked(createAiHybridTaskService).mock.calls.length;
    const log = audit();
    const explainer = createBrowserAiAssistance({ history: runtime.history, carePreparation: runtime.carePreparation, audit: log.port, fetcher, now: () => at }).history;
    // Nothing injected: the one service runs on the shipped manifest and the shipped gate.
    const deps = vi.mocked(createAiHybridTaskService).mock.calls.slice(before).map((call) => call[0]);
    expect(deps.map((dep) => [dep.manifest, dep.requestClassGate])).toEqual([[AI_ACTIVATION_MANIFEST, SHIPPED_REQUEST_CLASS_GATE]]);
    expect(AI_ACTIVATION_MANIFEST.tasks).toMatchObject({ EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED", DRAFT_CARE_PREPARATION_SUMMARY: "SYNTHETIC_REMOTE_ENABLED" });
    // en-SG: the disclosure first; without the request's own decision nothing is sent.
    expect(await explainer.disclosureRequired({ factId, locale: "en-SG" })).toBe(true);
    expect(await explainer.explain({ factId, locale: "en-SG" })).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC", remoteUse: "NOT_ACCEPTED" });
    expect(fetcher).not.toHaveBeenCalled();
    // Accepted: exactly one value-blind POST of the qualified class, and the AI explanation.
    expect(await explainer.explain({ factId, locale: "en-SG", disclosure: "ACCEPTED" })).toMatchObject({ kind: "EXPLAINED", source: "AI" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(AI_SHELL_ROUTE_PATH);
    expect(postedClass(fetcher.mock.calls[0]![1])).toBe(EN_EXPLAIN);
    expect(fetcher.mock.calls[0]![1].body as string).not.toMatch(/periodSummary|"facts"|sources|revisionId|recordId|\d{4}-\d{2}-\d{2}|\d\.\d/);
    // zh-SG: never admitted (PENDING): no disclosure, the standard wording even with an acceptance, nothing sent.
    expect(await explainer.disclosureRequired({ factId, locale: "zh-SG" })).toBe(false);
    expect(await explainer.explain({ factId, locale: "zh-SG", disclosure: "ACCEPTED" })).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.rows.map((row) => [row.locale, row.outcomeCode, row.attempts.count])).toEqual([
      ["en-SG", "REMOTE_USE_NOT_ACCEPTED", 0],
      ["en-SG", "ACCEPTED", 1],
      ["zh-SG", "REQUEST_CLASS_NOT_QUALIFIED", 0],
    ]);
  }, 60_000);

  it("Care: the evaluated en-SG ORDINARY preview is admitted (5d0c75ce…), disclosure first, one POST of that class when accepted; in zh-SG it is never offered or sent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const [locale, classId, admitted] of [["en-SG", EN_CARE_ORDINARY, true], ["zh-SG", ZH_CARE_ORDINARY, false]] as const) {
      const h = await createCarePreparationHarness();
      const commands = createCarePreparationService(h.database, { now: () => LATER, ids: testIds, projectAiCareSummary: projectValidatedAiCareSummary });
      const audits = createAiInvocationAuditRepository(h.database);
      const reading = await h.journal.recordGlucose({ payload: { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L" as const, normalization: null }, measurementMethod: "FINGERSTICK_METER" as const, context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: "BEDTIME" as const } }, temporal: { kind: "POINT", occurrence: exact("2026-10-03T13:00:00.000Z") }, recordedAt: LATER });
      const question = await h.organisation.createCareQuestion({ questionText: { text: "Can I keep the pen in my bag? (demo)", language: "en-SG" } });
      if (reading.kind !== "COMMITTED" || question.kind !== "COMMITTED") throw new Error("fixture");
      // The ORDINARY shape: one reading and one question, no appointment.
      const prepared = await commands.prepare({ ...(await h.selection()), locale, appointment: null });
      if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
      const view = await h.query.loadSummary(prepared.recordId);
      if (view.status !== "READY") throw new Error("ready");
      const built = buildCareSummaryAiRequest({ current: view.payload, requestId: "33333333-3333-4333-8333-333333333333", requestedAt: LATER });
      if (built.kind !== "READY") throw new Error(built.reason);
      const planned = planSlots(built.request, resolveAiHybridBundle("DRAFT_CARE_PREPARATION_SUMMARY", locale));
      if (planned.kind !== "PLANNED") throw new Error("plan");
      expect(requestClassIdentity(projectShellTaskRequest(planned.plan)).classId, locale).toBe(classId);
      const fetcher = fakeDemoRoute();
      const wording = createBrowserAiAssistance({ history: { load: vi.fn(), loadExplainablePattern: vi.fn() }, carePreparation: { query: h.query, commands }, audit: audits, fetcher, now: () => LATER }).careSummary!;
      const snapshotRef = { recordId: prepared.recordId, expectedRevisionId: prepared.revisionId, expectedRevisionNumber: prepared.revisionNumber };
      expect(wording.available(view.payload), locale).toBe(admitted);
      expect(await wording.disclosureRequired(view.payload), locale).toBe(admitted);
      if (admitted) {
        // Without the request's own decision nothing is sent; accepted: one POST of exactly the qualified class, and the replacement.
        expect((await wording.compose({ snapshotRef, locale })).kind).toBe("KEPT_DETERMINISTIC");
        expect(fetcher).not.toHaveBeenCalled();
        const outcome = await wording.compose({ snapshotRef, locale, disclosure: "ACCEPTED" });
        expect(outcome.kind).toBe("REPLACED");
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(postedClass(fetcher.mock.calls[0]![1])).toBe(classId);
        expect(fetcher.mock.calls[0]![1].body as string).not.toMatch(/6\.6|mmol|pen in my bag|revisionId|recordId|\d{4}-\d{2}-\d{2}/);
        expect((await audits.list()).map((row) => [row.outcomeCode, row.attempts.count]).sort()).toEqual([["ACCEPTED", 1], ["REMOTE_USE_NOT_ACCEPTED", 0]]);
      } else {
        expect(await wording.compose({ snapshotRef, locale, disclosure: "ACCEPTED" })).toEqual({ kind: "KEPT_DETERMINISTIC", reason: "TASK_DISABLED" });
        expect(fetcher).not.toHaveBeenCalled();
        expect((await audits.list()).map((row) => [row.outcomeCode, row.attempts.count])).toEqual([["REQUEST_CLASS_NOT_QUALIFIED", 0]]);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);

  it.each(DEMO_CLOCKS)("Care over the demo dataset ($label, 14-day visit period): outside the evaluated classes, en-SG is offered by the owner demo override (disclosure first, one value-blind POST when accepted, the AI-assisted preview); zh-SG and over-budget selections never", async ({ at }) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = await demoRuntime(at);
    const visit = await runtime.careOrganisation.query.loadVisitPreparation();
    if (visit.status !== "READY" || !visit.appointment) throw new Error("visit");
    // The 14 local days ending today; the seeded appointment; the seeded demo question (owner decision 2026-10-12), saved as the
    // add-question screen saves one.
    expect(Math.round((Date.parse(visit.period.endAtExclusive) - Date.parse(visit.period.startAt)) / 86_400_000)).toBe(14);
    expect(visit.factGroups.map((group) => [group.key, group.sources.length])).toEqual([["GLUCOSE", 11], ["INSULIN", 10], ["MEALS", 10], ["WALKS", 8]]);
    expect(visit.questions.map((entry) => [entry.text, entry.language])).toEqual([[SYNTHETIC_CARE_QUESTION_TEXT, "und"]]);
    const fetcher = fakeDemoRoute();
    const wording = createBrowserAiAssistance({ history: runtime.history, carePreparation: runtime.carePreparation, audit: runtime.aiAudit, fetcher, now: () => at }).careSummary!;
    const evaluated = new Set(AI_REQUEST_CLASS_DEFINITIONS.map((definition) => definition.classId));
    const appointment = { recordType: "APPOINTMENT" as const, recordId: visit.appointment.recordId, revisionId: visit.appointment.revisionId };
    const question = { recordType: "CARE_QUESTION" as const, recordId: visit.questions[0]!.recordId, revisionId: visit.questions[0]!.revisionId };
    const selections: Array<[string, readonly string[], boolean]> = [
      ["GLUCOSE + question", ["GLUCOSE"], true],
      ["every group + question", ["GLUCOSE", "INSULIN", "MEALS", "WALKS"], true],
      ["GLUCOSE", ["GLUCOSE"], false],
      ["INSULIN", ["INSULIN"], false],
      ["MEALS", ["MEALS"], false],
      ["WALKS", ["WALKS"], false],
    ];
    const outcomes: string[] = [];
    let demoSnapshot: Parameters<typeof wording.compose>[0]["snapshotRef"] | null = null;
    for (const locale of ["en-SG", "zh-SG"] as const) {
      // Each selection with the seeded appointment (the screen always includes it).
      for (const [label, keys, withQuestion] of selections) {
        const prepared = await runtime.carePreparation.commands.prepare({
          locale,
          period: visit.period,
          appointment,
          groups: visit.factGroups.filter((entry) => keys.includes(entry.key)).map((entry) => ({ key: entry.key, sources: entry.sources })),
          questions: withQuestion ? [question] : [],
          notSelected: visit.factGroups.filter((entry) => !keys.includes(entry.key)).flatMap((entry) => entry.sources),
        });
        if (prepared.kind !== "COMMITTED") throw new Error(JSON.stringify(prepared));
        const view = await runtime.carePreparation.query.loadSummary(prepared.recordId);
        if (view.status !== "READY") throw new Error("ready");
        const built = buildCareSummaryAiRequest({ current: view.payload, requestId: "33333333-3333-4333-8333-333333333333", requestedAt: at });
        let outcome: string = built.kind === "READY" ? "READY" : built.reason;
        if (built.kind === "READY") {
          const planned = planSlots(built.request, resolveAiHybridBundle("DRAFT_CARE_PREPARATION_SUMMARY", locale));
          const classOutcome = planned.kind !== "PLANNED" || planned.plan.remote.eligible !== true ? "NOT_REMOTE_ELIGIBLE" : evaluated.has(requestClassIdentity(projectShellTaskRequest(planned.plan)).classId) ? "EVALUATED_CLASS" : "NO_DEFINITION";
          outcome = `${built.request.facts.length} facts, ${classOutcome}`;
        }
        outcomes.push(`${locale} ${label}: ${outcome}`);
        // Owner demo override (owner decision 2026-10-12): an en-SG care request within the limits is offered even of no evaluated class.
        const offered = locale === "en-SG" && /facts, (NO_DEFINITION|EVALUATED_CLASS)$/.test(outcome);
        expect(wording.available(view.payload), `${locale} ${label}`).toBe(offered);
        expect(await wording.disclosureRequired(view.payload), `${locale} ${label}`).toBe(offered);
        if (locale === "en-SG" && label === "GLUCOSE + question") demoSnapshot = { recordId: prepared.recordId, expectedRevisionId: prepared.revisionId, expectedRevisionNumber: prepared.revisionNumber };
      }
    }
    // GLUCOSE + question: 11 readings, the appointment (service and date) and the question = 14 facts, 18 under the 32-fact limit and
    // within the English remote wording budget. Every group at once reaches the 32-fact limit and exceeds the remote wording budget
    // (one more fact is TOO_MANY_FACTS): the standard wording is kept. Insulin records are never sent (only the appointment's 2 facts).
    expect(outcomes).toEqual([
      "en-SG GLUCOSE + question: 14 facts, NO_DEFINITION",
      "en-SG every group + question: 32 facts, NOT_REMOTE_ELIGIBLE",
      "en-SG GLUCOSE: 13 facts, NO_DEFINITION",
      "en-SG INSULIN: 2 facts, NO_DEFINITION",
      "en-SG MEALS: 12 facts, NO_DEFINITION",
      "en-SG WALKS: 10 facts, NO_DEFINITION",
      "zh-SG GLUCOSE + question: 14 facts, NO_DEFINITION",
      "zh-SG every group + question: 32 facts, NOT_REMOTE_ELIGIBLE",
      "zh-SG GLUCOSE: 13 facts, NO_DEFINITION",
      "zh-SG INSULIN: 2 facts, NO_DEFINITION",
      "zh-SG MEALS: 12 facts, NO_DEFINITION",
      "zh-SG WALKS: 10 facts, NO_DEFINITION",
    ]);
    // Nothing is sent by being offered; the demo selection (GLUCOSE + question, en-SG): no POST without the request's own decision,
    // then exactly one value-blind POST when accepted, and the AI-assisted (REPLACED) preview.
    expect(fetcher).not.toHaveBeenCalled();
    if (!demoSnapshot) throw new Error("demo snapshot");
    expect((await wording.compose({ snapshotRef: demoSnapshot, locale: "en-SG" })).kind).toBe("KEPT_DETERMINISTIC");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await wording.compose({ snapshotRef: demoSnapshot, locale: "en-SG", disclosure: "ACCEPTED" })).kind).toBe("REPLACED");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1].body as string).not.toMatch(/\d\.\d|mmol|keep checking|revisionId|recordId|\d{4}-\d{2}-\d{2}/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);
});

/** The EXPLAIN class of one comparison's own request in `locale` (the same pure builder, planner and projection as the wiring). */
async function explainClassOfFact(history: RecordedHistoryQueryPort, factId: string, locale: "en-SG" | "zh-SG"): Promise<string> {
  const loaded = await history.loadExplainablePattern({ factId });
  if (loaded.kind !== "EXPLAINABLE") throw new Error("fixture");
  const request = buildSourceBackedExplainRequest({ view: loaded.view, locale, requestId: "8b3d4e5f-6a70-4b1c-9d2e-000000000000", requestedAt: NOW as Instant });
  const planned = planSlots(request, resolveAiHybridBundle("EXPLAIN_PATTERN", locale));
  if (planned.kind !== "PLANNED") throw new Error("plan");
  return requestClassIdentity(projectShellTaskRequest(planned.plan)).classId;
}
