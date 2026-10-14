/**
 * Owner decision 2026-10-14 (HSA-bounded mode, PREVIEW "Meal ideas"): which meal the Today tile is about, and which swaps it shows.
 * Pure functions over an injected clock; the swap list itself lives in `meal-ideas-data.ts` and is loaded lazily.
 *
 * Meal time uses Singapore wall-clock time (whatever the device time zone):
 * - BREAKFAST: before 10:30
 * - LUNCH: from 10:30 up to (not including) 16:00
 * - DINNER: from 16:00 to the end of the day
 *
 * Selection is deterministic: the same Singapore day always shows the same swaps, and the window moves on by `count` each day so the
 * ideas vary from day to day (wrapping around the list).
 */
import type { MealSwap } from "./meal-ideas-data";

export type MealIdeaSlot = "BREAKFAST" | "LUNCH" | "DINNER";

export const MEAL_IDEAS_SHOWN = 3;

const LUNCH_FROM_MINUTES = 10 * 60 + 30;
const DINNER_FROM_MINUTES = 16 * 60;
const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Singapore is UTC+08:00 all year (no daylight saving), so a fixed offset gives the wall clock. */
function singaporeWallClock(now: Date): { dayNumber: number; minutes: number } {
  const shifted = now.getTime() + SINGAPORE_OFFSET_MS;
  const dayNumber = Math.floor(shifted / DAY_MS);
  const minutes = Math.floor((shifted - dayNumber * DAY_MS) / 60_000);
  return { dayNumber, minutes };
}

export function mealIdeaSlotAt(now: Date): MealIdeaSlot {
  const { minutes } = singaporeWallClock(now);
  if (minutes < LUNCH_FROM_MINUTES) return "BREAKFAST";
  if (minutes < DINNER_FROM_MINUTES) return "LUNCH";
  return "DINNER";
}

/** `count` swaps for the given Singapore day, rotating through the list by day. */
export function pickMealIdeas(swaps: readonly MealSwap[], now: Date, count: number = MEAL_IDEAS_SHOWN): MealSwap[] {
  if (swaps.length === 0 || count <= 0) return [];
  const shown = Math.min(count, swaps.length);
  const { dayNumber } = singaporeWallClock(now);
  const start = (((dayNumber * shown) % swaps.length) + swaps.length) % swaps.length;
  return Array.from({ length: shown }, (_, index) => swaps[(start + index) % swaps.length]!);
}
