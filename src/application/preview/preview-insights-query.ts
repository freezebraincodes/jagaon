import type { JagaOnDatabase } from "@/storage/database";
import type { Instant } from "@/domain/shared/time";
import type { GlucoseReadingPayload } from "@/domain/health-records/glucose-reading";
import { loadLatestReadingsAndActivities } from "@/application/intelligence/intelligence-snapshot";
import { occurrencePoint } from "@/application/intelligence/familiar-occurrences";
import { addDays, instantMs, toInstant } from "@/application/intelligence/metrics";
import { computeHabitTrend, HABIT_TREND_CONFIG, type HabitTrendActivity, type HabitTrendReading } from "./habit-trend";
import type { HabitTrend, PreviewInsightsQueryPort } from "./preview-insights-contracts";

/**
 * HSA-bounded mode PREVIEW insights (owner decision 2026-10-14). Read-only: it reads the latest validated journal revisions and
 * computes the preview rule in memory. Nothing is stored, nothing becomes a Pattern or learned knowledge, and nothing is sent to the AI.
 * The History screen calls it only while HSA-bounded mode is OFF.
 */
export type { PreviewInsightsQueryPort };

/** The reading's mmol/L value as stored (the same source value the History list shows). */
function storedMmolValue(payload: GlucoseReadingPayload): string | null {
  const measurement = payload.measurement;
  if (measurement.normalization?.canonicalUnit === "MMOL_L") return measurement.normalization.canonicalValue;
  return measurement.enteredUnit === "MMOL_L" ? measurement.enteredValue : null;
}

export function createPreviewInsightsQuery(database: JagaOnDatabase, dependencies: { now(): Instant }): PreviewInsightsQueryPort {
  async function habitTrend(): Promise<HabitTrend | null> {
    const now = dependencies.now();
    // Inclusive of now (the store's windows are half-open).
    const end = toInstant(instantMs(now) + 1);
    const windowStart = addDays(now, -(HABIT_TREND_CONFIG.habitStartLookbackDays + HABIT_TREND_CONFIG.beforeWindowDays));
    let loaded: Awaited<ReturnType<typeof loadLatestReadingsAndActivities>>;
    try {
      loaded = await loadLatestReadingsAndActivities(database, {
        glucose: { start: windowStart, end },
        // Activities over the same span: an occurrence before the 45-day lookback means the habit is not new.
        activities: { start: windowStart, end },
      });
    } catch {
      return null;
    }
    const readings: HabitTrendReading[] = [];
    for (const reading of loaded.glucose) {
      const context = reading.payload.context;
      if (context.kind !== "PATIENT_SELECTED_SLOT") continue;
      const point = occurrencePoint(reading.temporal as never);
      const value = storedMmolValue(reading.payload);
      if (point && value !== null) readings.push({ slot: context.slot, at: point.instant, valueMmolL: value });
    }
    const activities: HabitTrendActivity[] = [];
    for (const event of loaded.activityEvents) {
      const point = occurrencePoint(event.temporal);
      if (point) activities.push({ label: event.payload.patientLabel, at: point.instant });
    }
    return computeHabitTrend({ now, readings, activities });
  }

  return Object.freeze({ habitTrend });
}
