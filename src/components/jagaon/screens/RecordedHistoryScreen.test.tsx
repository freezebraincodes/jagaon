import { StrictMode, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import type { AiLocale, AiTaskRequest } from "@/domain/ai";
import { getMessages } from "@/i18n/get-messages";
import { createMemoryOnboardingStorage } from "@/application/onboarding/demo-onboarding-repository";
import {
  APPOINTMENT_NOTE_SELECTION_KEY,
  createAppointmentNoteSelectionRepository,
} from "@/application/history/appointment-note-selection";
import type { RecordedHistoryQueryPort, RecordedHistoryView } from "@/application/history/recorded-history-contracts";
import { databases, dayBefore, FACT, higherFixture, local, NOW, reading, RECENT, REFERENCE, setup, TODAY } from "@/application/history/history-test-support";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { createAiHybridTaskService, type AiHybridExecutionResult } from "@/application/ai/ai-hybrid-task-service";
import { createPatternExplainer } from "@/application/ai/explain-pattern";
import { createBrowserHistoryExplainer } from "@/application/ai/browser-history-explainer";
import type { BrowserShellFetcher } from "@/application/ai/browser-shell-client";
import type { AiActivationManifest } from "@/application/ai/ai-activation-manifest";
import { shellPlanView } from "@/application/ai/language/shell-projector";
import { shellCandidate } from "@/ai/evaluation/packet-11-hybrid-test-support";
import { shellTaskRequestSchema, slotToken, type AiInvocationAuditRow, type ShellFieldPath } from "@/domain/ai";
import type { PatternExplainerPort, PatternExplanationResult } from "../history/PatternExplanationPanel";
import { RecordedHistoryScreen } from "./RecordedHistoryScreen";
import { qualifiedTestRequestClassGate } from "@/application/ai/request-class-test-support";

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
  cleanup();
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");

function readyView(overrides: Partial<Extract<RecordedHistoryView, { status: "READY" }>> = {}): RecordedHistoryView {
  return {
    status: "READY",
    unavailableFamilies: [],
    comparisons: [
      {
        factId: "COMPARISON:BEFORE_BREAKFAST",
        slot: "BEFORE_BREAKFAST",
        kind: "HIGHER",
        recent: "7.3",
        reference: "6",
        recentWindow: { startDate: "2026-09-20", endDate: "2026-10-04" },
        referenceWindow: { startDate: "2026-08-23", endDate: "2026-09-20" },
        correctionUpdated: true,
      },
      {
        factId: "NO_MATERIAL:BEFORE_DINNER",
        slot: "BEFORE_DINNER",
        kind: "NO_MATERIAL",
        recent: null,
        reference: null,
        recentWindow: { startDate: "2026-09-20", endDate: "2026-10-04" },
        referenceWindow: { startDate: "2026-08-23", endDate: "2026-09-20" },
        correctionUpdated: false,
      },
    ],
    projection: {
      period: "THIS_WEEK",
      range: { startDate: "2026-09-28", endDate: "2026-09-30" },
      unit: "MMOL_L",
      readingCount: 4,
      valueRange: { minimum: "5.9", maximum: "8.4" },
      slotCounts: [
        { slot: "BEFORE_BREAKFAST", count: 3 },
        { slot: "BEFORE_DINNER", count: 1 },
      ],
      chart: [
        { date: "2026-09-28", position: "MORNING", state: "RECORDED", valueMmolL: "6.1", readingCount: 1 },
        { date: "2026-09-28", position: "EVENING", state: "RECORDED", valueMmolL: "8.4", readingCount: 1 },
        { date: "2026-09-29", position: "MORNING", state: "RECORDED", valueMmolL: "6.4", readingCount: 1 },
        { date: "2026-09-29", position: "EVENING", state: "NOT_RECORDED" },
        { date: "2026-09-30", position: "MORNING", state: "RECORDED", valueMmolL: "5.9", readingCount: 1 },
        { date: "2026-09-30", position: "EVENING", state: "NOT_RECORDED" },
      ],
      notRecordedPositions: [
        { date: "2026-09-29", position: "EVENING" },
        { date: "2026-09-30", position: "EVENING" },
      ],
      stamps: [
        { date: "2026-09-28", recordedPositions: 2, complete: true },
        { date: "2026-09-29", recordedPositions: 1, complete: false },
        { date: "2026-09-30", recordedPositions: 1, complete: false },
      ],
      source: "PATIENT_ENTERED",
      correctedRecordCount: 1,
      repeated: [
        { factId: "REPEATED:fik-a", kind: "ITEM", label: "Kaya toast", count: 3, days: 3 },
        { factId: "REPEATED:fik-b", kind: "CONTEXT", label: "Morning walk", count: 2, days: 2 },
      ],
      selectableFactIds: [
        "READING_COUNT",
        "VALUE_RANGE",
        "SLOT_COUNT:BEFORE_BREAKFAST",
        "SLOT_COUNT:BEFORE_DINNER",
        "COMPARISON:BEFORE_BREAKFAST",
        "NO_MATERIAL:BEFORE_DINNER",
        "REPEATED:fik-a",
        "REPEATED:fik-b",
        "NOT_RECORDED_POSITIONS",
        "SOURCE",
        "CORRECTIONS",
      ],
    },
    ...overrides,
  } as RecordedHistoryView;
}

const notExplained = vi.fn(async () => ({ kind: "INELIGIBLE" as const, reason: "NOT_FOUND" as const }));

function port(view: RecordedHistoryView | ((period: string) => Promise<RecordedHistoryView>)): RecordedHistoryQueryPort {
  return { load: vi.fn(async ({ period }) => (typeof view === "function" ? view(period) : view)), loadExplainablePattern: notExplained };
}

function selectionRepository() {
  const storage = createMemoryOnboardingStorage();
  return { storage, repository: createAppointmentNoteSelectionRepository(storage, () => "2026-10-04T02:00:00.000Z" as never) };
}

async function renderScreen(history: RecordedHistoryQueryPort, locale: "en-SG" | "zh-SG" = "en-SG", repository = selectionRepository().repository) {
  const messages = locale === "en-SG" ? en : zh;
  const result = render(<RecordedHistoryScreen messages={messages} locale={locale} history={history} selection={repository} />);
  await act(async () => undefined);
  return result;
}

describe("Recorded history screen", () => {
  it("shows the loading state until the port answers", async () => {
    let resolve: (view: RecordedHistoryView) => void = () => undefined;
    const pending = port(() => new Promise<RecordedHistoryView>((r) => (resolve = r)));
    render(<RecordedHistoryScreen messages={en} locale="en-SG" history={pending} selection={selectionRepository().repository} />);
    expect(screen.getByRole("status")).toHaveTextContent(en.history.loading);
    await act(async () => undefined);
    await act(async () => resolve(readyView()));
    expect(screen.queryByText(en.history.loading)).not.toBeInTheDocument();
  });

  it("renders one page heading, the period control, the explicit range and a neutral chart with a table equivalent", async () => {
    await renderScreen(port(readyView()));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: en.history.title })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")?.textContent)).toEqual([
      en.history.periodThisWeek,
      en.history.periodLastWeek,
      en.history.periodThirtyDays,
    ]);
    expect(radios[0]).toBeChecked();
    expect(screen.getAllByText("28–30 Sep 2026").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 2, name: en.history.readingsTitle("mmol/L") })).toBeInTheDocument();
    expect(screen.getByText(en.history.chartDescription(4, 6, "mmol/L"))).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(within(table).getAllByText(en.history.notRecordedLegend)).toHaveLength(2);
    expect(screen.getByText(en.history.recordedLegend)).toBeInTheDocument();
    expect(screen.getByText(en.history.chartSlotsNote)).toBeInTheDocument();
    expect(document.querySelectorAll(".history-bar--missing")).toHaveLength(2);
    expect(document.querySelectorAll("[class*='target'], [class*='threshold'], [class*='risk']")).toHaveLength(0);
  });

  it("states every descriptive fact with its window, provenance and limitations", async () => {
    await renderScreen(port(readyView()));
    const h = en.history;
    expect(screen.getByRole("heading", { level: 2, name: h.factsTitle })).toBeInTheDocument();
    expect(screen.getByText(h.recordedDataTag)).toBeInTheDocument();
    expect(screen.getByText("4 readings were recorded from 28–30 Sep 2026.")).toBeInTheDocument();
    expect(screen.getByText(h.valueRange("5.9", "8.4", "mmol/L"))).toBeInTheDocument();
    expect(screen.getByText(h.slotCount(h.slotLabels.BEFORE_BREAKFAST, 3))).toBeInTheDocument();
    expect(screen.getByText(h.comparisonHigher(h.slotLabels.BEFORE_BREAKFAST, "7.3", "6", "mmol/L"))).toBeInTheDocument();
    expect(screen.getByText(h.noMaterialComparison(h.slotLabels.BEFORE_DINNER))).toBeInTheDocument();
    expect(screen.getAllByText("Evidence windows: recent 20 Sep – 4 Oct 2026; earlier comparison 23 Aug – 20 Sep 2026.")).toHaveLength(2);
    expect(screen.getByText(h.correctionUpdated)).toBeInTheDocument();
    expect(screen.getByText(h.repeatedItem("Kaya toast", 3, 3))).toBeInTheDocument();
    expect(screen.getByText(h.repeatedContext("Morning walk", 2, 2))).toBeInTheDocument();
    expect(screen.getByText("No reading was recorded for Tuesday evening and Wednesday evening.")).toBeInTheDocument();
    expect(screen.getByText(h.sourceSummary(h.sourcePatientEntered))).toBeInTheDocument();
    expect(screen.getByText(h.correctionSummary(1))).toBeInTheDocument();
    expect(screen.getByText(h.nonCausalLimitation)).toBeInTheDocument();
    expect(screen.getByText(h.loggingLimitation)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: h.bookletTitle })).toBeInTheDocument();
    expect(screen.getByText(h.bookletOnly)).toBeInTheDocument();
    expect(screen.getByText(h.bookletExplanation)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Both display positions recorded on Mon 28 Sep/ })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /^1 of 2 display positions recorded on/ })).toHaveLength(2);
  });

  it("loads another period and ignores a stale response", async () => {
    const responses: Record<string, (view: RecordedHistoryView) => void> = {};
    const history = port((period) => new Promise<RecordedHistoryView>((resolve) => (responses[period] = resolve)));
    render(<RecordedHistoryScreen messages={en} locale="en-SG" history={history} selection={selectionRepository().repository} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodLastWeek }));
    await act(async () => undefined);
    expect(history.load).toHaveBeenLastCalledWith({ period: "LAST_WEEK" });
    await act(async () => responses.LAST_WEEK!({ status: "EMPTY", period: "LAST_WEEK", range: { startDate: "2026-09-21", endDate: "2026-09-27" }, unavailableFamilies: [] } as unknown as RecordedHistoryView));
    await act(async () => responses.THIS_WEEK!(readyView()));
    expect(screen.getByText(en.history.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(en.history.emptyBody)).toBeInTheDocument();
    expect(screen.queryByText(en.history.factsTitle)).not.toBeInTheDocument();
  });

  it("explains insufficient evidence while still showing recorded counts", async () => {
    const view = readyView();
    if (view.status !== "READY") throw new Error();
    await renderScreen(port({ ...view, status: "INSUFFICIENT_EVIDENCE", comparisons: [] } as RecordedHistoryView));
    expect(screen.getByText(en.history.insufficientTitle)).toBeInTheDocument();
    expect(screen.getByText(en.history.insufficientBody)).toBeInTheDocument();
    expect(screen.getByText(en.history.valueRange("5.9", "8.4", "mmol/L"))).toBeInTheDocument();
  });

  it("shows a truthful unavailable state and retries", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ status: "UNAVAILABLE", code: "STORAGE_UNAVAILABLE" })
      .mockResolvedValueOnce(readyView());
    await renderScreen({ load, loadExplainablePattern: notExplained });
    expect(screen.getByRole("heading", { level: 2, name: en.history.unavailableTitle })).toBeInTheDocument();
    expect(screen.getByText(en.history.unavailableBody)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.history.retry }));
    await act(async () => undefined);
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText(en.history.factsTitle)).toBeInTheDocument();
  });

  it("names a disabled comparison family as unavailable without a conclusion", async () => {
    await renderScreen(port(readyView({ unavailableFamilies: ["ROUTINE_SHIFT"] })));
    expect(screen.getByText(en.history.familyUnavailable)).toBeInTheDocument();
  });

  it("saves a user-initiated selection locally and says nothing was sent", async () => {
    const { storage, repository } = selectionRepository();
    await renderScreen(port(readyView()), "en-SG", repository);
    expect(screen.getByText(en.history.actionsTag)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.history.addFacts }));
    expect(screen.getByRole("status")).toHaveTextContent(en.history.selectionSaved);
    const saved = JSON.parse(storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)!);
    expect(saved.selections[0].factIds).toHaveLength(11);

    fireEvent.click(screen.getByRole("button", { name: en.history.selectFacts }));
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(11);
    expect(checkboxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getAllByText(en.history.factSelected)).toHaveLength(11);
    fireEvent.click(screen.getByRole("checkbox", { name: en.history.valueRange("5.9", "8.4", "mmol/L") }));
    expect(screen.getAllByText(en.history.factNotSelected)).toHaveLength(1);
    expect(JSON.parse(storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)!).selections[0].factIds).not.toContain("VALUE_RANGE");
  });

  it("renders zh-SG copy with patient labels verbatim", async () => {
    await renderScreen(port(readyView()), "zh-SG");
    expect(screen.getByRole("heading", { level: 1, name: zh.history.title })).toBeInTheDocument();
    expect(screen.getByText(zh.history.repeatedItem("Kaya toast", 3, 3))).toBeInTheDocument();
    expect(screen.getByText(zh.history.comparisonHigher(zh.history.slotLabels.BEFORE_BREAKFAST, "7.3", "6", "mmol/L"))).toBeInTheDocument();
    expect(screen.getByText(/周二晚上和周三晚上没有读数记录。/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Recorded history|What these records show|Booklet stamps/);
  });

  it("never renders clinical, causal or adherence wording", async () => {
    await renderScreen(port(readyView()));
    const text = (document.body.textContent ?? "").replace(en.history.nonCausalLimitation, "").replace(en.history.loggingLimitation, "");
    for (const pattern of [/\bhigh\b/i, /\blow\b/i, /normal/i, /\bsafe\b/i, /target/i, /risk/i, /missed/i, /adheren/i, /improv/i, /worsen/i, /cause/i]) {
      expect(text).not.toMatch(pattern);
    }
  });

  it("offers no explanation action and probes nothing when no explainer is supplied", async () => {
    const history = port(readyView());
    await renderScreen(history);
    expect(screen.queryByRole("button", { name: en.history.explanation.action })).not.toBeInTheDocument();
    expect(history.loadExplainablePattern).not.toHaveBeenCalled();
  });
});

