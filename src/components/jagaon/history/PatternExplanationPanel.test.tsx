import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared/time";
import type { AiLocale } from "@/domain/ai";
import { getMessages } from "@/i18n/get-messages";
import { careSummaryLocalePack } from "@/application/care-preparation/care-summary-locale-pack";
import type { ExplainablePatternView, PeriodBoundary, RecordedHistoryQueryPort } from "@/application/history/recorded-history-contracts";
import {
  BOUNDARY_DATE,
  BOUNDARY_DAY_READINGS,
  boundaryDayFixture,
  databases,
  FACT,
  FOREIGN_OFFSET_READINGS,
  foreignOffsetFixture,
  higherFixture,
  largePeriodFixture,
  NOW,
  variabilityFixture,
} from "@/application/history/history-test-support";
import { AI_ACTIVATION_MANIFEST } from "@/application/ai/ai-activation-manifest";
import { createAiHybridTaskService } from "@/application/ai/ai-hybrid-task-service";
import { createPatternExplainer } from "@/application/ai/explain-pattern";
import { renderSummaryRoleNotice } from "@/application/ai/language/atom-renderer";
import { PatternExplanationPanel, supportingReadingsCopy, type PatternExplainerPort, type PatternExplanationResult } from "./PatternExplanationPanel";

/**
 * Packet 11C Task 7: the explanation panel. Every explanation comes from the real journal -> coordinator -> evaluator ->
 * Recorded-history query -> createPatternExplainer -> the real hybrid service under the SHIPPED manifest (EXPLAIN_PATTERN
 * NOT_ACTIVATED), so the panel shows the deterministic composition and no provider is reached.
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
  cleanup();
  vi.unstubAllGlobals();
  for (const database of databases) database.close();
  for (const database of databases.splice(0)) await Dexie.delete(database.name);
});

const counter = () => {
  let n = 0;
  return () => `7a2c3d4e-5f60-4a1b-8c2d-${(n++).toString(16).padStart(12, "0")}`;
};

/** The real explainer over the shipped (NOT_ACTIVATED) manifest; `invoke` must never be reached. */
function realExplainer(history: RecordedHistoryQueryPort, invoke = vi.fn()): PatternExplainerPort {
  const service = createAiHybridTaskService({
    releaseProfile: "HACKATHON_DEMO",
    audit: { append: async () => undefined },
    now: () => NOW,
    monotonicMs: () => 0,
    manifest: AI_ACTIVATION_MANIFEST,
    provider: { providerModel: { providerKey: "test", modelSnapshot: "test-model" }, invoke },
  });
  // Assignability pin: the Task 6 use case is the port the screen and panel consume.
  return createPatternExplainer({ history, execute: service.execute, now: () => NOW as Instant, requestId: counter() });
}

type Explained = Extract<PatternExplanationResult, { kind: "EXPLAINED" }>;

async function explain(history: RecordedHistoryQueryPort, locale: AiLocale): Promise<Explained> {
  const invoke = vi.fn();
  const result = await realExplainer(history, invoke).explain({ factId: FACT, locale });
  expect(invoke).not.toHaveBeenCalled();
  if (result.kind !== "EXPLAINED") throw new Error(`not explained: ${JSON.stringify(result)}`);
  expect(result.source).toBe("DETERMINISTIC");
  return result;
}

function payloadOf(explanation: Explained) {
  return explanation.composition.output.payload as { headline: { text: string }; observation: { text: string }; evidence: { text: string } };
}

function renderPanel(locale: AiLocale, explanation: PatternExplanationResult | null) {
  return render(<PatternExplanationPanel messages={getMessages(locale)} locale={locale} explanation={explanation} panelId="panel-test" />);
}

const unitText = (unit: "MMOL_L" | "MG_DL") => (unit === "MMOL_L" ? "mmol/L" : "mg/dL");
const dateTime = (locale: AiLocale, date: string, time: string) => `${careSummaryLocalePack(locale).localDateText(date)}${locale === "zh-SG" ? " " : ", "}${time}`;
const readingText = (locale: AiLocale, reading: ExplainablePatternView["periods"][number]["readings"][number]) =>
  `${dateTime(locale, reading.localDate, reading.localTime)} ${reading.enteredValue} ${unitText(reading.enteredUnit)}`;
