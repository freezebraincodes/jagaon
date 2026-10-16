import { normaliseFamiliarLabel } from "@/application/intelligence/familiar-identity";
import { HABIT_TREND_RULE_VERSION, type HabitTrend, type HabitTrendSlot } from "./preview-insights-contracts";

export { HABIT_TREND_RULE_VERSION, type HabitTrend, type HabitTrendSlot };

/**
 * HSA-bounded mode PREVIEW (owner decision 2026-10-14): "What changed alongside" a new habit.
 *
 * A pure, deterministic rule that compares the patient's own glucose readings in one slot before and after she started recording a
 * habit (an activity label). It describes timing only, never a cause. It is a preview-only computation shown while HSA-bounded mode is
 * OFF: it is never stored (not a Pattern, not learned knowledge), never fed to the AI, and it does not touch the intelligence activation
 * manifest, where cross-variable association stays DORMANT_PROHIBITED.
 *
 * Rule `habit-trend-preview.1`:
 * - Habits are activities grouped by normalised label (NFC, trimmed, lower case). The habit starts at its first recorded occurrence in
 *   the supplied activities; it qualifies only if that start is within the last 45 days (`now − 45d ≤ start ≤ now`) and at least 2
 *   occurrences (the first included) are recorded from the start to now.
 * - For each slot (BEFORE_BREAKFAST, BEFORE_DINNER): BEFORE readings are those at `[start − 28d, start)`, AFTER readings those at
 *   `[start, now]` (by instant). Each side needs at least 5 readings.
 * - Medians per side (the mean of the two middle values for an even count). Change = (after − before) / before; shown only if
 *   |change| ≥ 5%.
 * - The qualifying habit/slot with the largest |change| is returned. Ties: BEFORE_BREAKFAST before BEFORE_DINNER, then the earlier
 *   start, then the normalised label in code-point order.
 * - Wording is "lower" or "higher" only. Percent is rounded half away from zero to an integer; medians are rounded half up to 1 dp.
 * - Nothing qualifies → null.
 */

export const HABIT_TREND_CONFIG = Object.freeze({
  habitStartLookbackDays: 45,
  beforeWindowDays: 28,
  minimumHabitOccurrences: 2,
  minimumReadingsPerSide: 5,
  minimumAbsoluteChangePercent: 5,
  slots: Object.freeze(["BEFORE_BREAKFAST", "BEFORE_DINNER"] as const satisfies readonly HabitTrendSlot[]),
  homeOffsetMinutes: 480,
});

export type HabitTrendReading = Readonly<{ slot: string; at: string; valueMmolL: string }>;
export type HabitTrendActivity = Readonly<{ label: string; at: string }>;


const DAY_MS = 86_400_000;

/** A decimal mmol/L string as an integer number of thousandths (values carry at most a few decimals). */
function thousandths(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  return Math.round(Number(value) * 1000);
}

/** Median in thousandths; may be a half thousandth for an even count. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Thousandths → mmol/L at 1 dp, half up (values are positive). */
function oneDecimal(valueThousandths: number): string {
  return (Math.round(valueThousandths / 100) / 10).toFixed(1);
}