// --- Packet 11C Task 7: the explanation panel on the real journal -> coordinator -> evaluator -> query -> use case ---

type Execute = (request: AiTaskRequest, signal?: AbortSignal) => Promise<AiHybridExecutionResult>;
type Explained = Extract<PatternExplanationResult, { kind: "EXPLAINED" }>;

const requestIds = () => {
  let n = 0;
  return () => `8b3d4e5f-6a70-4b1c-9d2e-${(n++).toString(16).padStart(12, "0")}`;
};

/** The real hybrid service under the SHIPPED manifest (EXPLAIN_PATTERN NOT_ACTIVATED); `invoke` is never reached. */
function shippedExecute(invoke = vi.fn()): Execute {
  return createAiHybridTaskService({
    releaseProfile: "HACKATHON_DEMO",
    audit: { append: async () => undefined },
    now: () => NOW,
    monotonicMs: () => 0,
    manifest: AI_ACTIVATION_MANIFEST,
    provider: { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, invoke },
  }).execute;
}

/** The real use case; `execute` defaults to the shipped hybrid service. */
function realExplainer(history: RecordedHistoryQueryPort, execute: Execute = shippedExecute()): PatternExplainerPort {
  // Packet 11C Addendum C (C5): the zero-attempt rows go nowhere here (these tests pin the screen, not the audit).
  return createPatternExplainer({ history, execute, recordUnsent: async () => true, now: () => NOW as Instant, requestId: requestIds() });
}