/** Packet 11C B4: a Singapore-time point as the panel names it ("date, HH:MM Singapore time" / "date 新加坡时间HH:MM"). */
const singaporeTime = (locale: AiLocale, date: string, time: string) => getMessages(locale).history.explanation.singaporeTime(careSummaryLocalePack(locale).localDateText(date), time);

function periodLists() {
  const region = screen.getByRole("region");
  return within(region).getAllByRole("list").filter((list) => list.classList.contains("history-explanation-readings"));
}

describe("PatternExplanationPanel (Packet 11C Task 7)", () => {
  it.each([["en-SG"], ["zh-SG"]] as const)("%s: renders, in order, the explanation, the summary-role line, the limitation, then the supporting readings by period", async (locale) => {
    const { history } = await higherFixture();
    const explanation = await explain(history, locale);
    const t = getMessages(locale).history.explanation;
    renderPanel(locale, explanation);

    const region = screen.getByRole("region", { name: t.title });
    const text = region.textContent ?? "";
    const { headline, observation, evidence } = payloadOf(explanation);
    const order = [
      headline.text,
      observation.text,
      evidence.text,
      explanation.summaryRoleNotice,
      explanation.limitations[0]!.text,
      t.supportingHeading(explanation.view.totalCount),
      t.periodHeading("EARLIER", explanation.view.periods[0].count),
      t.periodHeading("RECENT", explanation.view.periods[1].count),
      t.reconciliation(explanation.view.periods[0].count, explanation.view.periods[1].count, explanation.view.totalCount),
    ];
    const positions = order.map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0), JSON.stringify({ order, text })).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // No AI label on the deterministic path.
    expect(within(region).queryByText(t.aiLabel)).not.toBeInTheDocument();
    expect(explanation.summaryRoleNotice).toBe(renderSummaryRoleNotice(locale));
    expect(within(region).getByRole("heading", { level: 4, name: t.supportingHeading(14) })).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 5, name: t.periodHeading("EARLIER", 8) })).toBeInTheDocument();
    expect(within(region).getByRole("heading", { level: 5, name: t.periodHeading("RECENT", 6) })).toBeInTheDocument();
    expect(within(region).getByText(t.reconciliation(8, 6, 14))).toBeInTheDocument();
  });

  it("pins the en-SG and zh-SG supporting-readings copy, endpoints and boundary line for the real HIGHER comparison", async () => {
    const { history } = await higherFixture();
    const en = await explain(history, "en-SG");
    const view = en.view;
    // The view's own instants: earlier [23 Aug 10:00, 20 Sep 10:00), recent [20 Sep 10:00, 4 Oct 10:00).
    expect(view.sharedBoundary).toEqual({ instant: "2026-09-20T02:00:00.000Z", localDate: "2026-09-20", localTime: "10:00" });
    renderPanel("en-SG", en);
    // Packet 11C B4 (decision 3; wording human acceptance pending): the list is the readings included in this comparison.
    expect(screen.getByText("Readings included in this comparison (14)")).toBeInTheDocument();
    expect(screen.getByText("Earlier period (8)")).toBeInTheDocument();
    expect(screen.getByText("Recent period (6)")).toBeInTheDocument();
    expect(screen.getByText("8 + 6 = 14 readings, matching the count above.")).toBeInTheDocument();
    const pack = careSummaryLocalePack("en-SG");
    const [aug23, sep20, oct4] = ["2026-08-23", "2026-09-20", "2026-10-04"].map((date) => pack.localDateText(date));
    // Packet 11C B4 (decision 2; wording human acceptance pending): every endpoint and the cutoff name Singapore time.
    expect(screen.getByText(`${aug23}, 10:00 Singapore time up to, but not including, ${sep20}, 10:00 Singapore time`)).toBeInTheDocument();
    expect(screen.getByText(`${sep20}, 10:00 Singapore time up to, but not including, ${oct4}, 10:00 Singapore time`)).toBeInTheDocument();
    expect(
      screen.getByText(
        `The two periods meet at ${sep20}, 10:00 Singapore time. A reading recorded before then is in the earlier period; a reading recorded at or after it is in the recent period.`,
      ),
    ).toBeInTheDocument();
    cleanup();

    const zh = await explain(history, "zh-SG");
    renderPanel("zh-SG", zh);
    const zpack = careSummaryLocalePack("zh-SG");
    const [zAug23, zSep20, zOct4] = ["2026-08-23", "2026-09-20", "2026-10-04"].map((date) => zpack.localDateText(date));
    expect(screen.getByText("此比较包含的读数（14 条）")).toBeInTheDocument();
    expect(screen.getByText("较早期间（8 条）")).toBeInTheDocument();
    expect(screen.getByText("近期（6 条）")).toBeInTheDocument();
    expect(screen.getByText("8 + 6 = 14 条读数，与上方数量一致。")).toBeInTheDocument();
    expect(screen.getByText(`${zAug23} 新加坡时间10:00至${zSep20} 新加坡时间10:00之前`)).toBeInTheDocument();
    expect(screen.getByText(`${zSep20} 新加坡时间10:00起至${zOct4} 新加坡时间10:00之前`)).toBeInTheDocument();
    expect(screen.getByText(`两个期间以${zSep20} 新加坡时间10:00为分界：在此之前记录的读数属于较早期间，在此时或之后记录的读数属于近期。`)).toBeInTheDocument();
  });

  it("lists every reading of the view exactly once, grouped exactly as the view groups them, with its own date, time and entered value", async () => {
    const { history } = await higherFixture();
    const explanation = await explain(history, "en-SG");
    renderPanel("en-SG", explanation);
    const lists = periodLists();
    expect(lists).toHaveLength(2);
    explanation.view.periods.forEach((period, index) => {
      const items = within(lists[index]!).getAllByRole("listitem").map((item) => item.textContent);
      expect(items).toEqual(period.readings.map((reading) => readingText("en-SG", reading)));
      expect(items).toHaveLength(period.count);
    });
    const all = lists.flatMap((list) => within(list).getAllByRole("listitem").map((item) => item.textContent));
    expect(all).toHaveLength(explanation.view.totalCount);
    expect(new Set(all).size).toBe(all.length);
  });

  it("never puts a summary value (median or interquartile range) in the readings list", async () => {
    const { history } = await higherFixture();
    const explanation = await explain(history, "en-SG");
    renderPanel("en-SG", explanation);
    const entered = new Set(explanation.view.periods.flatMap((period) => period.readings.map((reading) => reading.enteredValue)));
    const values = periodLists().flatMap((list) => within(list).getAllByRole("listitem").map((item) => item.querySelector(".history-explanation-value")?.textContent));
    for (const period of explanation.view.periods) {
      const summary = `${period.summary.valueMmolL} mmol/L`;
      if (!entered.has(period.summary.valueMmolL)) expect(values).not.toContain(summary);
    }
    // The recent median 7.35 is not a reading and appears nowhere in the list.
    expect(explanation.view.periods[1].summary.valueMmolL).toBe("7.35");
    for (const list of periodLists()) expect(list.textContent).not.toContain("7.35");
  });

  it.each([["en-SG", "interquartile range"], ["zh-SG", "四分位距"]] as const)("%s VARIABILITY: the observation (PERIOD_SUMMARY atom) names the %s and the summary-role line names the IQR", async (locale, iqr) => {
    const { history } = await variabilityFixture();
    const explanation = await explain(history, locale);
    expect(explanation.view.kind).toBe("VARIABILITY");
    renderPanel(locale, explanation);
    const observation = screen.getByText(payloadOf(explanation).observation.text);
    expect(observation.textContent).toContain(iqr);
    const notice = screen.getByText(explanation.summaryRoleNotice);
    expect(notice.textContent).toContain("IQR");
    // The superseded 7A wording ("recorded spread" / "记录范围") appears nowhere in the panel. Since Addendum B Task B4a the 7A VARIABILITY
    // card itself labels the same value as the interquartile range (IQR), so the card and the panel use one term.
    const region = screen.getByRole("region");
    expect(region.textContent).not.toMatch(locale === "en-SG" ? /recorded spread/ : /记录范围/);
  });

  it("MANY_READINGS: a period with more than 32 readings lists every reading and reconciles 36 + 6 = 42", async () => {
    const { history } = await largePeriodFixture();
    const explanation = await explain(history, "en-SG");
    const [earlier, recent] = explanation.view.periods;
    expect([earlier.count, recent.count, explanation.view.totalCount]).toEqual([36, 6, 42]);
    renderPanel("en-SG", explanation);
    const t = getMessages("en-SG").history.explanation;
    const [earlierList, recentList] = periodLists();
    expect(within(earlierList!).getAllByRole("listitem")).toHaveLength(36);
    expect(within(recentList!).getAllByRole("listitem")).toHaveLength(6);
    expect(within(earlierList!).getAllByRole("listitem").map((item) => item.textContent)).toEqual(earlier.readings.map((reading) => readingText("en-SG", reading)));
    expect(screen.getByText(t.periodHeading("EARLIER", 36))).toBeInTheDocument();
    expect(screen.getByText(t.supportingHeading(42))).toBeInTheDocument();
    expect(screen.getByText("36 + 6 = 42 readings, matching the count above.")).toBeInTheDocument();
  });

  it.each([["en-SG"], ["zh-SG"]] as const)("%s BOUNDARY_DAY: 9 + 7; the 07:30 reading is listed under the earlier period and the 10:30 reading under the recent period, as the view groups them", async (locale) => {
    const { history } = await boundaryDayFixture();
    const explanation = await explain(history, locale);
    const [earlier, recent] = explanation.view.periods;
    expect([earlier.count, recent.count, explanation.view.totalCount]).toEqual([9, 7, 16]);
    renderPanel(locale, explanation);
    const t = getMessages(locale).history.explanation;
    const [earlierList, recentList] = periodLists();
    const before = `${dateTime(locale, BOUNDARY_DATE, BOUNDARY_DAY_READINGS.before[0])} ${BOUNDARY_DAY_READINGS.before[1]} mmol/L`;
    const after = `${dateTime(locale, BOUNDARY_DATE, BOUNDARY_DAY_READINGS.after[0])} ${BOUNDARY_DAY_READINGS.after[1]} mmol/L`;
    const earlierItems = within(earlierList!).getAllByRole("listitem").map((item) => item.textContent);
    const recentItems = within(recentList!).getAllByRole("listitem").map((item) => item.textContent);
    expect(earlierItems).toHaveLength(9);
    expect(recentItems).toHaveLength(7);
    expect(earlierItems.at(-1)).toBe(before);
    expect(recentItems[0]).toBe(after);
    expect(recentItems).not.toContain(before);
    expect(earlierItems).not.toContain(after);
    expect(screen.getByText(t.reconciliation(9, 7, 16))).toBeInTheDocument();
    // The boundary date is shown with its cutoff time, so both claims are exact (07:30 < 10:00 <= 10:30).
    expect(screen.getByText(t.boundaryNote(singaporeTime(locale, BOUNDARY_DATE, "10:00")))).toBeInTheDocument();
  });

  it.each([["en-SG"], ["zh-SG"]] as const)("%s BOUNDARY_DAY: supportingReadingsCopy (the offline review page's source) is exactly the copy the panel renders", async (locale) => {
    const { history } = await boundaryDayFixture();
    const explanation = await explain(history, locale);
    const copy = supportingReadingsCopy(getMessages(locale), locale, explanation.view);
    renderPanel(locale, explanation);
    const region = screen.getByRole("region");
    const texts = (selector: string) => [...region.querySelectorAll(selector)].map((element) => element.textContent);
    expect(texts(".history-explanation-subtitle")).toEqual([copy.heading]);
    expect(texts(".history-explanation-period-title")).toEqual(copy.periods.map((period) => period.heading));
    expect(texts(".history-explanation-range")).toEqual(copy.periods.map((period) => period.range));
    expect(periodLists().map((list) => within(list).getAllByRole("listitem").map((item) => item.textContent))).toEqual(
      copy.periods.map((period) => period.readings.map((reading) => `${reading.when} ${reading.value}`)),
    );
    expect(texts(".history-explanation-boundary")).toEqual([copy.boundaryNote]);
    expect(texts(".history-explanation-reconciliation")).toEqual([copy.reconciliation]);
    expect(copy.periods.map((period) => period.readings.length)).toEqual([9, 7]);
    expect(copy.boundaryNote).toBe(getMessages(locale).history.explanation.boundaryNote(singaporeTime(locale, BOUNDARY_DATE, "10:00")));
  });

  it("shows the cutoff as HH:MM only when its seconds and milliseconds are zero, otherwise HH:MM:SS (floored, never rounded across the cutoff)", async () => {
    const { history } = await higherFixture();
    const explanation = await explain(history, "en-SG");
    const t = getMessages("en-SG").history.explanation;
    const withCutoff = (instant: string): Explained => {
      const view = structuredClone(explanation.view);
      const cutoff: PeriodBoundary = { instant: instant as never, localDate: "2026-09-20" as never, localTime: "10:00" };
      view.sharedBoundary = cutoff;
      view.periods[0].bounds.end = { ...cutoff };
      view.periods[1].bounds.start = { ...cutoff };
      return { ...explanation, view };
    };
    const sep20 = careSummaryLocalePack("en-SG").localDateText("2026-09-20");
    for (const [instant, shown] of [
      ["2026-09-20T02:00:00.000Z", "10:00"],
      ["2026-09-20T02:00:07.000Z", "10:00:07"],
      ["2026-09-20T02:00:59.999Z", "10:00:59"],
      ["2026-09-20T02:00:00.250Z", "10:00:00"],
    ] as const) {
      renderPanel("en-SG", withCutoff(instant));
      expect(screen.getByText(t.boundaryNote(`${sep20}, ${shown} Singapore time`))).toBeInTheDocument();
      expect(screen.getByText(t.recentRange(`${sep20}, ${shown} Singapore time`, `${careSummaryLocalePack("en-SG").localDateText("2026-10-04")}, 10:00 Singapore time`))).toBeInTheDocument();
      cleanup();
    }
  });

  it("shows the AI label only when the explanation's source is AI", async () => {
    const { history } = await higherFixture();
    const explanation = await explain(history, "en-SG");
    const t = getMessages("en-SG").history.explanation;
    const { rerender } = renderPanel("en-SG", explanation);
    expect(screen.queryByText(t.aiLabel)).not.toBeInTheDocument();
    rerender(<PatternExplanationPanel messages={getMessages("en-SG")} locale="en-SG" explanation={{ ...explanation, source: "AI" }} panelId="panel-test" />);
    const label = screen.getByText(t.aiLabel);
    const text = screen.getByRole("region").textContent ?? "";
    expect(text.indexOf(t.aiLabel)).toBeLessThan(text.indexOf(payloadOf(explanation).headline.text));
  });

  it("moves focus to the panel heading when it opens, and its status region announces the outcome once", async () => {
    const { history } = await higherFixture();
    const explanation = await explain(history, "en-SG");
    const t = getMessages("en-SG").history.explanation;
    const { rerender } = renderPanel("en-SG", null);
    const heading = screen.getByRole("heading", { level: 3, name: t.title });
    expect(heading).toHaveFocus();
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(status, { childList: true, subtree: true, characterData: true });
    try {
      rerender(<PatternExplanationPanel messages={getMessages("en-SG")} locale="en-SG" explanation={explanation} panelId="panel-test" />);
      await act(async () => undefined);
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toBe(status);
      expect(status).toHaveTextContent(payloadOf(explanation).headline.text);
      expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "false");
      const afterResult = mutations.length;
      expect(afterResult).toBeGreaterThan(0);
      // Re-rendering the same outcome does not touch the live region again, and focus stays where it was.
      rerender(<PatternExplanationPanel messages={getMessages("en-SG")} locale="en-SG" explanation={explanation} panelId="panel-test" />);
      rerender(<PatternExplanationPanel messages={getMessages("en-SG")} locale="en-SG" explanation={{ ...explanation }} panelId="panel-test" />);
      await act(async () => undefined);
      expect(mutations).toHaveLength(afterResult);
      expect(heading).toHaveFocus();
    } finally {
      observer.disconnect();
    }
  });

  it.each([["en-SG"], ["zh-SG"]] as const)("%s: STALE_RESULT shows the stale message and every other unavailable reason the unavailable message, with no readings", (locale) => {
    const t = getMessages(locale).history.explanation;
    renderPanel(locale, { kind: "UNAVAILABLE", reason: "STALE_RESULT" });
    expect(screen.getByRole("status")).toHaveTextContent(t.stale);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    cleanup();
    for (const reason of ["UNAVAILABLE", "STALE_SOURCE", "NOT_SUPPORTED", "COUNT_MISMATCH"]) {
      renderPanel(locale, { kind: "UNAVAILABLE", reason } as PatternExplanationResult);
      expect(screen.getByRole("status")).toHaveTextContent(t.unavailable);
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      cleanup();
    }
  });
});

