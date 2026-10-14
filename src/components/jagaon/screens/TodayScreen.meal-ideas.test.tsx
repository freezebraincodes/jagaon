import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getMessages } from "@/i18n/get-messages";
import { createDemoScenarioFixture } from "@/application/governed/demo-scenario-fixture";
import type { TodayJournalViewModel } from "@/application/journal/journal-contracts";
import { MEAL_IDEAS } from "@/application/preview/meal-ideas-data";
import { pickMealIdeas } from "@/application/preview/meal-ideas";
import {
  HSA_BOUNDED_MODE_STORAGE_KEY,
  HsaBoundedModeProvider,
  resetHsaBoundedModeForTests,
} from "../hsa/hsa-bounded-mode";
import { TodayScreen } from "./TodayScreen";

/**
 * Owner decision 2026-10-14 (HSA-bounded mode, PREVIEW "Meal ideas"): the Today tile appears only while the mode is OFF, shows three
 * swaps for the current Singapore meal, and opens Food information with "Higher in wholegrains" chosen.
 */

const en = getMessages("en-SG");
const journal: TodayJournalViewModel = { unavailable: false, entries: [] };

// Singapore wall-clock times on 14 Oct 2026.
const BREAKFAST = new Date("2026-10-14T07:15:00+08:00");
const LUNCH = new Date("2026-10-14T12:00:00+08:00");
const DINNER = new Date("2026-10-14T19:30:00+08:00");

const store = new Map<string, string>();

function show(now: Date) {
  const navigate = vi.fn();
  render(
    <HsaBoundedModeProvider>
      <TodayScreen messages={en} locale="en-SG" fixture={createDemoScenarioFixture()} journal={journal} navigate={navigate} now={now} />
    </HsaBoundedModeProvider>,
  );
  return { navigate };
}

describe("Today meal ideas (HSA preview)", () => {
  beforeEach(() => {
    store.clear();
    resetHsaBoundedModeForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("HSA-bounded mode ON (default): no meal ideas tile, Today unchanged", async () => {
    show(LUNCH);
    // Give a lazily loaded tile every chance to appear.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("heading", { name: en.hsaMealIdeas.headingLunch })).toBeNull();
    expect(screen.queryByText(en.hsaMealIdeas.note)).toBeNull();
    expect(screen.queryByRole("button", { name: en.hsaMealIdeas.findPlaces })).toBeNull();
    expect(screen.queryByText(en.hsa.previewTag)).toBeNull();
    // The existing two tiles stay.
    expect(screen.getByRole("button", { name: en.today.mealTitle })).toBeInTheDocument();
  });

  it.each([
    ["breakfast", BREAKFAST, en.hsaMealIdeas.headingBreakfast, MEAL_IDEAS.BREAKFAST],
    ["lunch", LUNCH, en.hsaMealIdeas.headingLunch, MEAL_IDEAS.LUNCH],
    ["dinner", DINNER, en.hsaMealIdeas.headingDinner, MEAL_IDEAS.DINNER],
  ] as const)("OFF at %s: the tile shows three swaps for that meal, the preview tag and the note", async (_meal, now, heading, swaps) => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    show(now);
    const title = await screen.findByRole("heading", { name: heading });
    const card = title.closest("section")!;
    expect(within(card).getByText(en.hsa.previewTag)).toBeInTheDocument();
    expect(within(card).getByText(en.hsaMealIdeas.intro)).toBeInTheDocument();
    expect(within(card).getByText(en.hsaMealIdeas.note)).toBeInTheDocument();

    const items = within(card).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const expected = pickMealIdeas(swaps, now);
    items.forEach((item, index) => {
      expect(within(item).getByText(expected[index]!.from)).toBeInTheDocument();
      expect(within(item).getByText(expected[index]!.to)).toBeInTheDocument();
    });
    for (const item of items) expect(swaps.map((swap) => swap.from)).toContain(item.querySelector(".meal-ideas-from")?.textContent);
  });

  it("owner decision 2026-10-15: Show other ideas (top right) moves on by three swaps per tap and never repeats within the meal's list", async () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    show(BREAKFAST);
    const card = (await screen.findByRole("heading", { name: en.hsaMealIdeas.headingBreakfast })).closest("section")!;
    expect(en.hsaMealIdeas.intro).toBe("Healthier swaps people often try:");
    const refresh = within(card).getByRole("button", { name: en.hsaMealIdeas.refresh });
    const shown = () => within(card).getAllByRole("listitem").map((item) => item.querySelector(".meal-ideas-from")?.textContent);
    const seen = new Set(shown());
    for (let tap = 1; tap < MEAL_IDEAS.BREAKFAST.length / 3; tap += 1) {
      fireEvent.click(refresh);
      const now = shown();
      expect(now).toEqual(pickMealIdeas(MEAL_IDEAS.BREAKFAST, BREAKFAST, 3, tap).map((swap) => swap.from));
      for (const from of now) seen.add(from);
    }
    expect(seen.size).toBe(MEAL_IDEAS.BREAKFAST.length);
  });

  it("OFF: Find healthier places nearby opens Food information with Higher in wholegrains chosen", async () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    const { navigate } = show(LUNCH);
    fireEvent.click(await screen.findByRole("button", { name: en.hsaMealIdeas.findPlaces }));
    expect(navigate).toHaveBeenCalledWith("NEARBY_FOOD", { attribute: "HIGHER_IN_WHOLEGRAINS" });
  });

  it("OFF: the tile sits below the meal and activity tiles, which keep their layout", async () => {
    store.set(HSA_BOUNDED_MODE_STORAGE_KEY, "off");
    show(LUNCH);
    const card = (await screen.findByRole("heading", { name: en.hsaMealIdeas.headingLunch })).closest("section")!;
    const tiles = screen.getByRole("region", { name: en.today.summaryTiles });
    expect(tiles.querySelectorAll(".summary-tile")).toHaveLength(2);
    expect(tiles.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