/** Each `execute` call waits until the test releases it, then delegates to the real hybrid service. */
function heldExecute(inner: Execute = shippedExecute()) {
  const calls: Array<{ request: AiTaskRequest; signal?: AbortSignal; release: () => void }> = [];
  const execute: Execute = (request, signal) =>
    new Promise((resolve, reject) => calls.push({ request, signal, release: () => void inner(request, signal).then(resolve, reject) }));
  return { execute, calls };
}

/**
 * A port that answers each call only when the test resolves it, with a real explanation computed beforehand, and IGNORES the abort
 * signal: the screen alone must discard a late answer.
 */
function heldPort(results: Readonly<Record<AiLocale, PatternExplanationResult>>) {
  const calls: Array<{ input: { factId: string; locale: AiLocale }; signal?: AbortSignal; resolve: () => void }> = [];
  const explainer: PatternExplainerPort = {
    explain: (input, signal) => new Promise((resolve) => calls.push({ input, signal, resolve: () => resolve(results[input.locale]) })),
  };
  return { explainer, calls };
}

async function realResults(history: RecordedHistoryQueryPort): Promise<Record<AiLocale, Explained>> {
  const explainer = realExplainer(history);
  const out = {} as Record<AiLocale, Explained>;
  for (const locale of ["en-SG", "zh-SG"] as const) {
    const result = await explainer.explain({ factId: FACT, locale });
    if (result.kind !== "EXPLAINED") throw new Error(`not explained: ${JSON.stringify(result)}`);
    out[locale] = result;
  }
  return out;
}

/** C3 fix round 1: two explainable comparisons (the higher before-breakfast series, and the same series before dinner). */
async function twoComparisonFixture() {
  const harness = await setup();
  for (const [d, v] of [...REFERENCE, ...RECENT]) {
    await reading(harness.journal, dayBefore(TODAY, d), "07:30", v);
    await reading(harness.journal, dayBefore(TODAY, d), "18:30", v, "BEFORE_DINNER");
  }
  await harness.coordinator.processPending();
  return harness;
}

const headlineOf = (explanation: Explained) => (explanation.composition.output.payload as { headline: { text: string } }).headline.text;

/** One selection repository per history port, as the app keeps one (a new repository would reload the view). */
const selections = new WeakMap<RecordedHistoryQueryPort, ReturnType<typeof selectionRepository>["repository"]>();

function screenElement(locale: AiLocale, history: RecordedHistoryQueryPort, explainer: PatternExplainerPort | null) {
  if (!selections.has(history)) selections.set(history, selectionRepository().repository);
  return <RecordedHistoryScreen messages={getMessages(locale)} locale={locale} history={history} selection={selections.get(history)!} explainer={explainer} />;
}

async function openAction(locale: AiLocale = "en-SG") {
  const action = await screen.findByRole("button", { name: getMessages(locale).history.explanation.action });
  fireEvent.click(action);
  await act(async () => undefined);
  return action;
}

