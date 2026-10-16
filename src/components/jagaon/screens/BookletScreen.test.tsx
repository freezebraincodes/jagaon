import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import { BOOKLET_COLUMNS, type BookletDay, type BookletQueryPort } from "@/application/booklet/booklet-query";
import { BookletScreen } from "./BookletScreen";

/** Owner decision 2026-10-16: the Booklet tab, a paper-diary table of her own records (read-only, no AI). */
afterEach(() => cleanup());

const en = getMessages("en-SG");
const empty = () => Object.fromEntries(BOOKLET_COLUMNS.map((column) => [column, []])) as unknown as BookletDay["readings"];
const tuesday: BookletDay = {
  date: "2026-10-13" as never,
  readings: {
    ...empty(),
    BREAKFAST_BEFORE: [{ value: "6.1", unit: "mmol/L", at: "2026-10-12T23:12:00.000Z" as never }],
    DINNER_BEFORE: [{ value: "9.3", unit: "mmol/L", at: "2026-10-13T10:47:00.000Z" as never }],
  },
  notes: [
    { kind: "MEAL", at: "2026-10-12T23:30:00.000Z" as never, label: "Kaya toast" },
    { kind: "MEDICINE", at: "2026-10-13T00:00:00.000Z" as never, name: "Metformin", state: "TAKEN" },
    { kind: "ACTIVITY", at: null, label: "Morning walk", minutes: 20 },
  ],
};
const monday: BookletDay = { date: "2026-10-12" as never, readings: empty(), notes: [] };

function port(): BookletQueryPort & { load: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async ({ period }) => ({ status: "READY" as const, period, today: "2026-10-13" as never, range: { startDate: "2026-10-12" as never, endDate: "2026-10-13" as never }, days: [tuesday, monday] })),
  };
}

describe("Booklet screen", () => {
  it("lays out each day as a row with before and after columns for each meal and bedtime, and the day's notes beneath", async () => {
    const booklet = port();
    render(<BookletScreen messages={en} locale="en-SG" booklet={booklet} />);
    const table = await screen.findByRole("table", { name: /Readings in mmol\/L, 12–13 Oct 2026/ });
    expect(booklet.load).toHaveBeenCalledWith({ period: "THIS_WEEK" });

    // Column headers name each meal time in full for screen readers.
    const headers = within(table).getAllByRole("columnheader").map((header) => header.getAttribute("aria-label") ?? header.textContent);
    expect(headers).toEqual([
      "Date",
      "Breakfast",
      "Lunch",
      "Dinner",
      "Bedtime",
      en.booklet.columnNames.OTHER,
      "Before breakfast",
      "After breakfast",
      "Before lunch",
      "After lunch",
      "Before dinner",
      "After dinner",
    ]);

    const rows = within(table).getAllByRole("row");
    const tuesdayRow = rows.find((row) => within(row).queryByRole("rowheader")?.textContent?.startsWith("Tue13 Oct"))!;
    const cells = within(tuesdayRow).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["6.17:12 am", "–not recorded", "–not recorded", "–not recorded", "9.36:47 pm", "–not recorded", "–not recorded", "–not recorded"]);

    const notes = rows[rows.indexOf(tuesdayRow) + 1]!;
    expect(notes).toHaveTextContent("Notes: 7:30 amKaya toast8:00 amMetformin takenno timeMorning walk, 20 min");
    expect(within(notes).getAllByRole("listitem")).toHaveLength(3);
    // Today is marked; a day with nothing recorded is one quiet line, with no notes row.
    expect(within(tuesdayRow).getByRole("rowheader")).toHaveTextContent("Tue13 OctToday");
    const mondayRow = rows.find((row) => within(row).queryByRole("rowheader")?.textContent === "Mon12 Oct")!;
    expect(within(mondayRow).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([en.booklet.nothingRecorded]);
    expect(rows.indexOf(mondayRow)).toBe(rows.length - 1);
  });

  it("loads another period when chosen, and offers a retry when the records cannot be read", async () => {
    const booklet = port();
    render(<BookletScreen messages={en} locale="en-SG" booklet={booklet} />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("radio", { name: en.history.periodThirtyDays }));
    expect(booklet.load).toHaveBeenLastCalledWith({ period: "THIRTY_DAYS" });
    cleanup();

    const failing = { load: vi.fn().mockResolvedValueOnce({ status: "UNAVAILABLE" }).mockResolvedValue({ status: "READY", period: "THIS_WEEK", today: "2026-10-13", range: { startDate: "2026-10-12", endDate: "2026-10-13" }, days: [] }) };
    render(<BookletScreen messages={en} locale="en-SG" booklet={failing} />);
    fireEvent.click(await screen.findByRole("button", { name: en.booklet.retry }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(failing.load).toHaveBeenCalledTimes(2);
  });

  it("states records only: no colour by value, target or judgement words", async () => {
    const { container } = render(<BookletScreen messages={en} locale="en-SG" booklet={port()} />);
    await screen.findByRole("table");
    expect(container.textContent).not.toMatch(/high|low|target|normal|good|bad|risk|should/i);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });
});
