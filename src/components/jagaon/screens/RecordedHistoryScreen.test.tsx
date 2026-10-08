import { useEffect, useState } from "react";
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
import { databases, dayBefore, FACT, higherFixture, local, NOW, TODAY } from "@/application/history/history-test-support";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { createAiHybridTaskService, type AiHybridExecutionResult } from "@/application/ai/ai-hybrid-task-service";
import { createPatternExplainer } from "@/application/ai/explain-pattern";
import type { PatternExplainerPort, PatternExplanationResult } from "../history/PatternExplanationPanel";
import { RecordedHistoryScreen } from "./RecordedHistoryScreen";

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
  return createPatternExplainer({ history, execute, now: () => NOW as Instant, requestId: requestIds() });
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

  it("discards a late en-SG result after a switch to zh-SG (the old answer arrives first)", async () => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    const { rerender } = render(screenElement("en-SG", history, held.explainer));
    await openAction("en-SG");
    expect(held.calls.map((call) => call.input.locale)).toEqual(["en-SG"]);
    rerender(screenElement("zh-SG", history, held.explainer));
    await act(async () => undefined);
    expect(held.calls.map((call) => call.input.locale)).toEqual(["en-SG", "zh-SG"]);
    expect(held.calls[0]!.signal?.aborted).toBe(true);

    await act(async () => held.calls[0]!.resolve());
    const panel = screen.getByRole("region", { name: zh.history.explanation.title });
    expect(within(panel).getByRole("status")).toBeEmptyDOMElement();
    expect(document.body.textContent).not.toContain(headlineOf(results["en-SG"]));

    await act(async () => held.calls[1]!.resolve());
    expect(within(panel).getByRole("status")).toHaveTextContent(headlineOf(results["zh-SG"]));
    expect(document.body.textContent).not.toContain(headlineOf(results["en-SG"]));
  });

  it("discards a late zh-SG result after a switch to en-SG (the old answer arrives last)", async () => {
    const { history } = await higherFixture();
    const results = await realResults(history);
    const held = heldPort(results);
    const { rerender } = render(screenElement("zh-SG", history, held.explainer));
    await openAction("zh-SG");
    rerender(screenElement("en-SG", history, held.explainer));
    await act(async () => undefined);
    expect(held.calls.map((call) => call.input.locale)).toEqual(["zh-SG", "en-SG"]);
    expect(held.calls[0]!.signal?.aborted).toBe(true);

    await act(async () => held.calls[1]!.resolve());
    const status = within(screen.getByRole("region", { name: en.history.explanation.title })).getByRole("status");
    expect(status).toHaveTextContent(headlineOf(results["en-SG"]));
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(status, { childList: true, subtree: true, characterData: true });
    try {
      await act(async () => held.calls[0]!.resolve());
      expect(mutations).toHaveLength(0);
      expect(status).toHaveTextContent(headlineOf(results["en-SG"]));
      expect(document.body.textContent).not.toContain(headlineOf(results["zh-SG"]));
    } finally {
      observer.disconnect();
    }
  });

  it("discards a late result that arrives right after the locale commit, before that commit's passive effects run", async () => {
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
      await waitFor(() => expect(held.calls).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resolvedAfterCommit).toBe(true);
      expect(englishShown).toBe(false);
      expect(within(screen.getByRole("region", { name: zh.history.explanation.title })).getByRole("status")).toBeEmptyDOMElement();
    } finally {
      observer?.disconnect();
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
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