describe("Recorded history explanation panel (Packet 11C Task 7)", () => {
  it("offers the action only on comparisons whose source projection is EXPLAINABLE", async () => {
    const { history: real } = await higherFixture();
    const probe = vi.fn((request: { factId: string }) => real.loadExplainablePattern(request));
    const history: RecordedHistoryQueryPort = { load: (request) => real.load(request), loadExplainablePattern: probe };
    render(screenElement("en-SG", history, realExplainer(real)));
    const action = await screen.findByRole("button", { name: en.history.explanation.action });
    expect(screen.getAllByRole("button", { name: en.history.explanation.action })).toHaveLength(1);
    expect(probe).toHaveBeenCalledWith({ factId: FACT });
    // The action belongs to the before-breakfast comparison fact, not to any other fact.
    const fact = action.closest("li")!;
    expect(fact.textContent).toContain(en.history.comparisonHigher(en.history.slotLabels.BEFORE_BREAKFAST, "7.35", "6", "mmol/L"));
    expect(action).toHaveAttribute("aria-expanded", "false");
    // Layout structure: icon and fact text stay the first two children (one row); the action is a separate third child row.
    expect(fact).toHaveClass("history-fact", "history-fact--extended");
    expect([...fact.children].map((child) => child.className)).toEqual(["history-fact-icon", "history-fact-body", "history-fact-extra"]);
    expect(fact.children[2]).toContainElement(action);
    for (const other of [...document.querySelectorAll("li.history-fact")].filter((item) => item !== fact)) {
      expect(other).not.toHaveClass("history-fact--extended");
      expect(other.querySelector(".history-fact-extra")).toBeNull();
    }
    cleanup();

    // The same READY comparison whose projection is not explainable (for example a stale source) gets no action.
    const ineligible = port(readyView());
    ineligible.loadExplainablePattern = vi.fn(async () => ({ kind: "INELIGIBLE" as const, reason: "STALE_SOURCE" as const }));
    render(<RecordedHistoryScreen messages={en} locale="en-SG" history={ineligible} selection={selectionRepository().repository} explainer={realExplainer(ineligible)} />);
    await act(async () => undefined);
    await act(async () => undefined);
    expect(ineligible.loadExplainablePattern).toHaveBeenCalledWith({ factId: "COMPARISON:BEFORE_BREAKFAST" });
    expect(screen.getByText(en.history.comparisonHigher(en.history.slotLabels.BEFORE_BREAKFAST, "7.3", "6", "mmol/L"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.history.explanation.action })).not.toBeInTheDocument();
  });

  it("opens the deterministic explanation under the unchanged 7A card text: heading focused, status announced, no provider call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { history } = await higherFixture();
      const invoke = vi.fn();
      const expected = await realResults(history);
      render(screenElement("en-SG", history, realExplainer(history, shippedExecute(invoke))));
      const cardText = en.history.comparisonHigher(en.history.slotLabels.BEFORE_BREAKFAST, "7.35", "6", "mmol/L");
      const action = await openAction();
      expect(action).toHaveAttribute("aria-expanded", "true");
      const panel = await screen.findByRole("region", { name: en.history.explanation.title });
      expect(action.getAttribute("aria-controls")).toBe(panel.id);
      expect(within(panel).getByRole("heading", { level: 3 })).toHaveFocus();
      await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent(headlineOf(expected["en-SG"])));
      expect(within(panel).queryByText(en.history.explanation.aiLabel)).not.toBeInTheDocument();
      // Packet 11C Addendum C, C4: no AI tag or check line on the deterministic explanation.
      expect(within(panel).queryByText(en.ai.demoTag)).not.toBeInTheDocument();
      expect(within(panel).queryByText(en.ai.resultCheck)).not.toBeInTheDocument();
      // The approved 7A card text is unchanged and still visible.
      expect(screen.getByText(cardText)).toBeVisible();
      expect(screen.getByText(cardText).closest("li")).toContainElement(panel);
      expect(invoke).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      fireEvent.click(action);
      expect(action).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("region", { name: en.history.explanation.title })).not.toBeInTheDocument();
      expect(screen.getByText(cardText)).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * Packet 11C B4a (B3 carry, before any activation): a locale switch CLOSES an open explanation and never explains again by itself; the
   * pending request is aborted and its late answer discarded. A new explicit action in the new locale is required.
   */
  it.each([
    ["en-SG", "zh-SG"],
    ["zh-SG", "en-SG"],
  ] as const)("a switch from %s to %s closes the open panel, aborts the pending request and explains nothing; the late answer is discarded", async (from, to) => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    const { rerender } = render(screenElement(from, history, held.explainer));
    await openAction(from);
    expect(held.calls.map((call) => call.input.locale)).toEqual([from]);
    rerender(screenElement(to, history, held.explainer));
    await act(async () => undefined);
    // No new request, the old one aborted, and the panel closed.
    expect(held.calls.map((call) => call.input.locale)).toEqual([from]);
    expect(held.calls[0]!.signal?.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: getMessages(from).history.explanation.title })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: getMessages(to).history.explanation.title })).not.toBeInTheDocument();
    const action = screen.getByRole("button", { name: getMessages(to).history.explanation.action });
    expect(action).toHaveAttribute("aria-expanded", "false");

    // The old answer arrives late: nothing is shown and nothing reopens.
    await act(async () => held.calls[0]!.resolve());
    expect(document.body.textContent).not.toContain(headlineOf(results[from]));
    expect(document.querySelector(".history-explanation")).toBeNull();
    expect(held.calls).toHaveLength(1);

    // Only a new explicit action explains, in the new locale.
    await openAction(to);
    expect(held.calls.map((call) => call.input.locale)).toEqual([from, to]);
    await act(async () => held.calls[1]!.resolve());
    expect(within(screen.getByRole("region", { name: getMessages(to).history.explanation.title })).getByRole("status")).toHaveTextContent(headlineOf(results[to]));
    expect(document.body.textContent).not.toContain(headlineOf(results[from]));
  });

  it("an answered panel also closes on a locale switch, and switching back does not reopen it", async () => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    const { rerender } = render(screenElement("en-SG", history, held.explainer));
    await openAction("en-SG");
    await act(async () => held.calls[0]!.resolve());
    expect(within(screen.getByRole("region", { name: en.history.explanation.title })).getByRole("status")).toHaveTextContent(headlineOf(results["en-SG"]));
    rerender(screenElement("zh-SG", history, held.explainer));
    await act(async () => undefined);
    expect(document.querySelector(".history-explanation")).toBeNull();
    rerender(screenElement("en-SG", history, held.explainer));
    await act(async () => undefined);
    expect(document.querySelector(".history-explanation")).toBeNull();
    expect(held.calls).toHaveLength(1);
    expect(screen.getByRole("button", { name: en.history.explanation.action })).toHaveAttribute("aria-expanded", "false");
  });

  it("discards a late result that arrives right after the locale commit, before that commit's passive effects run; the panel stays closed", async () => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    const selection = selectionRepository().repository;
    let switchLocale!: (locale: AiLocale) => void;
    const switched = new Promise<AiLocale>((resolve) => (switchLocale = resolve));
    function Harness() {
      const [locale, setLocale] = useState<AiLocale>("en-SG");
      useEffect(() => {
        void switched.then(setLocale);
      }, []);
      return <RecordedHistoryScreen messages={getMessages(locale)} locale={locale} history={history} selection={selection} explainer={held.explainer} />;
    }
    render(<Harness />);
    await openAction("en-SG");
    expect(held.calls).toHaveLength(1);

    const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
    let observer: MutationObserver | undefined;
    let resolvedAfterCommit = false;
    let englishShown = false;
    try {
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = false;
      observer = new MutationObserver(() => {
        if (document.body.textContent?.includes(headlineOf(results["en-SG"]))) englishShown = true;
        if (resolvedAfterCommit || !screen.queryByRole("heading", { level: 1, name: zh.history.title })) return;
        // The zh-SG commit is on screen; answer the old en-SG request in this microtask, before any later task.
        resolvedAfterCommit = true;
        held.calls[0]!.resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      switchLocale("zh-SG");
      await waitFor(() => expect(resolvedAfterCommit).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(englishShown).toBe(false);
      // Packet 11C B4a: the locale commit closed the panel and asked for nothing.
      expect(held.calls).toHaveLength(1);
      expect(held.calls[0]!.signal?.aborted).toBe(true);
      expect(document.querySelector(".history-explanation")).toBeNull();
    } finally {
      observer?.disconnect();
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
    await openAction("zh-SG");
    expect(held.calls.map((call) => call.input.locale)).toEqual(["en-SG", "zh-SG"]);
    await act(async () => held.calls[1]!.resolve());
    expect(within(screen.getByRole("region", { name: zh.history.explanation.title })).getByRole("status")).toHaveTextContent(headlineOf(results["zh-SG"]));
    expect(englishShown).toBe(false);
  });

  it("discards a late result after a period change and closes the panel", async () => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    render(screenElement("en-SG", history, held.explainer));
    await openAction();
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodLastWeek }));
    await act(async () => undefined);
    expect(held.calls[0]!.signal?.aborted).toBe(true);
    // The new period's view is loaded first; the old answer then arrives late.
    await waitFor(() => expect(screen.getByRole("radio", { name: en.history.periodLastWeek })).toBeChecked());
    await waitFor(() => expect(screen.queryByText(en.history.loading)).not.toBeInTheDocument());
    await act(async () => held.calls[0]!.resolve());
    expect(document.body.textContent).not.toContain(headlineOf(results["en-SG"]));
    expect(screen.queryByRole("region", { name: en.history.explanation.title })).not.toBeInTheDocument();
    // The comparison is still explainable in the new period's view: its action is offered again, closed, and nothing was re-requested.
    const action = await screen.findByRole("button", { name: en.history.explanation.action });
    expect(screen.getAllByRole("button", { name: en.history.explanation.action })).toHaveLength(1);
    expect(action).toHaveAttribute("aria-expanded", "false");
    expect(action).not.toHaveAttribute("aria-controls");
    expect(held.calls).toHaveLength(1);
  });

  it("aborts and discards a pending explanation when the screen unmounts", async () => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    const consoleError = vi.spyOn(console, "error");
    try {
      const { unmount } = render(screenElement("en-SG", history, held.explainer));
      await openAction();
      unmount();
      expect(held.calls[0]!.signal?.aborted).toBe(true);
      await act(async () => held.calls[0]!.resolve());
      expect(document.body.textContent).not.toContain(headlineOf(results["en-SG"]));
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("STALE_RESULT: a correction re-evaluated while the explanation is pending shows the stale message; reopening asks again", async () => {
    const { history, journal, coordinator, recorded } = await higherFixture();
    const held = heldExecute();
    render(screenElement("en-SG", history, realExplainer(history, held.execute)));
    const action = await openAction();
    await waitFor(() => expect(held.calls).toHaveLength(1));

    const target = recorded.at(-1)!;
    const corrected = await journal.correctGlucoseTime({
      recordId: target.recordId,
      expectedRevisionId: target.revisionId,
      expectedRevisionNumber: 1,
      payload: {
        measurement: { enteredValue: "7.8" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      },
      temporal: local(dayBefore(TODAY, 12), "07:30"),
      recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
    });
    expect(corrected.kind).toBe("COMMITTED");
    await coordinator.processPending();

    await act(async () => held.calls[0]!.release());
    const panel = screen.getByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent(en.history.explanation.stale));
    expect(within(panel).queryByRole("list")).not.toBeInTheDocument();

    // Reopening asks again (a new request); the old stale message is not shown for it.
    fireEvent.click(action);
    fireEvent.click(action);
    await act(async () => undefined);
    await waitFor(() => expect(held.calls).toHaveLength(2));
    const reopened = screen.getByRole("region", { name: en.history.explanation.title });
    expect(within(reopened).getByRole("status")).toBeEmptyDOMElement();
    await act(async () => held.calls[1]!.release());
    await waitFor(() => expect(within(reopened).getByRole("status")).not.toBeEmptyDOMElement());
    expect(within(reopened).getByRole("status")).not.toHaveTextContent(en.history.explanation.stale);
    expect(within(reopened).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  // --- Packet 11C B2b: carried Checkpoint 2 integration minors ---

  it("STALE_RESULT reloads the 7A card (a local read only): the stale message stays and nothing is explained again until the patient reopens", async () => {
    const { history: real, journal, coordinator, recorded } = await higherFixture();
    const load = vi.fn((request: Parameters<RecordedHistoryQueryPort["load"]>[0]) => real.load(request));
    const history: RecordedHistoryQueryPort = { load, loadExplainablePattern: (request) => real.loadExplainablePattern(request) };
    const held = heldExecute();
    render(screenElement("en-SG", history, realExplainer(real, held.execute)));
    const slot = en.history.slotLabels.BEFORE_BREAKFAST;
    const before = en.history.comparisonHigher(slot, "7.35", "6", "mmol/L");
    await screen.findByText(before);
    const action = await openAction();
    await waitFor(() => expect(held.calls).toHaveLength(1));

    // A correction that moves the recent median, re-evaluated while the explanation is pending.
    const target = recorded.at(-1)!;
    const corrected = await journal.correctGlucoseTime({
      recordId: target.recordId,
      expectedRevisionId: target.revisionId,
      expectedRevisionNumber: 1,
      payload: {
        measurement: { enteredValue: "5.0" as never, enteredUnit: "MMOL_L", normalization: null },
        measurementMethod: "FINGERSTICK_METER",
        context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEFORE_BREAKFAST" },
      },
      temporal: local(dayBefore(TODAY, 12), "07:30"),
      recordedAt: "2026-10-04T01:00:00.000Z" as Instant,
    });
    expect(corrected.kind).toBe("COMMITTED");
    await coordinator.processPending();
    const loads = load.mock.calls.length;

    await act(async () => held.calls[0]!.release());
    const panel = screen.getByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent(en.history.explanation.stale));
    await waitFor(() => expect(load.mock.calls.length).toBe(loads + 1));
    expect(load.mock.calls.at(-1)![0]).toEqual({ period: "THIS_WEEK" });
    // The card now states the re-evaluated comparison; the open panel keeps its stale message.
    await waitFor(() => expect(screen.queryByText(before)).not.toBeInTheDocument());
    expect(screen.getByText(en.history.comparisonHigher(slot, "7.25", "6", "mmol/L"))).toBeVisible();
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent(en.history.explanation.stale);
    expect(action).toHaveAttribute("aria-expanded", "true");
    // Reloading the card never asks for another explanation, and it happens once per stale answer.
    await act(async () => undefined);
    expect(held.calls).toHaveLength(1);
    expect(load.mock.calls.length).toBe(loads + 1);
  });

  it("STALE_RESULT whose comparison is gone after the reload: the panel closes, the stale message moves to the screen status, focus moves to the period control", async () => {
    const first = readyView() as Extract<RecordedHistoryView, { status: "READY" }>;
    // The reloaded view no longer holds the before-breakfast comparison.
    const second = readyView({ comparisons: first.comparisons.slice(1) });
    let loads = 0;
    const history: RecordedHistoryQueryPort = {
      load: vi.fn(async () => (++loads === 1 ? first : second)),
      loadExplainablePattern: vi.fn(async () => ({ kind: "EXPLAINABLE" as const, view: {} as never })),
    };
    const explain = vi.fn(async () => ({ kind: "UNAVAILABLE" as const, reason: "STALE_RESULT" }));
    render(screenElement("en-SG", history, { explain }));
    await openAction();
    await waitFor(() => expect(history.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("region", { name: en.history.explanation.title })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: en.history.explanation.action })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: en.history.periodThisWeek })).toHaveFocus();
    expect(document.querySelector(".history-status")).toHaveTextContent(en.history.explanation.stale);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it("a period change that closes the panel holding focus moves focus to the period control; focus already there stays", async () => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    render(screenElement("en-SG", history, held.explainer));
    await openAction();
    const panel = screen.getByRole("region", { name: en.history.explanation.title });
    expect(within(panel).getByRole("heading", { level: 3 })).toHaveFocus();
    // A pointer or assistive-technology activation changes the period without moving focus off the panel heading first.
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodLastWeek }));
    await act(async () => undefined);
    expect(screen.queryByRole("region", { name: en.history.explanation.title })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: en.history.periodLastWeek })).toHaveFocus();
    await waitFor(() => expect(screen.queryByText(en.history.loading)).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: en.history.periodLastWeek })).toHaveFocus();

    // Keyboard: focus is on the period control when the period changes; it stays there.
    await openAction();
    const thisWeek = screen.getByRole("radio", { name: en.history.periodThisWeek });
    thisWeek.focus();
    fireEvent.click(thisWeek);
    await act(async () => undefined);
    await waitFor(() => expect(screen.queryByText(en.history.loading)).not.toBeInTheDocument());
    expect(thisWeek).toHaveFocus();
  });
});

