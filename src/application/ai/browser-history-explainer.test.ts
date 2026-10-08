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
import { createBrowserHistoryExplainer } from "./browser-history-explainer";
import type { AiRemoteUseDisclosure, BrowserShellFetcher } from "./browser-shell-client";
import { shellPlanView } from "./language/shell-projector";

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
  it("exports only its factory; it names no credential, endpoint, provider adapter or legacy service and sends nothing itself", () => {
    expect(Object.keys(wiring)).toEqual(["createBrowserHistoryExplainer"]);
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

  it("activated (test manifest) with the default interim disclosure: still DETERMINISTIC and never a POST", async () => {
    const { history } = await higherFixture();
    const log = audit();
    const fetcher = fakeRoute();
    const result = await createBrowserHistoryExplainer({ history, audit: log.port, manifest: ENABLED, fetcher }).explain({ factId: FACT, locale: "en-SG" });
    expect(result).toMatchObject({ kind: "EXPLAINED", source: "DETERMINISTIC" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]!.outcomeCode).toBe("MISSING_CONFIGURATION");
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
