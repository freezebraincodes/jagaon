import type { Instant } from "@/domain/shared/time";
import type { JournalCommandService, JournalCommitResult } from "@/application/journal/journal-contracts";

/**
 * Deterministic synthetic history for the Packet 7A Recorded-history demo.
 *
 * The plan is a pure function of the seed instant: 42 local days of
 * before-breakfast and before-dinner readings with deliberate gaps, routine
 * meals, walks and one corrected reading time. It is written only through
 * the journal command boundary, never as unchecked rows, and only into an
 * empty demo database. All values are synthetic and carry no clinical meaning.
 */

const HOME_OFFSET_MINUTES = 480;
const DAY_MS = 86_400_000;
const SEED_DAYS = 42;

const REFERENCE_BREAKFAST = ["5.9", "6.2", "6.0", "5.8", "6.3", "6.1", "5.7"];
const RECENT_BREAKFAST = ["7.1", "7.4", "7.0", "7.6", "7.2", "7.5", "7.3"];
const DINNER = ["7.9", "8.2", "7.8", "8.4", "8.0", "7.7", "8.3"];

export type SyntheticHistoryEntry =
  | {
      kind: "GLUCOSE";
      occurredAt: Instant;
      value: string;
      slot: "BEFORE_BREAKFAST" | "BEFORE_DINNER";
      /** The time the patient later corrected the entry to. */
      correctedTo?: Instant;
    }
  | { kind: "MEAL"; occurredAt: Instant; label: string; slot: "BREAKFAST" | "LUNCH" }
  | { kind: "ACTIVITY"; occurredAt: Instant; label: string; durationMinutes: number };

function localInstant(seedAt: Instant, daysBefore: number, hour: number, minute: number): Instant {
  const localNow = new Date(Date.parse(seedAt) + HOME_OFFSET_MINUTES * 60_000);
  const localMidnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  return new Date(localMidnight - daysBefore * DAY_MS + (hour * 60 + minute - HOME_OFFSET_MINUTES) * 60_000).toISOString() as Instant;
}

export function planSyntheticHistory(seedAt: Instant): SyntheticHistoryEntry[] {
  const entries: SyntheticHistoryEntry[] = [];
  for (let d = SEED_DAYS - 1; d >= 0; d -= 1) {
    if (d % 9 !== 4) {
      const correcting = d === 2;
      entries.push({
        kind: "GLUCOSE",
        occurredAt: localInstant(seedAt, d, 7, correcting ? 25 : 40 + (d % 3) * 5),
        value: d >= 14 ? REFERENCE_BREAKFAST[d % 7]! : RECENT_BREAKFAST[d % 7]!,
        slot: "BEFORE_BREAKFAST",
        ...(correcting ? { correctedTo: localInstant(seedAt, d, 7, 40) } : {}),
      });
    }
    if (d % 5 !== 2) {
      entries.push({ kind: "GLUCOSE", occurredAt: localInstant(seedAt, d, 18, 30), value: DINNER[d % 7]!, slot: "BEFORE_DINNER" });
    }
    if (d <= 20 && d % 2 === 0) entries.push({ kind: "MEAL", occurredAt: localInstant(seedAt, d, 8, 10), label: "Kaya toast", slot: "BREAKFAST" });
    if (d <= 20 && d % 3 === 0) entries.push({ kind: "MEAL", occurredAt: localInstant(seedAt, d, 12, 30), label: "Chicken rice", slot: "LUNCH" });
    if (d <= 13 && d % 3 !== 2) {
      entries.push({ kind: "ACTIVITY", occurredAt: localInstant(seedAt, d, 9, 0), label: "Morning walk", durationMinutes: 28 });
    }
  }
  return entries
    .filter((entry) => Date.parse(entry.occurredAt) < Date.parse(seedAt))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
}

function point(instant: Instant) {
  return {
    kind: "POINT" as const,
    occurrence: { kind: "EXACT" as const, instantUtc: instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: HOME_OFFSET_MINUTES },
  };
}

function recordedAfter(occurredAt: Instant, seedAt: Instant): Instant {
  return new Date(Math.min(Date.parse(occurredAt) + 5 * 60_000, Date.parse(seedAt))).toISOString() as Instant;
}

function committed(result: JournalCommitResult): Extract<JournalCommitResult, { kind: "COMMITTED" }> {
  if (result.kind !== "COMMITTED") throw new Error("SYNTHETIC_SCENARIO_BOOTSTRAP_FAILED");
  return result;
}

export async function seedSyntheticHistory(commands: JournalCommandService, seedAt: Instant): Promise<{ committed: number }> {
  let count = 0;
  for (const entry of planSyntheticHistory(seedAt)) {
    const recordedAt = recordedAfter(entry.occurredAt, seedAt);
    if (entry.kind === "GLUCOSE") {
      const payload = {
        measurement: { enteredValue: entry.value as never, enteredUnit: "MMOL_L" as const, normalization: null },
        measurementMethod: "FINGERSTICK_METER" as const,
        context: { kind: "PATIENT_SELECTED_SLOT" as const, slot: entry.slot },
      };
      const result = committed(await commands.recordGlucose({ payload, temporal: point(entry.occurredAt), recordedAt }));
      count += 1;
      if (entry.correctedTo) {
        committed(
          await commands.correctGlucoseTime({
            recordId: result.recordId,
            expectedRevisionId: result.revisionId,
            expectedRevisionNumber: 1,
            payload,
            temporal: point(entry.correctedTo),
            recordedAt,
          }),
        );
        count += 1;
      }
    } else if (entry.kind === "MEAL") {
      committed(
        await commands.recordMeal({
          payload: {
            intakeKind: "MEAL",
            intakeSlot: { kind: "STANDARD_MEAL", code: entry.slot },
            occasion: "ROUTINE",
            foodIncluded: "YES",
            drinkIncluded: "UNKNOWN",
            items: [{ kind: "FOOD", label: entry.label }],
          },
          temporal: point(entry.occurredAt),
          recordedAt,
        }),
      );
      count += 1;
    } else {
      committed(
        await commands.recordActivity({
          payload: { activityCategory: "WALKING", patientLabel: entry.label, reportedDurationMinutes: entry.durationMinutes },
          temporal: point(entry.occurredAt) as never,
          recordedAt,
        }),
      );
      count += 1;
    }
  }
  return { committed: count };
}