/**
 * Packet 11C Addendum B, Task B3: the shared disclosure in the history flow. It is decided on the patient's action, BEFORE the explainer
 * (so before the hybrid service and its timers) and only when EXPLAIN_PATTERN is SYNTHETIC_REMOTE_ENABLED and this app session has not
 * accepted it. Accepted: the explanation runs with the session answering ACCEPTED. Cancelled (or Escape): the explanation still runs,
 * deterministically, with nothing sent. Activated behaviour uses an injected test manifest and a fake route only.
 */
describe("Recorded history: AI disclosure before the explanation (Packet 11C B3)", () => {
  const ENABLED: AiActivationManifest = { ...AI_ACTIVATION_MANIFEST, tasks: { ...AI_ACTIVATION_MANIFEST.tasks, EXPLAIN_PATTERN: "SYNTHETIC_REMOTE_ENABLED" } };
  function fakeRoute() {
    return vi.fn<BrowserShellFetcher>(async (_url, init) => {
      const plan = shellPlanView(shellTaskRequestSchema.parse(JSON.parse(init.body as string)));
      const home = (path: ShellFieldPath) => plan.slots.find((slot) => slot.homeField === path)!.slotId;
      const candidate = shellCandidate(plan, new Map<ShellFieldPath, string>([["headline", `A look at ${slotToken(home("headline"))}.`], ["evidence", `This is based on ${slotToken(home("evidence"))}.`]]));
      return new Response(JSON.stringify({ kind: "CANDIDATE", candidate, retention: "CONFIRMED_NOT_STORED", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 } }), { headers: { "content-type": "application/json" } });
    });
  }
  async function wired(manifest: AiActivationManifest = ENABLED, online: () => boolean = () => true, route: BrowserShellFetcher = fakeRoute()) {
    const { history } = await higherFixture();
    const rows: AiInvocationAuditRow[] = [];
    const fetcher = vi.fn(route);
    // Packet 11C Addendum C (C1): test-only QUALIFIED records (the shipped records are all PENDING). C3: no session; every request
    // carries its own decision.
    const real = createBrowserHistoryExplainer({ history, audit: { append: async (row) => void rows.push(row) }, manifest, fetcher, online, requestClassGate: qualifiedTestRequestClassGate() });
    const explain = vi.fn(real.explain);
    const disclosureRequired = vi.fn(real.disclosureRequired);
    const explainer = { ...real, explain, disclosureRequired };
    return { history, rows, fetcher, explainer, explain, disclosureRequired };
  }
  const dialogOf = (locale: AiLocale = "en-SG") => screen.getByRole("dialog", { name: getMessages(locale).ai.remoteTitle });
  /** Owner UI decision U03: while the passcode field is shown, the primary action needs it filled (a test-only value), then accepts. */
  const acceptIn = (dialog: HTMLElement, locale: AiLocale = "en-SG") => {
    const m = getMessages(locale);
    const field = within(dialog).queryByLabelText(m.aiAccess.passcodeLabel);
    if (field && (field as HTMLInputElement).value.trim() === "") fireEvent.change(field, { target: { value: "TEST-ONLY-passcode-value" } });
    fireEvent.click(within(dialog).getByRole("button", { name: m.ai.pattern.confirm }));
  };
  const panelStatus = (locale: AiLocale = "en-SG") => within(screen.getByRole("region", { name: getMessages(locale).history.explanation.title })).getByRole("status");
  /**
   * Packet 11C Addendum C (C3): the action, then its per-request disclosure check (one local read), until the dialog or the panel shows.
   */
  async function askAction(locale: AiLocale = "en-SG") {
    const action = await screen.findByRole("button", { name: getMessages(locale).history.explanation.action });
    fireEvent.click(action);
    await waitFor(() => expect(screen.queryByRole("dialog") ?? screen.queryByRole("region", { name: getMessages(locale).history.explanation.title })).not.toBeNull());
    return action;
  }

  it("activated: the action opens the disclosure first, asked for THIS request; nothing is explained, audited or sent", async () => {
    const run = await wired();
    render(screenElement("en-SG", run.history, run.explainer));
    const action = await askAction();
    // Packet 11C Addendum C (C3): the per-request check is asked with this comparison and locale (one local read, no row, no send).
    expect(run.disclosureRequired).toHaveBeenCalledTimes(1);
    expect(run.disclosureRequired).toHaveBeenCalledWith({ factId: FACT, locale: "en-SG" });
    const dialog = dialogOf();
    expect(dialog).toHaveAccessibleDescription(`${en.ai.remoteBody} ${en.ai.remoteLimit}`);
    expect(within(dialog).getByRole("button", { name: en.ai.cancel })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: en.ai.pattern.confirm })).toBeInTheDocument();
    expect(action).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: en.history.explanation.title })).not.toBeInTheDocument();
    expect(run.explain).not.toHaveBeenCalled();
    expect(run.rows).toHaveLength(0);
    expect(run.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["Cancel", () => fireEvent.click(within(dialogOf()).getByRole("button", { name: en.ai.cancel }))],
    ["Escape", () => fireEvent.keyDown(dialogOf(), { key: "Escape" })],
  ])("%s: the deterministic explanation opens with nothing sent and an audit row that records no attempt; the next action asks again", async (_label, cancel) => {
    const run = await wired();
    render(screenElement("en-SG", run.history, run.explainer));
    const action = await askAction();
    act(() => cancel());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(action).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: en.history.explanation.title });
    expect(within(panel).getByRole("heading", { level: 3 })).toHaveFocus();
    await waitFor(() => expect(panelStatus()).not.toBeEmptyDOMElement());
    expect(panelStatus()).not.toHaveTextContent(en.history.explanation.unavailable);
    expect(within(panel).queryByText(en.history.explanation.aiLabel)).not.toBeInTheDocument();
    expect(within(panel).queryByText(en.ai.demoTag)).not.toBeInTheDocument();
    expect(within(panel).queryByText(en.ai.resultCheck)).not.toBeInTheDocument();
    // Packet 11C B4a: the short non-technical line says AI wording was not used (human acceptance pending).
    expect(within(panel).getByText(en.ai.remoteNotAccepted)).toBeInTheDocument();
    expect(run.explain).toHaveBeenCalledTimes(1);
    expect(run.explain.mock.calls[0]![0]).toEqual({ factId: FACT, locale: "en-SG", disclosure: "DECLINED" });
    expect(run.fetcher).not.toHaveBeenCalled();
    expect(run.rows).toHaveLength(1);
    // Packet 11C Addendum C (C5): an explicit decline is audited with the truthful REMOTE_USE_DECLINED (REQUEST_CANCELLED under the B4a
    // interim ruling); nothing was sent.
    expect(run.rows[0]).toMatchObject({ outcomeCode: "REMOTE_USE_DECLINED", providerModel: null, attempts: { count: 0, structuralRepairUsed: false, timedOut: false }, sourceRevisions: [], usageBasis: "NONE" });

    // Not accepted, so the next explicit action asks again.
    fireEvent.click(action);
    await askAction();
    expect(dialogOf()).toBeInTheDocument();
    expect(run.explain).toHaveBeenCalledTimes(1);
  });

  it("C3: accepted: the AI explanation from one POST with that request's own acceptance; the next request asks again (two requests, two dialogs)", async () => {
    const run = await wired();
    render(screenElement("en-SG", run.history, run.explainer));
    const action = await askAction();
    act(() => acceptIn(dialogOf()));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const panel = screen.getByRole("region", { name: en.history.explanation.title });
    expect(within(panel).getByRole("heading", { level: 3 })).toHaveFocus();
    await waitFor(() => expect(within(panel).getByText(en.history.explanation.aiLabel)).toBeInTheDocument());
    // Packet 11C Addendum C, C4: the accepted AI explanation carries the approved tag and check line, its text inside the tag's region.
    const aiRegion = within(panel).getByRole("group", { name: en.ai.demoTag });
    expect(within(aiRegion).getByText(en.ai.resultCheck)).toBeInTheDocument();
    expect(run.fetcher).toHaveBeenCalledTimes(1);
    expect(run.explain.mock.calls[0]![0]).toEqual({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" });
    expect(run.explain.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(run.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", providerModel: { providerKey: "deepseek", modelSnapshot: "deepseek-flash" }, attempts: { count: 1 } });

    // Close and ask again: a new explicit request, so the dialog is shown again and nothing is sent until it is answered.
    fireEvent.click(action);
    await askAction();
    expect(dialogOf()).toBeInTheDocument();
    expect(run.explain).toHaveBeenCalledTimes(1);
    expect(run.fetcher).toHaveBeenCalledTimes(1);
    act(() => acceptIn(dialogOf()));
    await waitFor(() => expect(run.fetcher).toHaveBeenCalledTimes(2));
    expect(run.explain).toHaveBeenCalledTimes(2);
    // Each request has its own signal (its own decision token).
    expect(run.explain.mock.calls[1]![1]).not.toBe(run.explain.mock.calls[0]![1]);
    expect(run.disclosureRequired).toHaveBeenCalledTimes(2);
  });

  it("C6: the disclosure asks for the demo passcode while none is held; it travels as a header only; the next dialog does not ask again", async () => {
    const run = await wired();
    render(screenElement("en-SG", run.history, run.explainer));
    const action = await askAction();
    const field = within(dialogOf()).getByLabelText(en.aiAccess.passcodeLabel);
    fireEvent.change(field, { target: { value: "TEST-ONLY-passcode-value" } });
    act(() => acceptIn(dialogOf()));
    await waitFor(() => expect(run.fetcher).toHaveBeenCalledTimes(1));
    const init = run.fetcher.mock.calls[0]![1];
    expect((init.headers as Record<string, string>)["x-jagaon-demo-passcode"]).toBe("TEST-ONLY-passcode-value");
    expect(String(init.body)).not.toContain("TEST-ONLY-passcode-value");
    expect(JSON.stringify(run.rows)).not.toContain("TEST-ONLY-passcode-value");
    // Held for this app session (in memory): the next request's dialog shows the approved actions only.
    fireEvent.click(action);
    await askAction();
    expect(within(dialogOf()).queryByLabelText(en.aiAccess.passcodeLabel)).toBeNull();
    expect(within(dialogOf()).getAllByRole("button").map((button) => button.textContent)).toEqual([en.ai.pattern.confirm, en.ai.cancel]);
  });

  it("C6: NOT_ACTIVATED (shipped manifest): no disclosure, so no passcode field ever appears", async () => {
    const run = await wired(AI_ACTIVATION_MANIFEST);
    render(screenElement("en-SG", run.history, run.explainer));
    await askAction();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText(en.aiAccess.passcodeLabel)).toBeNull();
  });

  it("C3: a repairable structural rejection under one acceptance: one dialog, repaired once (two POSTs), one audit row", async () => {
    const answer = fakeRoute();
    let posts = 0;
    const route: BrowserShellFetcher = async (url, init) => {
      posts += 1;
      if (posts === 1) return new Response(JSON.stringify({ kind: "STRUCTURALLY_REJECTED", reason: "SCHEMA_INVALID", repairable: true, retention: "CONFIRMED_NOT_STORED", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 } }), { headers: { "content-type": "application/json" } });
      return answer(url, init);
    };
    const run = await wired(ENABLED, () => true, route);
    render(screenElement("en-SG", run.history, run.explainer));
    await askAction();
    act(() => acceptIn(dialogOf()));
    const panel = screen.getByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByText(en.history.explanation.aiLabel)).toBeInTheDocument());
    expect(run.fetcher).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(run.disclosureRequired).toHaveBeenCalledTimes(1);
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ outcomeCode: "ACCEPTED", attempts: { count: 2, structuralRepairUsed: true } });
  });

  it("C3: a check still in flight is superseded by a locale switch or a newer action: no dialog or panel appears by itself", async () => {
    const run = await wired();
    let answer!: (value: boolean) => void;
    const disclosureRequired = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const explainer = { ...run.explainer, disclosureRequired };
    const { rerender } = render(screenElement("en-SG", run.history, explainer));
    fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
    await waitFor(() => expect(disclosureRequired).toHaveBeenCalledTimes(1));
    rerender(screenElement("zh-SG", run.history, explainer));
    await act(async () => answer(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: zh.history.explanation.title })).not.toBeInTheDocument();
    // A newer action supersedes the older one's check (only the latest answer counts).
    fireEvent.click(await screen.findByRole("button", { name: zh.history.explanation.action }));
    await waitFor(() => expect(disclosureRequired).toHaveBeenCalledTimes(2));
    const first = answer;
    fireEvent.click(screen.getByRole("button", { name: zh.history.explanation.action }));
    await waitFor(() => expect(disclosureRequired).toHaveBeenCalledTimes(3));
    await act(async () => first(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => answer(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: zh.history.explanation.title })).toBeInTheDocument();
    // C3 fix round 1: each of the three clicks is one explicit request with exactly one row. The two superseded checks answered "a
    // disclosure is needed", so each closed without the patient's decision (DISCLOSURE_CLOSED_MOOT, in its own locale); the third opened
    // without a decision of its own (REMOTE_USE_NOT_ACCEPTED). Nothing was sent.
    await waitFor(() => expect(run.rows).toHaveLength(3));
    expect(run.rows.map((row) => `${row.locale}:${row.outcomeCode}:${row.attempts.count}`).sort()).toEqual(["en-SG:DISCLOSURE_CLOSED_MOOT:0", "zh-SG:DISCLOSURE_CLOSED_MOOT:0", "zh-SG:REMOTE_USE_NOT_ACCEPTED:0"]);
    expect(run.explain.mock.calls.filter((call) => call[1]?.aborted !== true).map((call) => call[0])).toEqual([{ factId: FACT, locale: "zh-SG" }]);
    expect(run.fetcher).not.toHaveBeenCalled();
  });

  it("C3 fix round 1: a superseded check whose answer is 'not needed' is one REQUEST_CANCELLED row (period change, screen closed); nothing sent", async () => {
    const run = await wired();
    let answer!: (value: boolean) => void;
    const disclosureRequired = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const explainer = { ...run.explainer, disclosureRequired };
    const { unmount } = render(screenElement("en-SG", run.history, explainer));
    fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
    await waitFor(() => expect(disclosureRequired).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodLastWeek }));
    await act(async () => answer(false));
    await waitFor(() => expect(run.rows).toHaveLength(1));
    expect(run.rows[0]).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcomeCode: "REQUEST_CANCELLED", providerModel: null, attempts: { count: 0 }, usageBasis: "NONE" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: en.history.explanation.title })).not.toBeInTheDocument();

    // Back to this week, ask again, then close the screen while the check is in flight.
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodThisWeek }));
    fireEvent.click(await screen.findByRole("button", { name: en.history.explanation.action }));
    await waitFor(() => expect(disclosureRequired).toHaveBeenCalledTimes(2));
    unmount();
    await act(async () => answer(false));
    await waitFor(() => expect(run.rows).toHaveLength(2));
    expect(run.rows.map((row) => row.outcomeCode)).toEqual(["REQUEST_CANCELLED", "REQUEST_CANCELLED"]);
    await act(async () => undefined);
    expect(run.rows).toHaveLength(2);
    expect(run.fetcher).not.toHaveBeenCalled();
  });

  it("C3 fix round 1: a click on another comparison ends the open request at once (aborted before the new check settles); it never sends", async () => {
    const two = await twoComparisonFixture();
    const rows: AiInvocationAuditRow[] = [];
    const fetcher = vi.fn(fakeRoute());
    // The explainer's own reads of comparison A can be held, so A's accepted request is still before its send when B is clicked.
    let holdA: Promise<void> | null = null;
    let releaseA!: () => void;
    const explainerHistory: RecordedHistoryQueryPort = {
      load: (request) => two.history.load(request),
      loadExplainablePattern: async (request) => {
        if (holdA && request.factId === FACT) await holdA;
        return two.history.loadExplainablePattern(request);
      },
    };
    const real = createBrowserHistoryExplainer({ history: explainerHistory, audit: { append: async (row) => void rows.push(row) }, manifest: ENABLED, fetcher, requestClassGate: qualifiedTestRequestClassGate() });
    const explain = vi.fn(real.explain);
    let answerB!: (value: boolean) => void;
    const disclosureRequired = vi.fn((input: { factId: string; locale: AiLocale }) => (input.factId === FACT ? real.disclosureRequired(input) : new Promise<boolean>((resolve) => (answerB = resolve))));
    const explainer = { ...real, explain, disclosureRequired };
    render(screenElement("en-SG", two.history, explainer));
    const actions = await screen.findAllByRole("button", { name: en.history.explanation.action });
    expect(actions).toHaveLength(2);
    // A: asked, accepted; its request is held before its send.
    fireEvent.click(actions[0]!);
    const dialog = await screen.findByRole("dialog", { name: en.ai.remoteTitle });
    holdA = new Promise((resolve) => (releaseA = resolve));
    act(() => acceptIn(dialog));
    await waitFor(() => expect(explain).toHaveBeenCalledTimes(1));
    const signalA = explain.mock.calls[0]![1]!;
    expect(explain.mock.calls[0]![0]).toEqual({ factId: FACT, locale: "en-SG", disclosure: "ACCEPTED" });
    expect(signalA.aborted).toBe(false);
    // B clicked: A is aborted at once, while B's check is still in flight.
    fireEvent.click(screen.getAllByRole("button", { name: en.history.explanation.action })[1]!);
    await act(async () => undefined);
    expect(disclosureRequired).toHaveBeenCalledTimes(2);
    expect(signalA.aborted).toBe(true);
    expect(screen.queryByRole("region", { name: en.history.explanation.title })).not.toBeInTheDocument();
    // A's held read resumes: its request ends cancelled with nothing sent.
    await act(async () => releaseA());
    await waitFor(() => expect(rows.map((row) => row.outcomeCode)).toContain("REQUEST_CANCELLED"));
    expect(fetcher).not.toHaveBeenCalled();
    // B's check settles ("needed"): B shows its own dialog; A never sends.
    await act(async () => answerB(true));
    expect(await screen.findByRole("dialog", { name: en.ai.remoteTitle })).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    expect(rows.map((row) => `${row.outcomeCode}:${row.attempts.count}`)).toEqual(["REQUEST_CANCELLED:0"]);
  });

  it("NOT_ACTIVATED (shipped manifest): the disclosure never appears", async () => {
    const run = await wired(AI_ACTIVATION_MANIFEST);
    render(screenElement("en-SG", run.history, run.explainer));
    await askAction();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(panelStatus()).not.toBeEmptyDOMElement());
    expect(run.explain).toHaveBeenCalledTimes(1);
    expect(run.fetcher).not.toHaveBeenCalled();
    expect(run.rows[0]).toMatchObject({ outcomeCode: "TASK_DISABLED", attempts: { count: 0 } });
  });

  it("zh-SG: the disclosure shows the zh copy", async () => {
    const run = await wired();
    render(screenElement("zh-SG", run.history, run.explainer));
    await askAction("zh-SG");
    const dialog = dialogOf("zh-SG");
    expect(dialog).toHaveAccessibleDescription(`${zh.ai.remoteBody} ${zh.ai.remoteLimit}`);
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([zh.ai.pattern.confirm, zh.ai.cancel]);
  });

  it("a locale or period change while the disclosure is open closes it: nothing is explained or sent; it does not come back; C5: one DISCLOSURE_CLOSED_MOOT row each", async () => {
    const run = await wired();
    const { rerender } = render(screenElement("en-SG", run.history, run.explainer));
    await askAction();
    expect(dialogOf()).toBeInTheDocument();
    expect(run.rows).toHaveLength(0);
    rerender(screenElement("zh-SG", run.history, run.explainer));
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(screenElement("en-SG", run.history, run.explainer));
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Packet 11C Addendum C (C5): the moot request is still one explicit request, so it has one zero-attempt row, in the locale it was
    // asked in (before C5 it had none).
    await waitFor(() => expect(run.rows).toHaveLength(1));
    expect(run.rows[0]).toMatchObject({ taskType: "EXPLAIN_PATTERN", locale: "en-SG", outcomeCode: "DISCLOSURE_CLOSED_MOOT", providerModel: null, attempts: { count: 0 }, usageBasis: "NONE" });

    await askAction();
    expect(dialogOf()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodLastWeek }));
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(en.history.loading)).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(run.explain).not.toHaveBeenCalled();
    await waitFor(() => expect(run.rows).toHaveLength(2));
    expect(run.rows.map((row) => row.outcomeCode)).toEqual(["DISCLOSURE_CLOSED_MOOT", "DISCLOSURE_CLOSED_MOOT"]);
    expect(run.fetcher).not.toHaveBeenCalled();
  });

  it("C5: closing the screen while the disclosure is open writes one DISCLOSURE_CLOSED_MOOT row; a decided disclosure writes none on close", async () => {
    const run = await wired();
    const { unmount } = render(screenElement("en-SG", run.history, run.explainer));
    await askAction();
    expect(dialogOf()).toBeInTheDocument();
    unmount();
    await waitFor(() => expect(run.rows).toHaveLength(1));
    expect(run.rows[0]).toMatchObject({ outcomeCode: "DISCLOSURE_CLOSED_MOOT", locale: "en-SG", attempts: { count: 0 } });

    const decided = await wired();
    const second = render(screenElement("en-SG", decided.history, decided.explainer));
    await askAction();
    act(() => fireEvent.click(within(dialogOf()).getByRole("button", { name: en.ai.cancel })));
    await waitFor(() => expect(decided.rows).toHaveLength(1));
    second.unmount();
    await act(async () => undefined);
    expect(decided.rows.map((row) => row.outcomeCode)).toEqual(["REMOTE_USE_DECLINED"]);
    expect(run.fetcher).not.toHaveBeenCalled();
  });

  it("C5 under StrictMode (development double effects): one explicit request still writes exactly one row", async () => {
    const run = await wired();
    render(<StrictMode>{screenElement("en-SG", run.history, run.explainer)}</StrictMode>);
    await askAction();
    act(() => fireEvent.click(within(dialogOf()).getByRole("button", { name: en.ai.cancel })));
    await waitFor(() => expect(panelStatus()).not.toBeEmptyDOMElement());
    await act(async () => undefined);
    expect(run.rows.map((row) => row.outcomeCode)).toEqual(["REMOTE_USE_DECLINED"]);
    expect(run.explain).toHaveBeenCalledTimes(1);

    // The dialog itself is not reported moot by the StrictMode remount of its effect.
    cleanup();
    const second = await wired();
    const view = render(<StrictMode>{screenElement("en-SG", second.history, second.explainer)}</StrictMode>);
    await askAction();
    await act(async () => undefined);
    expect(dialogOf()).toBeInTheDocument();
    expect(second.rows).toHaveLength(0);
    view.unmount();
    await waitFor(() => expect(second.rows.map((row) => row.outcomeCode)).toEqual(["DISCLOSURE_CLOSED_MOOT"]));
  });

  it("activated + accepted request + open AI panel: a locale switch closes the panel with no POST and no audit row; only a new, newly accepted action explains again", async () => {
    const run = await wired();
    const { rerender } = render(screenElement("en-SG", run.history, run.explainer));
    await askAction();
    act(() => acceptIn(dialogOf()));
    const panel = screen.getByRole("region", { name: en.history.explanation.title });
    await waitFor(() => expect(within(panel).getByText(en.history.explanation.aiLabel)).toBeInTheDocument());
    expect(run.fetcher).toHaveBeenCalledTimes(1);
    expect(run.rows).toHaveLength(1);

    rerender(screenElement("zh-SG", run.history, run.explainer));
    await act(async () => undefined);
    await act(async () => undefined);
    expect(screen.queryByRole("region", { name: zh.history.explanation.title })).not.toBeInTheDocument();
    expect(document.querySelector(".history-explanation")).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(run.explain).toHaveBeenCalledTimes(1);
    expect(run.fetcher).toHaveBeenCalledTimes(1);
    expect(run.rows).toHaveLength(1);
    expect(screen.getByRole("button", { name: zh.history.explanation.action })).toHaveAttribute("aria-expanded", "false");

    // Packet 11C Addendum C (C3): the locale switch ended that request's decision. A new explicit action in the new locale is a new
    // request: the dialog is shown again (zh-SG) and only its own acceptance sends (one more POST).
    await askAction("zh-SG");
    expect(dialogOf("zh-SG")).toBeInTheDocument();
    expect(run.fetcher).toHaveBeenCalledTimes(1);
    act(() => acceptIn(dialogOf("zh-SG"), "zh-SG"));
    await waitFor(() => expect(run.fetcher).toHaveBeenCalledTimes(2));
    expect(run.explain.mock.calls[1]![0]).toEqual({ factId: FACT, locale: "zh-SG", disclosure: "ACCEPTED" });
  });

  it("activated but offline: the disclosure is not shown (nothing would be sent); the explanation is deterministic", async () => {
    const run = await wired(ENABLED, () => false);
    expect(await run.explainer.disclosureRequired({ factId: FACT, locale: "en-SG" })).toBe(false);
    render(screenElement("en-SG", run.history, run.explainer));
    await askAction();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(panelStatus()).not.toBeEmptyDOMElement());
    expect(run.fetcher).not.toHaveBeenCalled();
    expect(run.rows[0]).toMatchObject({ outcomeCode: "TRANSPORT_FAILED", attempts: { count: 0 } });
    expect(screen.queryByText(en.ai.remoteNotAccepted)).not.toBeInTheDocument();
  });

  it("an explainer without the per-request disclosure check never shows the dialog (and its request carries no acceptance)", async () => {
    const run = await wired();
    render(screenElement("en-SG", run.history, { explain: run.explain }));
    await openAction();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(run.explain).toHaveBeenCalledTimes(1);
  });
});
