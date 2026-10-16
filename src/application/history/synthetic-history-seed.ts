import type { Instant } from "@/domain/shared/time";
import type { JournalCommandService, JournalCommitResult } from "@/application/journal/journal-contracts";
import { PREPARED_DEMO_HISTORY_ROWS, type PreparedDemoHistoryRow } from "./prepared-demo-history-data";

/**
 * Deterministic synthetic history for the prepared demo profile (Packet 7A Recorded history; owner instruction 2026-10-12).
 *
 * The entries come from the static data set in `prepared-demo-history-data.ts` (fixed values and varied, fixed local times); each row's
 * `daysAgo` and local time are placed relative to the LOCAL Singapore date of the seed instant (the moment the profile is prepared), so
 * the newest entry is always yesterday and nothing is dated today or later. It is written only through the journal command boundary,
 * never as unchecked rows, and only into an empty demo database. All values are synthetic and carry no clinical meaning.
 */

const HOME_OFFSET_MINUTES = 480;
const DAY_MS = 86_400_000;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type SyntheticHistoryEntry =
  | {
      kind: "GLUCOSE";
      occurredAt: Instant;
      value: string;
      slot: "BEFORE_BREAKFAST" | "AFTER_BREAKFAST" | "AFTER_LUNCH" | "BEFORE_DINNER" | "AFTER_DINNER";
      /** The time the patient later corrected the entry to. */
      correctedTo?: Instant;
    }
  | { kind: "MEAL"; occurredAt: Instant; label: string; slot: "BREAKFAST" | "LUNCH" | "DINNER" }
  | { kind: "ACTIVITY"; occurredAt: Instant; label: string; durationMinutes: number; category: "WALKING" | "FLEXIBILITY_OR_MOBILITY" };

/** Local midnight (as a UTC instant in ms) of the seed instant's Singapore date. */
function localMidnightMs(seedAt: Instant): number {
  const localNow = new Date(Date.parse(seedAt) + HOME_OFFSET_MINUTES * 60_000);
  return Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - HOME_OFFSET_MINUTES * 60_000;
}

/** The exact instant of local `time` on the Singapore date `daysAgo` days before the seed instant's local date. */
function localInstant(seedAt: Instant, daysAgo: number, time: string): Instant {
  const match = LOCAL_TIME.exec(time);
  if (!Number.isInteger(daysAgo) || daysAgo < 1 || !match) throw new Error("SYNTHETIC_SCENARIO_DATA_INVALID");
  return new Date(localMidnightMs(seedAt) - daysAgo * DAY_MS + (Number(match[1]) * 60 + Number(match[2])) * 60_000).toISOString() as Instant;
}

function entryOf(row: PreparedDemoHistoryRow, seedAt: Instant): SyntheticHistoryEntry {
  const occurredAt = localInstant(seedAt, row.daysAgo, row.time);
  if (row.kind === "GLUCOSE") {
    return { kind: "GLUCOSE", occurredAt, value: row.value, slot: row.slot, ...(row.correctedTime ? { correctedTo: localInstant(seedAt, row.daysAgo, row.correctedTime) } : {}) };
  }
  if (row.kind === "MEAL") return { kind: "MEAL", occurredAt, label: row.label, slot: row.slot };
  return { kind: "ACTIVITY", occurredAt, label: row.label, durationMinutes: row.durationMinutes, category: row.category ?? "WALKING" };
}

export function planSyntheticHistory(seedAt: Instant, rows: readonly PreparedDemoHistoryRow[] = PREPARED_DEMO_HISTORY_ROWS): SyntheticHistoryEntry[] {
  // Nothing is dated on the seed's local day or later (and so never after the seed instant): `daysAgo` is at least 1.
  return rows
    .map((row) => entryOf(row, seedAt))
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
          payload: { activityCategory: entry.category, patientLabel: entry.label, reportedDurationMinutes: entry.durationMinutes },
          temporal: point(entry.occurredAt) as never,
          recordedAt,
        }),
      );
      count += 1;
    }
  }
  return { committed: count };
}
