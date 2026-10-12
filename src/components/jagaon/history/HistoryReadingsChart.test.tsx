import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import type { HistoryChartPosition } from "@/application/history/recorded-history-contracts";
import { HistoryReadingsChart } from "./HistoryReadingsChart";

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
});