/**
 * Packet 11C B4a (owner decisions 2 and 3, D7; every new string human acceptance pending). Real evaluator: a +05:30 reading on each side
 * of the 10:00 Singapore-time cutoff and one at the recent window's outer edge (22:00 +05:30 = 00:30 Singapore time the next day).
 */
describe("PatternExplanationPanel: foreign-offset readings and Singapore time (Packet 11C B4a)", () => {
  const foreignText = (locale: AiLocale, key: keyof typeof FOREIGN_OFFSET_READINGS) => {
    const entry = FOREIGN_OFFSET_READINGS[key];
    const t = getMessages(locale).history.explanation;
    return `${t.offsetReading(dateTime(locale, entry.date, entry.time), "UTC+05:30", singaporeTime(locale, entry.singapore.date, entry.singapore.time))} ${entry.value} mmol/L`;
  };

  it.each([["en-SG"], ["zh-SG"]] as const)(
    "%s: every +05:30 reading shows its recorded local time, its actual offset and its Singapore-time equivalent, listed where the view groups it",
    async (locale) => {
      const { history } = await foreignOffsetFixture();
      const explanation = await explain(history, locale);
      const [earlier, recent] = explanation.view.periods;
      expect([earlier.count, recent.count, explanation.view.totalCount]).toEqual([9, 8, 17]);
      renderPanel(locale, explanation);
      const t = getMessages(locale).history.explanation;
      const [earlierList, recentList] = periodLists();
      const earlierItems = within(earlierList!).getAllByRole("listitem").map((item) => item.textContent);
      const recentItems = within(recentList!).getAllByRole("listitem").map((item) => item.textContent);
      // Placement is the view's grouping: 07:45 +05:30 is listed as RECENT although its own clock time is before 10:00.
      expect(earlierItems.at(-1)).toBe(foreignText(locale, "beforeCutoff"));
      expect(recentItems[0]).toBe(foreignText(locale, "afterCutoff"));
      expect(recentItems.at(-1)).toBe(foreignText(locale, "outerEdge"));
      // Exactly the three foreign readings carry an offset label; every +08:00 reading is shown as before (date, time, value).
      const all = [...earlierItems, ...recentItems];
      expect(all.filter((text) => text?.includes("UTC+05:30"))).toHaveLength(3);
      const readings = explanation.view.periods.flatMap((period) => period.readings);
      expect(readings.filter((reading) => reading.utcOffsetMinutes !== 480)).toHaveLength(3);
      readings.forEach((reading, index) => {
        if (reading.utcOffsetMinutes === 480) expect(all[index]).toBe(readingText(locale, reading));
      });
      // Counts are the view's included readings; the heading and reconciliation agree.
      expect(screen.getByText(t.supportingHeading(17))).toBeInTheDocument();
      expect(screen.getByText(t.reconciliation(9, 8, 17))).toBeInTheDocument();
      expect(screen.getByText(t.boundaryNote(singaporeTime(locale, BOUNDARY_DATE, "10:00")))).toBeInTheDocument();
    },
  );

  it("pins the en-SG and zh-SG rendering of the outer-edge reading: 22:00 +05:30 on 3 Oct = 00:30 Singapore time on 4 Oct", async () => {
    const { history } = await foreignOffsetFixture();
    const en = await explain(history, "en-SG");
    const zh = await explain(history, "zh-SG");
    const [enOct3, enOct4] = ["2026-10-03", "2026-10-04"].map((date) => careSummaryLocalePack("en-SG").localDateText(date));
    const [zhOct3, zhOct4] = ["2026-10-03", "2026-10-04"].map((date) => careSummaryLocalePack("zh-SG").localDateText(date));
    const [enSep20, zhSep20] = [careSummaryLocalePack("en-SG").localDateText(BOUNDARY_DATE), careSummaryLocalePack("zh-SG").localDateText(BOUNDARY_DATE)];
    const enCopy = supportingReadingsCopy(getMessages("en-SG"), "en-SG", en.view);
    const zhCopy = supportingReadingsCopy(getMessages("zh-SG"), "zh-SG", zh.view);
    expect(enCopy.periods[1].readings.at(-1)).toMatchObject({ when: `${enOct3}, 22:00 (UTC+05:30; ${enOct4}, 00:30 Singapore time)`, value: "7.3 mmol/L" });
    expect(zhCopy.periods[1].readings.at(-1)).toMatchObject({ when: `${zhOct3} 22:00（UTC+05:30；${zhOct4} 新加坡时间00:30）`, value: "7.3 mmol/L" });
    expect(enCopy.periods[0].readings.at(-1)!.when).toBe(`${enSep20}, 07:15 (UTC+05:30; ${enSep20}, 09:45 Singapore time)`);
    expect(enCopy.periods[1].readings[0]!.when).toBe(`${enSep20}, 07:45 (UTC+05:30; ${enSep20}, 10:15 Singapore time)`);
    expect(zhCopy.periods[0].readings.at(-1)!.when).toBe(`${zhSep20} 07:15（UTC+05:30；${zhSep20} 新加坡时间09:45）`);
    expect(zhCopy.periods[1].readings[0]!.when).toBe(`${zhSep20} 07:45（UTC+05:30；${zhSep20} 新加坡时间10:15）`);
    expect(enCopy.heading).toBe("Readings included in this comparison (17)");
    expect(zhCopy.heading).toBe("此比较包含的读数（17 条）");
  });

  it("labels any other offset exactly (negative, zero, non-whole hours) and computes Singapore time from the instant, never from the local time", async () => {
    const { history } = await higherFixture();
    const explanation = await explain(history, "en-SG");
    const pack = careSummaryLocalePack("en-SG");
    // Re-express one +08:00 reading (07:30 Singapore time, 23:30Z the day before) at other offsets: same instant, honest local time.
    const reading = explanation.view.periods[0].readings[0]!;
    const shifted = (offset: number) => {
      const local = new Date(Date.parse(reading.instantUtc) + offset * 60_000).toISOString();
      return { ...reading, utcOffsetMinutes: offset, localDate: local.slice(0, 10) as never, localTime: local.slice(11, 16) };
    };
    const sgDate = pack.localDateText(reading.localDate);
    for (const [offset, label] of [[-300, "UTC-05:00"], [0, "UTC+00:00"], [345, "UTC+05:45"], [-570, "UTC-09:30"], [840, "UTC+14:00"]] as const) {
      const view = structuredClone(explanation.view);
      view.periods[0].readings[0] = shifted(offset);
      const copy = supportingReadingsCopy(getMessages("en-SG"), "en-SG", view);
      const local = shifted(offset);
      expect(copy.periods[0].readings[0]!.when).toBe(`${pack.localDateText(local.localDate)}, ${local.localTime} (${label}; ${sgDate}, ${reading.localTime} Singapore time)`);
    }
  });

  it.each([["en-SG"], ["zh-SG"]] as const)("%s: a declined disclosure shows the deterministic explanation with the short not-used line and no AI label", async (locale) => {
    const { history } = await higherFixture();
    const explanation = await explain(history, locale);
    const messages = getMessages(locale);
    renderPanel(locale, explanation);
    expect(screen.queryByText(messages.ai.remoteNotAccepted)).not.toBeInTheDocument();
    cleanup();

    renderPanel(locale, { ...explanation, remoteUse: "NOT_ACCEPTED" });
    const region = screen.getByRole("region", { name: messages.history.explanation.title });
    expect(within(region).getByText(messages.ai.remoteNotAccepted)).toBeInTheDocument();
    expect(within(region).queryByText(messages.history.explanation.aiLabel)).not.toBeInTheDocument();
    const text = region.textContent ?? "";
    const { headline, observation } = payloadOf(explanation);
    expect(text.indexOf(headline.text)).toBeLessThan(text.indexOf(messages.ai.remoteNotAccepted));
    expect(text.indexOf(messages.ai.remoteNotAccepted)).toBeLessThan(text.indexOf(observation.text));
    // Non-technical: no reason code or provider detail.
    expect(text).not.toMatch(/MISSING_CONFIGURATION|REQUEST_CANCELLED|REMOTE_NOT_ACCEPTED|NOT_ACCEPTED|DeepSeek/);
  });
});
