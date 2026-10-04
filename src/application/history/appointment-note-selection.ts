import { z } from "zod";
import { instantSchema, localDateSchema, type Instant } from "@/domain/shared/time";
import type { DemoOnboardingStoragePort } from "@/application/onboarding/demo-onboarding-repository";
import { HISTORY_PERIODS, type HistoryPeriod } from "./recorded-history-contracts";

/**
 * Local, user-initiated selection of descriptive Recorded-history facts for
 * later Packet 9 appointment notes. It stores typed fact identifiers and the
 * period only: no wording, values or summary, and nothing is sent anywhere.
 * Uses the same injectable storage port as the Packet 6A demo state.
 */

export const APPOINTMENT_NOTE_SELECTION_KEY = "jagaon:appointment-note-selection:v1";
const MAX_SELECTIONS = 24;

const factIdSchema = z.string().max(160).regex(/^[A-Z_]+(:[A-Za-z0-9._-]+)?$/);

const selectionSchema = z.strictObject({
  period: z.enum(HISTORY_PERIODS),
  startDate: localDateSchema,
  endDate: localDateSchema,
  factIds: z.array(factIdSchema).max(64).refine((ids) => new Set(ids).size === ids.length, "DUPLICATE_FACT_ID"),
});

const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  selections: z.array(selectionSchema.extend({ savedAt: instantSchema })).max(MAX_SELECTIONS),
});

export type AppointmentNoteSelection = z.infer<typeof selectionSchema>;
export type AppointmentNoteSaveResult = { ok: true } | { ok: false; reason: "INVALID_SELECTION" | "STORAGE_UNAVAILABLE" };

export type AppointmentNoteSelectionRepository = {
  selectedFor(period: HistoryPeriod, startDate: string): string[];
  save(selection: AppointmentNoteSelection): AppointmentNoteSaveResult;
  /** Reports whether the stored selection is gone, so delete-all never over-claims. */
  clear(): { ok: true } | { ok: false; reason: "STORAGE_UNAVAILABLE" };
};

export function createAppointmentNoteSelectionRepository(
  storage: DemoOnboardingStoragePort,
  now: () => Instant,
): AppointmentNoteSelectionRepository {
  function read(): z.infer<typeof stateSchema> {
    let raw: string | null;
    try {
      raw = storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY);
    } catch {
      return { schemaVersion: 1, selections: [] };
    }
    if (raw === null) return { schemaVersion: 1, selections: [] };
    try {
      const parsed = stateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Malformed JSON falls through to removal.
    }
    try {
      storage.removeItem(APPOINTMENT_NOTE_SELECTION_KEY);
    } catch {
      // Unavailable storage leaves nothing more to do.
    }
    return { schemaVersion: 1, selections: [] };
  }

  return Object.freeze({
    selectedFor(period: HistoryPeriod, startDate: string): string[] {
      return read().selections.find((entry) => entry.period === period && entry.startDate === startDate)?.factIds ?? [];
    },
    save(selection: AppointmentNoteSelection): AppointmentNoteSaveResult {
      const parsed = selectionSchema.safeParse(selection);
      if (!parsed.success) return { ok: false, reason: "INVALID_SELECTION" };
      const current = read().selections.filter(
        (entry) => !(entry.period === parsed.data.period && entry.startDate === parsed.data.startDate),
      );
      const next = stateSchema.safeParse({
        schemaVersion: 1,
        selections: [...current, { ...parsed.data, savedAt: now() }].slice(-MAX_SELECTIONS),
      });
      if (!next.success) return { ok: false, reason: "INVALID_SELECTION" };
      try {
        storage.setItem(APPOINTMENT_NOTE_SELECTION_KEY, JSON.stringify(next.data));
        return { ok: true };
      } catch {
        return { ok: false, reason: "STORAGE_UNAVAILABLE" };
      }
    },
    clear() {
      try {
        storage.removeItem(APPOINTMENT_NOTE_SELECTION_KEY);
        // Corrective Pass C: success means the key is confirmed absent.
        if (storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY) !== null) return { ok: false as const, reason: "STORAGE_UNAVAILABLE" as const };
        return { ok: true as const };
      } catch {
        return { ok: false as const, reason: "STORAGE_UNAVAILABLE" as const };
      }
    },
  });
}
