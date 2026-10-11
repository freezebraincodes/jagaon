import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/get-messages";
import { TimeWheel, fromTimeWheel, toTimeWheel } from "./TimeWheel";
import { WHEEL_ROW, dragWheel, keenDragEvent, pause, stubWheelGeometry } from "./time-wheel-test-support";

const en = getMessages("en-SG");
const zh = getMessages("zh-SG");
const ROW = WHEEL_ROW;

function Harness({
  initial,
  locale = "en-SG",
  onChange,
}: {
  initial: string;
  locale?: "en-SG" | "zh-SG";
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const messages = locale === "en-SG" ? en.readingTime : zh.readingTime;
  return (
    <>
      <TimeWheel
        legend="Time"
        value={value}
        onChange={(next) => {
          onChange?.(next);
          setValue(next);
        }}
        messages={messages}
      />
      <output data-testid="value">{value}</output>
      <button type="button" onClick={() => setValue("13:05")}>
        external
      </button>
    </>
  );
}

const column = (name: string) => screen.getByRole("listbox", { name });
const hour = () => column(en.readingTime.hourLabel);
const minute = () => column(en.readingTime.minuteLabel);
const period = () => column(en.readingTime.periodLabel);
const selected = (listbox: HTMLElement) => within(listbox).getByRole("option", { selected: true });
const centred = (listbox: HTMLElement) => listbox.querySelector<HTMLElement>('[role="option"][data-centred="true"]');
const value = () => screen.getByTestId("value").textContent;

beforeEach(() => {
  stubWheelGeometry();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TimeWheel on Keen Slider", () => {
  it("starts at 07:48 am with exactly one selected, centred option per column", () => {
    render(<Harness initial="07:48" />);
    expect(within(hour()).getAllByRole("option")).toHaveLength(12);
    expect(within(minute()).getAllByRole("option")).toHaveLength(60);
    expect(within(period()).getAllByRole("option")).toHaveLength(2);
    for (const [listbox, text] of [
      [hour(), "7"],
      [minute(), "48"],
      [period(), en.readingTime.am],
    ] as const) {
      expect(within(listbox).getAllByRole("option", { selected: true })).toHaveLength(1);
      expect(selected(listbox)).toHaveTextContent(text);
      expect(listbox).toHaveAttribute("aria-activedescendant", selected(listbox).id);
      expect(centred(listbox)).toBe(selected(listbox));
      expect(listbox).toHaveAttribute("data-keen-slider-v");
    }
  });

  it("selects hour, minute and period values by dragging each wheel", async () => {
    render(<Harness initial="07:48" />);
    await dragWheel(hour(), 2);
    await waitFor(() => expect(value()).toBe("09:48"));
    await dragWheel(minute(), -3);
    await waitFor(() => expect(value()).toBe("09:45"));
    await dragWheel(period(), 1);
    await waitFor(() => expect(value()).toBe("21:45"));
    expect(selected(hour())).toHaveTextContent("9");
    expect(selected(minute())).toHaveTextContent("45");
    expect(selected(period())).toHaveTextContent(en.readingTime.pm);
    await waitFor(() => expect(centred(period())).toBe(selected(period())));
  });

  it("carries a flick past the dragged distance with inertia, then emits one value", async () => {
    const changes: string[] = [];
    render(<Harness initial="07:00" onChange={(next) => changes.push(next)} />);
    await dragWheel(minute(), 2, { fling: true });
    await waitFor(() => expect(changes).toHaveLength(1), { timeout: 5000 });
    // A two-row flick coasts well beyond the rows the finger covered.
    expect(Number(changes[0]!.slice(3))).toBeGreaterThan(10);
    await waitFor(() => expect(centred(minute())).toBe(selected(minute())));
    await pause(300);
    expect(changes).toHaveLength(1);
  });

  it("keeps a single Keen engine per wheel through a StrictMode remount", async () => {
    render(
      <StrictMode>
        <Harness initial="07:48" />
      </StrictMode>,
    );
    await dragWheel(hour(), 2);
    await waitFor(() => expect(value()).toBe("09:48"));
    await waitFor(() => expect(centred(hour())).toBe(selected(hour())));
    fireEvent.keyDown(minute(), { key: "ArrowDown" });
    await waitFor(() => expect(centred(minute())).toHaveTextContent("49"));
    expect(value()).toBe("09:49");
  });

  it("snaps without inertia when reduced motion is preferred", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const changes: string[] = [];
    render(<Harness initial="07:00" onChange={(next) => changes.push(next)} />);
    await dragWheel(minute(), 2, { fling: true });
    await waitFor(() => expect(changes).toHaveLength(1));
    // Keen's plain snap mode may step one row in the flick's direction, never coast.
    expect(["07:02", "07:03"]).toContain(changes[0]);
  });

  it("drags only the wheel under the pointer", async () => {
    render(<Harness initial="07:48" />);
    await dragWheel(minute(), 1);
    await waitFor(() => expect(value()).toBe("07:49"));
    expect(selected(hour())).toHaveTextContent("7");
    expect(centred(hour())).toBe(selected(hour()));
    expect(selected(period())).toHaveTextContent(en.readingTime.am);
  });

  it("loops hours from 12 to 1 and minutes from 59 to 00", async () => {
    render(<Harness initial="00:59" />);
    expect(selected(hour())).toHaveTextContent("12");
    await dragWheel(hour(), 1);
    await waitFor(() => expect(value()).toBe("01:59"));
    await dragWheel(minute(), 1);
    await waitFor(() => expect(value()).toBe("01:00"));
    await dragWheel(minute(), -1);
    await waitFor(() => expect(value()).toBe("01:59"));
  });

  it("does not loop am and pm", async () => {
    const changes: string[] = [];
    render(<Harness initial="07:48" onChange={(next) => changes.push(next)} />);
    await dragWheel(period(), -1);
    await pause(700);
    expect(value()).toBe("07:48");
    await dragWheel(period(), 1);
    await waitFor(() => expect(value()).toBe("19:48"));
    await dragWheel(period(), 1);
    await pause(700);
    expect(value()).toBe("19:48");
    expect(changes).toEqual(["19:48"]);
    fireEvent.keyDown(period(), { key: "ArrowDown" });
    expect(value()).toBe("19:48");
  });

  it("moves an externally changed value into all three wheels without echoing it back", async () => {
    const changes: string[] = [];
    render(<Harness initial="07:48" onChange={(next) => changes.push(next)} />);
    fireEvent.click(screen.getByRole("button", { name: "external" }));
    expect(selected(hour())).toHaveTextContent("1");
    expect(selected(minute())).toHaveTextContent("05");
    expect(selected(period())).toHaveTextContent(en.readingTime.pm);
    await waitFor(() => {
      expect(centred(hour())).toBe(selected(hour()));
      expect(centred(minute())).toBe(selected(minute()));
      expect(centred(period())).toBe(selected(period()));
    });
    await pause(100);
    expect(changes).toEqual([]);
    expect(value()).toBe("13:05");
  });

  it("keeps both changes when two wheels settle together", async () => {
    render(<Harness initial="07:48" />);
    keenDragEvent(hour(), "ksDragStart", 300);
    keenDragEvent(minute(), "ksDragStart", 300);
    keenDragEvent(hour(), "ksDrag", 300);
    keenDragEvent(minute(), "ksDrag", 300);
    for (let step = 1; step <= 6; step += 1) {
      keenDragEvent(hour(), "ksDrag", 300 - (3 * ROW * step) / 6);
      keenDragEvent(minute(), "ksDrag", 300 - (2 * ROW * step) / 6);
    }
    await pause(250);
    keenDragEvent(hour(), "ksDragEnd", 300 - 3 * ROW);
    keenDragEvent(minute(), "ksDragEnd", 300 - 2 * ROW);
    await waitFor(() => expect(value()).toBe("10:50"));
  });

  it("moves a tapped neighbouring option into the centre", async () => {
    render(<Harness initial="07:48" />);
    fireEvent.click(within(hour()).getByRole("option", { name: "8" }));
    expect(value()).toBe("08:48");
    await waitFor(() => expect(centred(hour())).toHaveTextContent("8"));
  });

  it("follows the mouse wheel through Keen Slider", async () => {
    render(<Harness initial="07:48" />);
    act(() => {
      hour().dispatchEvent(new WheelEvent("wheel", { deltaY: ROW, bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(value()).toBe("08:48"), { timeout: 2000 });
    await waitFor(() => expect(centred(hour())).toBe(selected(hour())));
  });

  it("keeps ArrowUp, ArrowDown, Home and End, looping hours and minutes", async () => {
    render(<Harness initial="00:59" />);
    fireEvent.keyDown(hour(), { key: "ArrowDown" });
    expect(value()).toBe("01:59");
    fireEvent.keyDown(hour(), { key: "ArrowUp" });
    expect(value()).toBe("00:59");
    fireEvent.keyDown(minute(), { key: "ArrowDown" });
    expect(value()).toBe("00:00");
    fireEvent.keyDown(minute(), { key: "End" });
    expect(value()).toBe("00:59");
    fireEvent.keyDown(minute(), { key: "Home" });
    expect(value()).toBe("00:00");
    fireEvent.keyDown(period(), { key: "End" });
    expect(value()).toBe("12:00");
    fireEvent.keyDown(period(), { key: "Home" });
    expect(value()).toBe("00:00");
    await waitFor(() => expect(centred(minute())).toHaveTextContent("00"));
  });

  it("keeps midnight and noon correct when the period wheel moves", async () => {
    render(<Harness initial="00:15" />);
    await dragWheel(period(), 1);
    await waitFor(() => expect(value()).toBe("12:15"));
    await dragWheel(period(), -1);
    await waitFor(() => expect(value()).toBe("00:15"));
  });

  it("converts 12 am, 12 pm and 1 pm exactly", () => {
    expect(fromTimeWheel({ hour: "12", minute: "00", period: "am" })).toBe("00:00");
    expect(fromTimeWheel({ hour: "12", minute: "00", period: "pm" })).toBe("12:00");
    expect(fromTimeWheel({ hour: "1", minute: "00", period: "pm" })).toBe("13:00");
    expect(toTimeWheel("00:00")).toEqual({ hour: "12", minute: "00", period: "am" });
    expect(toTimeWheel("12:30")).toEqual({ hour: "12", minute: "30", period: "pm" });
    expect(toTimeWheel("13:05")).toEqual({ hour: "1", minute: "05", period: "pm" });
  });

  it("uses English and Chinese accessible labels", () => {
    render(<Harness initial="13:05" />);
    expect(hour()).toBeInTheDocument();
    expect(minute()).toBeInTheDocument();
    expect(selected(period())).toHaveTextContent(en.readingTime.pm);
    cleanup();
    render(<Harness initial="13:05" locale="zh-SG" />);
    expect(screen.getByRole("listbox", { name: zh.readingTime.hourLabel })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: zh.readingTime.minuteLabel })).toBeInTheDocument();
    expect(selected(screen.getByRole("listbox", { name: zh.readingTime.periodLabel }))).toHaveTextContent(zh.readingTime.pm);
  });

  it("offers no native date or time picker", () => {
    const { container } = render(<Harness initial="07:48" />);
    expect(container.querySelector('input[type="datetime-local"], input[type="time"], input[type="date"]')).toBeNull();
  });
});

/** Keen's snap animation lasts 500 ms; this waits well past it. */
const SETTLE_MS = 1200;

const press = (listbox: HTMLElement, ...keys: string[]) => {
  for (const key of keys) fireEvent.keyDown(listbox, { key });
};

async function expectSettledOn(time: string, changes: string[], emitted: number) {
  await pause(SETTLE_MS);
  expect(value()).toBe(time);
  // No late change from Keen after the last key.
  expect(changes).toHaveLength(emitted);
  expect(changes.at(-1)).toBe(time);
  for (const listbox of [hour(), minute(), period()]) {
    expect(centred(listbox)).toBe(selected(listbox));
  }
}

describe("TimeWheel keeps the latest selection after rapid input", () => {
  it("period pm -> am -> pm within one frame stays on pm", async () => {
    const changes: string[] = [];
    render(<Harness initial="15:12" onChange={(next) => changes.push(next)} />);
    press(period(), "Home", "ArrowDown");
    expect(value()).toBe("15:12");
    await expectSettledOn("15:12", changes, 2);
    expect(changes).toEqual(["03:12", "15:12"]);
  });

  it("period pm -> am -> pm within one frame stays on pm with reduced motion", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const changes: string[] = [];
    render(<Harness initial="15:12" onChange={(next) => changes.push(next)} />);
    press(period(), "Home", "ArrowDown");
    await expectSettledOn("15:12", changes, 2);
  });

  it("period am -> pm -> am within one frame stays on am", async () => {
    const changes: string[] = [];
    render(<Harness initial="08:00" onChange={(next) => changes.push(next)} />);
    press(period(), "End", "ArrowUp");
    expect(value()).toBe("08:00");
    await expectSettledOn("08:00", changes, 2);
  });

  it("hour Home then ArrowDowns back to the starting hour stays there", async () => {
    const changes: string[] = [];
    render(<Harness initial="15:12" onChange={(next) => changes.push(next)} />);
    press(hour(), "Home", "ArrowDown", "ArrowDown");
    expect(value()).toBe("15:12");
    await expectSettledOn("15:12", changes, 3);
  });

  it("minute Home then twelve ArrowDowns back to :12 stays there", async () => {
    const changes: string[] = [];
    render(<Harness initial="15:12" onChange={(next) => changes.push(next)} />);
    press(minute(), "Home", ...Array<string>(12).fill("ArrowDown"));
    expect(value()).toBe("15:12");
    await expectSettledOn("15:12", changes, 13);
  });

  it("the evidence sequence (Home + ArrowDown on each column) settles on 8:00 pm", async () => {
    const changes: string[] = [];
    render(<Harness initial="15:12" onChange={(next) => changes.push(next)} />);
    press(hour(), "Home", ...Array<string>(7).fill("ArrowDown"));
    press(minute(), "Home");
    press(period(), "Home", "ArrowDown");
    expect(value()).toBe("20:00");
    await expectSettledOn("20:00", changes, changes.length);
  });

  it("a key pressed while a flick is still coasting wins over the flick", async () => {
    const changes: string[] = [];
    render(<Harness initial="07:00" onChange={(next) => changes.push(next)} />);
    await dragWheel(minute(), 2, { fling: true });
    // The flick coasts for several hundred milliseconds; press a key mid-way.
    await pause(50);
    expect(changes).toEqual([]);
    press(minute(), "End");
    expect(value()).toBe("07:59");
    await pause(3000);
    expect(value()).toBe("07:59");
    expect(changes).toEqual(["07:59"]);
    expect(centred(minute())).toBe(selected(minute()));
  }, 15_000);

  it("a key choosing the current value during a flick brings the wheel back to it", async () => {
    const changes: string[] = [];
    render(<Harness initial="07:00" onChange={(next) => changes.push(next)} />);
    await dragWheel(minute(), 2, { fling: true });
    await pause(50);
    press(minute(), "Home");
    await pause(3000);
    expect(value()).toBe("07:00");
    expect(changes).toEqual([]);
    expect(centred(minute())).toBe(selected(minute()));
  }, 15_000);

  it("slow keyboard steps and a tapped option still move the wheel", async () => {
    const changes: string[] = [];
    render(<Harness initial="15:12" onChange={(next) => changes.push(next)} />);
    press(period(), "Home");
    await pause(SETTLE_MS);
    press(period(), "ArrowDown");
    await pause(SETTLE_MS);
    press(hour(), "ArrowDown");
    await expectSettledOn("16:12", changes, 3);
    fireEvent.click(within(hour()).getByRole("option", { name: "5" }));
    await expectSettledOn("17:12", changes, 4);
    await dragWheel(minute(), 1);
    await waitFor(() => expect(value()).toBe("17:13"));
    await expectSettledOn("17:13", changes, 5);
  }, 15_000);
});
