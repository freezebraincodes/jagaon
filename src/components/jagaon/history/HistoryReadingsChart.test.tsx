import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import type { HistoryChartPosition } from "@/application/history/recorded-history-contracts";
import { HistoryReadingsChart } from "./HistoryReadingsChart";

// jsdom has no PointerEvent: without one, fireEvent drops clientX and pointerType.
if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "";
    }
  } as unknown as typeof PointerEvent;
}

/** Owner decision 2026-10-12: every reading is drawn; a position never shows only its latest reading. */
const CHART = [
  { date: "2026-09-29", position: "MORNING", state: "RECORDED", valueMmolL: "6.2", readingCount: 1, readings: [{ valueMmolL: "6.2", at: "2026-09-28T23:10:00.000Z" }] },
  {
    date: "2026-09-29",
    position: "EVENING",
    state: "RECORDED",
    valueMmolL: "7.3",
    readingCount: 2,
    readings: [
      { valueMmolL: "9.1", at: "2026-09-29T05:05:00.000Z" },
      { valueMmolL: "7.3", at: "2026-09-29T10:40:00.000Z" },
    ],
  },
  { date: "2026-09-30", position: "MORNING", state: "NOT_RECORDED" },
  { date: "2026-09-30", position: "EVENING", state: "NOT_RECORDED" },
] as unknown as HistoryChartPosition[];

describe("HistoryReadingsChart", () => {
  afterEach(() => cleanup());

  it("draws one bar per reading, side by side within its position, and an outline for each position not recorded", () => {
    const { container } = render(<HistoryReadingsChart messages={getMessages("en-SG")} locale="en-SG" period="THIS_WEEK" chart={CHART} headingId="h" />);
    const slots = [...container.querySelectorAll(".history-slot")];
    expect(slots).toHaveLength(4);
    expect([...slots[0]!.querySelectorAll(".history-bar--recorded")].map((bar) => bar.getAttribute("data-value"))).toEqual(["6.2"]);
    // The 1:05 pm reading is drawn beside the 6:40 pm one, in time order.
    expect([...slots[1]!.querySelectorAll(".history-bar--recorded")].map((bar) => bar.getAttribute("data-value"))).toEqual(["9.1", "7.3"]);
    expect(slots[2]!.querySelectorAll(".history-bar--missing")).toHaveLength(1);
    expect(container.querySelectorAll(".history-bar--recorded")).toHaveLength(3);
  });

  it("lists every reading with its time in the table, and describes the reading count", () => {
    const messages = getMessages("en-SG");
    const { container, getByRole } = render(<HistoryReadingsChart messages={messages} locale="en-SG" period="THIS_WEEK" chart={CHART} headingId="h" />);
    const rows = within(getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => [row.querySelector("th")!.textContent, row.querySelector("td")!.textContent])).toEqual([
      ["Tue 29 Sep morning, 7:10 am", "6.2"],
      ["Tue 29 Sep evening, 1:05 pm", "9.1"],
      ["Tue 29 Sep evening, 6:40 pm", "7.3"],
      ["Wed 30 Sep morning", messages.history.notRecordedLegend],
      ["Wed 30 Sep evening", messages.history.notRecordedLegend],
    ]);
    expect(container.querySelector("#h-description")!.textContent).toBe(messages.history.chartDescription(3, 4, "mmol/L"));
  });

  it("shows the nearest bar's day, time and value when tapped or pointed at, and clears it on a second tap (owner decision 2026-10-16)", () => {
    const messages = getMessages("en-SG");
    const { container } = render(<HistoryReadingsChart messages={messages} locale="en-SG" period="THIS_WEEK" chart={CHART} headingId="h" />);
    const bars = [...container.querySelectorAll<HTMLElement>(".history-bar--recorded")];
    bars.forEach((bar, index) => (bar.getBoundingClientRect = () => ({ left: index * 20, width: 10 }) as DOMRect));
    const plot = container.querySelector(".history-plot")!;
    const readout = container.querySelector(".history-readout")!;
    expect(readout.textContent).toBe(messages.history.chartReadout.hint);
    expect(readout).toHaveAttribute("aria-hidden", "true");

    // A tap near the second bar (centre 25) picks it, even off the bar itself.
    fireEvent.pointerUp(plot, { pointerType: "touch", clientX: 27 });
    expect(readout.textContent).toBe("Tue 29 Sep, 1:05 pm: 9.1 mmol/L");
    expect(container.querySelector(".history-bar--selected .history-bar-value")!.textContent).toBe("9.1");
    expect(container.querySelectorAll(".history-bar--selected")).toHaveLength(1);

    // Pointing with a mouse shows the bar under the pointer; leaving returns to the tapped one.
    fireEvent.pointerMove(plot, { pointerType: "mouse", clientX: 44 });
    expect(readout.textContent).toBe("Tue 29 Sep, 6:40 pm: 7.3 mmol/L");
    fireEvent.pointerLeave(plot);
    expect(readout.textContent).toBe("Tue 29 Sep, 1:05 pm: 9.1 mmol/L");

    fireEvent.pointerUp(plot, { pointerType: "touch", clientX: 25 });
    expect(readout.textContent).toBe(messages.history.chartReadout.hint);
    expect(container.querySelector(".history-bar-value")).toBeNull();
  });

  it("words the readout in both locales", () => {
    expect(getMessages("en-SG").history.chartReadout.reading("Tue 29 Sep", "7:10 am", "6.2", "mmol/L")).toBe("Tue 29 Sep, 7:10 am: 6.2 mmol/L");
    expect(getMessages("zh-SG").history.chartReadout.reading("9月29日周二", "上午7:10", "6.2", "mmol/L")).toBe("9月29日周二，上午7:10：6.2 mmol/L");
  });
});
