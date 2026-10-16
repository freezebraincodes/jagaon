import type { JagaOnDatabase } from "@/storage/database";
import type { Instant, LocalDate } from "@/domain/shared/time";
import type { RecordHead } from "@/domain/shared";
import type { GlucoseReadingPayload } from "@/domain/health-records/glucose-reading";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { MedicationRevision } from "@/domain/care-plan/care-plan-revisions";
import { validatePacket6StoredRevision } from "@/application/journal/journal-row-codecs";
import { carePlanRevisionRowCodec } from "@/application/care-plan/care-plan-persistence";
import { historyRange } from "@/application/history/recorded-history-query";
import type { HistoryPeriod } from "@/application/history/recorded-history-contracts";

/**
 * Owner decision 2026-10-16: the Booklet tab is a read-only table laid out like a paper glucose diary. One row per day (newest first)
 * for the chosen period; each reading sits in the column of the meal time she chose (before or after breakfast, lunch or dinner, or
 * bedtime). Meals, medicines, activity and readings without a meal time go in that day's notes, in time order. Nothing is
 * calculated, compared, coloured or written by AI: the table only places what she recorded.
 */

export const BOOKLET_COLUMNS = [
  "BREAKFAST_BEFORE",
  "BREAKFAST_AFTER",
  "LUNCH_BEFORE",
  "LUNCH_AFTER",
  "DINNER_BEFORE",
  "DINNER_AFTER",
  "BEDTIME",
] as const;
export type BookletColumn = (typeof BOOKLET_COLUMNS)[number];

export type BookletReading = { value: string; unit: "mmol/L" | "mg/dL"; at: Instant | null };

export type BookletNote =
  | { kind: "READING"; at: Instant | null; value: string; unit: "mmol/L" | "mg/dL" }
  | { kind: "MEAL"; at: Instant | null; label: string }
  | { kind: "ACTIVITY"; at: Instant | null; label: string; minutes: number | null }
  | { kind: "MEDICINE"; at: Instant | null; name: string; state: MedicationEventPayload["state"] };

export type BookletDay = { date: LocalDate; readings: Record<BookletColumn, BookletReading[]>; notes: BookletNote[] };

export type BookletView =
  | { status: "READY"; period: HistoryPeriod; today: LocalDate; range: { startDate: LocalDate; endDate: LocalDate }; days: BookletDay[] }
  | { status: "UNAVAILABLE" };

export type BookletQueryPort = { load(request: { period: HistoryPeriod }): Promise<BookletView> };

/** Singapore has a fixed +08:00 offset; the demo's home timezone. */
const HOME_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** The patient's own meal-time choice, as the column a paper booklet would use. A fasting reading is written before breakfast. */
const COLUMN_BY_SLOT: Readonly<Record<string, BookletColumn>> = Object.freeze({
  FASTING: "BREAKFAST_BEFORE",
  BEFORE_BREAKFAST: "BREAKFAST_BEFORE",
  AFTER_BREAKFAST: "BREAKFAST_AFTER",
  BEFORE_LUNCH: "LUNCH_BEFORE",
  AFTER_LUNCH: "LUNCH_AFTER",
  BEFORE_DINNER: "DINNER_BEFORE",
  AFTER_DINNER: "DINNER_AFTER",
  BEDTIME: "BEDTIME",
});

function localDate(instant: string): LocalDate {
  return new Date(Date.parse(instant) + HOME_OFFSET_MS).toISOString().slice(0, 10) as LocalDate;
}

/** An exact or approximate occurrence instant, or null when she did not give a time. */
function occurrenceAt(temporal: unknown): Instant | null {
  const t = temporal as { kind?: string; occurrence?: { kind?: string; instantUtc?: string; approximateInstantUtc?: string }; start?: { kind?: string; instantUtc?: string; approximateInstantUtc?: string } };
  const point = t.kind === "POINT" ? t.occurrence : t.kind === "INTERVAL" ? t.start : undefined;
  if (point?.kind === "EXACT" && point.instantUtc) return point.instantUtc as Instant;
  if (point?.kind === "APPROXIMATE" && point.approximateInstantUtc) return point.approximateInstantUtc as Instant;
  return null;
}

