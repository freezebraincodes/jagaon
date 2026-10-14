// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MEAL_IDEAS, MEAL_IDEAS_VERSION, type MealSwap } from "./meal-ideas-data";
import { MEAL_IDEAS_SHOWN, mealIdeaSlotAt, pickMealIdeas } from "./meal-ideas";

/** Singapore wall-clock time on a given date, as an instant (Singapore is UTC+08:00 all year). */
const sgt = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);

const ALL_SWAPS: MealSwap[] = [...MEAL_IDEAS.BREAKFAST, ...MEAL_IDEAS.LUNCH, ...MEAL_IDEAS.DINNER];

// No medical claims, no condition, no numbers: general "healthier choice" wording only.
const FORBIDDEN = [
  "cure",
  "diabetes",
  "diabetic",
  "blood sugar",
  "glucose",
  "insulin",
  "spike",
  "treat",
  "heal",
  "prevent",
  "reverse",
  "doctor",
  "medicine",
  "dose",
  "calorie",
  "kcal",
  "gram",
  "gi ",
  "glycaemic",
  "glycemic",
  "your ",
  "must",
  "never",
  "always",
];

describe("meal ideas dataset (meal-ideas.2)", () => {
  it("is versioned", () => {
    expect(MEAL_IDEAS_VERSION).toBe("meal-ideas.2");
  });

  it("meal-ideas.2: 24 swaps per meal, evenly, so \"Show other ideas\" shows 8 different sets before any repeat", () => {
    expect(Object.keys(MEAL_IDEAS).sort()).toEqual(["BREAKFAST", "DINNER", "LUNCH"]);
    for (const swaps of Object.values(MEAL_IDEAS)) {
      expect(swaps.length).toBe(24);
      expect(swaps.length % MEAL_IDEAS_SHOWN).toBe(0);
    }
    expect(ALL_SWAPS.length).toBe(72);
  });

  it("gives every swap a unique id and short, plain from/to wording", () => {
    expect(new Set(ALL_SWAPS.map((swap) => swap.id)).size).toBe(ALL_SWAPS.length);
    for (const swap of ALL_SWAPS) {
      expect(Object.keys(swap).sort()).toEqual(["from", "id", "to"]);
      expect(swap.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      for (const text of [swap.from, swap.to]) {
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(45);
        expect(text).not.toMatch(/[→\n]/);
      }
    }
  });

  it("contains no digits and no medical or condition wording", () => {
    for (const swap of ALL_SWAPS) {
      const text = `${swap.from} ${swap.to} `.toLowerCase();
      expect(text, swap.id).not.toMatch(/\d/);
      for (const word of FORBIDDEN) expect(text, `${swap.id}: "${word}"`).not.toContain(word);
    }
  });

  it("owner review 2026-10-15: fruit is always a small portion of a lower-sugar fruit, never a very sweet one or \"a whole fruit\"", () => {
    const SWEET = ["durian", "mango", "lychee", "longan", "banana", "grape", "date", "jackfruit", "rambutan", "dried fruit", "whole fruit", "fruit juice"];
    const FRUIT = /\b(?:fruit|apple|orange|pear|guava|berr(?:y|ies)|honeydew|papaya|melon)\b/i;
    for (const swap of ALL_SWAPS) {
      const to = swap.to.toLowerCase();
      for (const word of SWEET) expect(to, `${swap.id}: "${word}"`).not.toContain(word);
      if (FRUIT.test(to)) expect(to, swap.id).toMatch(/\b(?:small|few)\b/);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(MEAL_IDEAS)).toBe(true);
    expect(Object.isFrozen(MEAL_IDEAS.LUNCH)).toBe(true);
  });
});

describe("meal time (Singapore wall clock)", () => {
  it.each([
    ["00:00", "BREAKFAST"],
    ["07:30", "BREAKFAST"],
    ["10:29", "BREAKFAST"],
    ["10:30", "LUNCH"],
    ["12:00", "LUNCH"],
    ["15:59", "LUNCH"],
    ["16:00", "DINNER"],
    ["21:00", "DINNER"],
    ["23:59", "DINNER"],
  ] as const)("%s is %s", (time, slot) => {
    expect(mealIdeaSlotAt(sgt("2026-10-14", time))).toBe(slot);
  });

  it("uses Singapore time whatever the instant's UTC date", () => {
    // 23:30 UTC on 13 Oct is 07:30 on 14 Oct in Singapore.
    expect(mealIdeaSlotAt(new Date("2026-10-13T23:30:00Z"))).toBe("BREAKFAST");
    // 08:30 UTC is 16:30 in Singapore.
    expect(mealIdeaSlotAt(new Date("2026-10-14T08:30:00Z"))).toBe("DINNER");
  });
});

describe("daily selection", () => {
  const list = MEAL_IDEAS.LUNCH;

  it("shows three swaps from the meal's list", () => {
    const picked = pickMealIdeas(list, sgt("2026-10-14", "12:00"));
    expect(picked).toHaveLength(3);
    for (const swap of picked) expect(list).toContain(swap);
    expect(new Set(picked.map((swap) => swap.id)).size).toBe(3);
  });

  it("is the same all day and changes the next day", () => {
    const morning = pickMealIdeas(list, sgt("2026-10-14", "00:01"));
    const night = pickMealIdeas(list, sgt("2026-10-14", "23:59"));
    const tomorrow = pickMealIdeas(list, sgt("2026-10-15", "12:00"));
    expect(night).toEqual(morning);
    expect(tomorrow.map((swap) => swap.id)).not.toEqual(morning.map((swap) => swap.id));
  });

  it("covers the whole list over consecutive days", () => {
    const seen = new Set<string>();
    const first = sgt("2026-10-10", "12:00").getTime();
    for (let day = 0; day < list.length; day += 1) {
      for (const swap of pickMealIdeas(list, new Date(first + day * 86_400_000))) seen.add(swap.id);
    }
    expect(seen.size).toBe(list.length);
  });

  it("owner decision 2026-10-15: each \"Show other ideas\" tap moves on by one set, reaching every swap before any repeats", () => {
    const now = sgt("2026-10-15", "08:00");
    const seen: string[] = [];
    for (let step = 0; step < list.length / MEAL_IDEAS_SHOWN; step += 1) seen.push(...pickMealIdeas(list, now, MEAL_IDEAS_SHOWN, step).map((swap) => swap.id));
    expect(new Set(seen).size).toBe(list.length);
    expect(pickMealIdeas(list, now, MEAL_IDEAS_SHOWN, list.length / MEAL_IDEAS_SHOWN)).toEqual(pickMealIdeas(list, now));
    expect(pickMealIdeas(list, now, MEAL_IDEAS_SHOWN, -2)).toEqual(pickMealIdeas(list, now));
  });

  it("meal-ideas.2: every set of three leads with a Singapore dish and holds at most one generic swap", () => {
    const GENERIC = new Set(["sweetened-cereal", "fruit-juice", "white-bread", "butter-croissant", "sweetened-yoghurt", "pancakes", "muffin", "fried-chicken", "soft-drink", "bubble-tea", "burger-fries", "creamy-pasta", "iced-lemon-tea", "fish-and-chips", "fried-chicken-wings", "pizza", "instant-noodles", "ice-cream", "potato-chips"]);
    for (const swaps of Object.values(MEAL_IDEAS)) {
      for (let start = 0; start < swaps.length; start += MEAL_IDEAS_SHOWN) {
        const set = swaps.slice(start, start + MEAL_IDEAS_SHOWN).map((swap) => swap.id);
        expect(GENERIC.has(set[0]!), set.join(", ")).toBe(false);
        expect(set.filter((id) => GENERIC.has(id)).length, set.join(", ")).toBeLessThanOrEqual(1);
      }
    }
  });

  it("wraps around a short list and handles empty input", () => {
    const short = list.slice(0, 2);
    expect(pickMealIdeas(short, sgt("2026-10-14", "12:00"))).toHaveLength(2);
    expect(pickMealIdeas([], sgt("2026-10-14", "12:00"))).toEqual([]);
    expect(pickMealIdeas(list, sgt("2026-10-14", "12:00"), 0)).toEqual([]);
  });
});
