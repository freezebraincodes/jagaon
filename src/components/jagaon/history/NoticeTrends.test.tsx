import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryComparison } from "@/application/history/recorded-history-contracts";
import { getMessages } from "@/i18n/get-messages";
import { NoticeCard } from "./NoticeCard";
import { TrendsCard } from "./TrendsCard";

/** Owner decision 2026-10-16: Notice (a plain sentence on Today) and Trends (the same comparison as two bars in History). */
afterEach(() => cleanup());

const en = getMessages("en-SG");
const windows = {
  recentWindow: { startDate: "2026-10-02", endDate: "2026-10-15" },
  referenceWindow: { startDate: "2026-09-04", endDate: "2026-10-01" },
  correctionUpdated: false,
};
const breakfastLower = { factId: "COMPARISON:BEFORE_BREAKFAST", slot: "BEFORE_BREAKFAST", kind: "LOWER", recent: "6.1", reference: "7.55", ...windows } as HistoryComparison;
const dinnerHigher = { factId: "COMPARISON:BEFORE_DINNER", slot: "BEFORE_DINNER", kind: "HIGHER", recent: "9.1", reference: "7.8", ...windows } as HistoryComparison;
const dinnerNoChange = { factId: "COMPARISON:BEFORE_DINNER", slot: "BEFORE_DINNER", kind: "NO_MATERIAL", recent: null, reference: null, ...windows } as HistoryComparison;
const spreadMore = { factId: "COMPARISON:BEDTIME", slot: "BEDTIME", kind: "VARIABILITY", recent: "2.4", reference: "1.1", ...windows } as HistoryComparison;

// Words that would turn a description into a judgement, a cause or advice.
const NOT_ALLOWED = /because|due to|should|try|recommend|risk|danger|good|bad|improv|worse|better|target|normal|high risk|too high|too low|caused/i;

describe("Notice card (Today)", () => {
  it("states each real difference in one plain sentence, says it is not a cause, and opens History", () => {
    const onOpenHistory = vi.fn();
    render(<NoticeCard messages={en} notice={{ comparisons: [breakfastLower, dinnerHigher, dinnerNoChange] }} onOpenHistory={onOpenHistory} />);
    const card = screen.getByRole("region", { name: en.history.notice.title });
    expect(within(card).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Your before-breakfast readings in the last 2 weeks are lower than in weeks 3 to 6.",
      "Your before-dinner readings in the last 2 weeks are higher than in weeks 3 to 6.",
    ]);
    expect(card).toHaveTextContent(en.history.nonCausalLimitation);
    for (const item of within(card).getAllByRole("listitem")) expect(item.textContent).not.toMatch(NOT_ALLOWED);
    fireEvent.click(within(card).getByRole("button", { name: en.history.notice.open }));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it("says a spread varied more or less, never better or worse", () => {
    render(<NoticeCard messages={en} notice={{ comparisons: [spreadMore, { ...spreadMore, factId: "X", recent: "0.9" } as HistoryComparison] }} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Your bedtime readings in the last 2 weeks varied more than in weeks 3 to 6.",
      "Your bedtime readings in the last 2 weeks varied less than in weeks 3 to 6.",
    ]);
  });

  it("says there are not enough readings yet when nothing passed the evidence gate, and shows nothing before loading", () => {
    render(<NoticeCard messages={en} notice={{ comparisons: [dinnerNoChange] }} />);
    expect(screen.getByRole("region", { name: en.history.notice.title })).toHaveTextContent(en.history.notice.notEnough);
    expect(screen.queryByRole("listitem")).toBeNull();
    cleanup();
    const { container } = render(<NoticeCard messages={en} notice={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Trends card (History)", () => {
  it("draws each real difference as two labelled bars with dates and values written out; no difference, no figure", () => {
    render(<TrendsCard messages={en} locale="en-SG" comparisons={[breakfastLower, dinnerHigher, dinnerNoChange]} />);
    const card = screen.getByRole("region", { name: en.history.trends.title });
    const figures = within(card).getAllByRole("figure");
    expect(figures).toHaveLength(2);
    const breakfast = figures[0]!;
    expect(breakfast).toHaveTextContent(`Before breakfast · ${en.history.trends.median}`);
    const rows = within(breakfast).getAllByRole("term").map((term) => term.textContent);
    expect(rows[0]).toContain(en.history.trends.earlier);
    expect(rows[1]).toContain(en.history.trends.recent);
    expect(within(breakfast).getAllByRole("definition").map((value) => value.textContent)).toEqual(["7.55 mmol/L", "6.1 mmol/L"]);
    // The longer bar is the larger value; bars are decorative (the text carries the numbers).
    const fills = breakfast.querySelectorAll<HTMLElement>(".trends-bar-fill");
    expect(fills[0]!.style.width).toBe("100%");
    expect(Number.parseFloat(fills[1]!.style.width)).toBeCloseTo((6.1 / 7.55) * 100, 1);
    expect(breakfast.querySelector(".trends-bar")).toHaveAttribute("aria-hidden", "true");
    expect(card.textContent).not.toMatch(NOT_ALLOWED);
  });

  it("labels a variability comparison as a spread, and renders nothing when there is no real difference", () => {
    render(<TrendsCard messages={en} locale="en-SG" comparisons={[spreadMore]} />);
    expect(screen.getByRole("figure")).toHaveTextContent(`Bedtime · ${en.history.trends.spread}`);
    cleanup();
    const { container } = render(<TrendsCard messages={en} locale="en-SG" comparisons={[dinnerNoChange]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