function localDate(instantMs: number): string {
  return new Date(instantMs + HABIT_TREND_CONFIG.homeOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

type Habit = { key: string; label: string; start: number; occurrences: Set<number> };

function habitsOf(activities: readonly HabitTrendActivity[], nowMs: number): Habit[] {
  const byKey = new Map<string, Habit>();
  const ordered = activities
    .map((activity) => ({ ...activity, ms: Date.parse(activity.at) }))
    .filter((activity) => Number.isFinite(activity.ms) && activity.ms <= nowMs && normaliseFamiliarLabel(activity.label) !== "")
    .sort((a, b) => a.ms - b.ms);
  for (const activity of ordered) {
    const key = normaliseFamiliarLabel(activity.label);
    const habit = byKey.get(key);
    if (habit) habit.occurrences.add(activity.ms);
    else byKey.set(key, { key, label: activity.label.trim(), start: activity.ms, occurrences: new Set([activity.ms]) });
  }
  return [...byKey.values()];
}

type Candidate = {
  habit: Habit;
  slot: HabitTrendSlot;
  slotIndex: number;
  before: number;
  after: number;
  beforeCount: number;
  afterCount: number;
  difference: number;
};

/** Compares |a.difference / a.before| with |b.difference / b.before| exactly (cross-multiplied; all values are half-thousandth exact). */
function compareMagnitude(a: Candidate, b: Candidate): number {
  return Math.abs(b.difference) * 2 * (a.before * 2) - Math.abs(a.difference) * 2 * (b.before * 2);
}

/** |difference| / before as a whole percent, half away from zero, in exact integer arithmetic. */
function roundedPercent(candidate: Candidate): number {
  const difference = Math.round(Math.abs(candidate.difference) * 2);
  const before = Math.round(candidate.before * 2);
  return Math.floor((200 * difference + before) / (2 * before));
}

export function computeHabitTrend(input: {
  now: string;
  readings: readonly HabitTrendReading[];
  activities: readonly HabitTrendActivity[];
}): HabitTrend | null {
  const config = HABIT_TREND_CONFIG;
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) return null;
  const readings = input.readings
    .map((reading) => ({ slot: reading.slot, ms: Date.parse(reading.at), value: thousandths(reading.valueMmolL) }))
    .filter((reading): reading is { slot: string; ms: number; value: number } => Number.isFinite(reading.ms) && reading.value !== null && reading.value > 0);

  const candidates: Candidate[] = [];
  for (const habit of habitsOf(input.activities, nowMs)) {
    if (habit.start < nowMs - config.habitStartLookbackDays * DAY_MS) continue;
    if (habit.occurrences.size < config.minimumHabitOccurrences) continue;
    const beforeStart = habit.start - config.beforeWindowDays * DAY_MS;
    config.slots.forEach((slot, slotIndex) => {
      const inSlot = readings.filter((reading) => reading.slot === slot);
      const before = inSlot.filter((reading) => reading.ms >= beforeStart && reading.ms < habit.start).map((reading) => reading.value);
      const after = inSlot.filter((reading) => reading.ms >= habit.start && reading.ms <= nowMs).map((reading) => reading.value);
      if (before.length < config.minimumReadingsPerSide || after.length < config.minimumReadingsPerSide) return;
      const beforeMedian = median(before);
      const afterMedian = median(after);
      // Exact integer comparison (medians are whole or half thousandths): |after − before| × 100 ≥ 5 × before.
      const difference = afterMedian - beforeMedian;
      if (Math.abs(difference) * 2 * 100 < config.minimumAbsoluteChangePercent * beforeMedian * 2) return;
      candidates.push({ habit, slot, slotIndex, before: beforeMedian, after: afterMedian, beforeCount: before.length, afterCount: after.length, difference });
    });
  }
  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      compareMagnitude(a, b) ||
      a.slotIndex - b.slotIndex ||
      a.habit.start - b.habit.start ||
      (a.habit.key < b.habit.key ? -1 : a.habit.key > b.habit.key ? 1 : 0),
  );
  const best = candidates[0]!;
  const startDate = localDate(best.habit.start);
  return Object.freeze({
    ruleVersion: HABIT_TREND_RULE_VERSION,
    habitLabel: best.habit.label,
    slot: best.slot,
    direction: best.difference < 0 ? "LOWER" : "HIGHER",
    percentChange: roundedPercent(best),
    beforeMedian: oneDecimal(best.before),
    afterMedian: oneDecimal(best.after),
    beforeCount: best.beforeCount,
    afterCount: best.afterCount,
    habitCount: best.habit.occurrences.size,
    daysSince: Math.round((Date.parse(`${localDate(nowMs)}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS),
    startedAt: new Date(best.habit.start).toISOString(),
    startDate,
  });
}
