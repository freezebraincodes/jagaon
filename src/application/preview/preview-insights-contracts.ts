/**
 * HSA-bounded mode PREVIEW (owner decision 2026-10-14): the narrow contract the History UI reads for "What changed alongside". Types
 * only (no storage or intelligence import), so the UI stays on the narrow port. The rule is in `habit-trend.ts`; the read in
 * `preview-insights-query.ts`.
 */

export const HABIT_TREND_RULE_VERSION = "habit-trend-preview.1";

export type HabitTrendSlot = "BEFORE_BREAKFAST" | "BEFORE_DINNER";

export type HabitTrend = Readonly<{
  ruleVersion: typeof HABIT_TREND_RULE_VERSION;
  /** The authored label of the habit's first occurrence, unchanged. */
  habitLabel: string;
  slot: HabitTrendSlot;
  direction: "LOWER" | "HIGHER";
  /** |change| as a whole percent. */
  percentChange: number;
  /** Medians in mmol/L, 1 dp ("7.6"). */
  beforeMedian: string;
  afterMedian: string;
  beforeCount: number;
  afterCount: number;
  /** Occurrences of the habit recorded from its start to now. */
  habitCount: number;
  /** Home-timezone local days from the start date to today. */
  daysSince: number;
  /** The start instant (first occurrence) and its home-timezone local date. */
  startedAt: string;
  startDate: string;
}>;

export type PreviewInsightsQueryPort = {
  /** The "What changed alongside" habit trend, or null when nothing qualifies or the records cannot be read. */
  habitTrend(): Promise<HabitTrend | null>;
};