function emptyReadings(): Record<BookletColumn, BookletReading[]> {
  return Object.fromEntries(BOOKLET_COLUMNS.map((column) => [column, []])) as unknown as Record<BookletColumn, BookletReading[]>;
}

function byTime<T extends { at: Instant | null }>(a: T, b: T): number {
  if (a.at === b.at) return 0;
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return a.at < b.at ? -1 : 1;
}

export function createBookletQuery(database: JagaOnDatabase, dependencies: { now(): Instant }): BookletQueryPort {
  async function medicineNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const heads = (await database.table("recordHeads").where("recordType").equals("MEDICATION").toArray()) as RecordHead[];
    for (const head of heads.filter((candidate) => candidate.state === "ACTIVE")) {
      const revision = carePlanRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(head.headRevisionId)).revision as MedicationRevision;
      names.set(head.recordId, revision.payload.identity.patientEnteredName);
    }
    return names;
  }

  async function load(request: { period: HistoryPeriod }): Promise<BookletView> {
    try {
      const now = dependencies.now();
      const range = historyRange(request.period, now);
      const days = new Map<string, BookletDay>();
      for (let at = Date.parse(`${range.endDate}T00:00:00Z`); at >= Date.parse(`${range.startDate}T00:00:00Z`); at -= DAY_MS) {
        const date = new Date(at).toISOString().slice(0, 10) as LocalDate;
        days.set(date, { date, readings: emptyReadings(), notes: [] });
      }

      const names = await medicineNames();
      const heads = (await database.table("recordHeads").toArray()) as RecordHead[];
      const kinds = new Set(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT"]);
      for (const head of heads) {
        if (head.state !== "ACTIVE" || !kinds.has(head.recordType)) continue;
        const stored = validatePacket6StoredRevision(await database.table("recordRevisions").get(head.headRevisionId));
        const revision = stored.revision as { payload: unknown; temporal: unknown };
        let at = occurrenceAt(revision.temporal);
        if (stored.recordType === "MEDICATION_EVENT") {
          const expected = (revision.payload as MedicationEventPayload).intendedOccasion?.expectedAt;
          if (at === null && expected?.kind === "EXACT") at = expected.instantUtc as Instant;
        }
        const day = days.get(localDate(at ?? stored.recordedAt));
        if (!day) continue;

        if (stored.recordType === "GLUCOSE_READING") {
          const payload = revision.payload as GlucoseReadingPayload;
          const reading = { value: payload.measurement.enteredValue, unit: payload.measurement.enteredUnit === "MMOL_L" ? ("mmol/L" as const) : ("mg/dL" as const), at };
          const column = payload.context.kind === "PATIENT_SELECTED_SLOT" ? COLUMN_BY_SLOT[payload.context.slot] : undefined;
          if (column) day.readings[column].push(reading);
          else day.notes.push({ kind: "READING", ...reading });
        } else if (stored.recordType === "INTAKE_EVENT") {
          const items = (revision.payload as { items?: Array<{ label?: string }> }).items ?? [];
          const label = items.map((item) => item.label).filter((item): item is string => Boolean(item)).join(", ");
          day.notes.push({ kind: "MEAL", at, label });
        } else if (stored.recordType === "ACTIVITY_EVENT") {
          const payload = revision.payload as { patientLabel?: string; reportedDurationMinutes?: number };
          day.notes.push({ kind: "ACTIVITY", at, label: payload.patientLabel ?? "", minutes: payload.reportedDurationMinutes ?? null });
        } else {
          const payload = revision.payload as MedicationEventPayload;
          day.notes.push({ kind: "MEDICINE", at, name: names.get(payload.medication.recordId) ?? "", state: payload.state });
        }
      }

      for (const day of days.values()) {
        for (const column of BOOKLET_COLUMNS) day.readings[column].sort(byTime);
        day.notes.sort(byTime);
      }
      return { status: "READY", period: request.period, today: localDate(now), range, days: [...days.values()] };
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }

  return Object.freeze({ load });
}
