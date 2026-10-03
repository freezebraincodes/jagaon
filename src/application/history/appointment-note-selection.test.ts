import { describe, expect, it } from "vitest";
import { createMemoryOnboardingStorage } from "@/application/onboarding/demo-onboarding-repository";
import {
  APPOINTMENT_NOTE_SELECTION_KEY,
  createAppointmentNoteSelectionRepository,
} from "./appointment-note-selection";

const NOW = "2026-10-04T02:00:00.000Z";
const SELECTION = { period: "THIS_WEEK", startDate: "2026-09-28", endDate: "2026-10-04", factIds: ["READING_COUNT", "COMPARISON:BEFORE_BREAKFAST"] } as const;

describe("local appointment-note fact selection", () => {
  it("persists one exact versioned key with typed fact identifiers only", () => {
    const storage = createMemoryOnboardingStorage();
    const repository = createAppointmentNoteSelectionRepository(storage, () => NOW as never);
    expect(APPOINTMENT_NOTE_SELECTION_KEY).toBe("jagaon:appointment-note-selection:v1");
    expect(repository.save(SELECTION as never)).toEqual({ ok: true });
    expect(JSON.parse(storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)!)).toEqual({
      schemaVersion: 1,
      selections: [{ ...SELECTION, savedAt: NOW }],
    });
    expect(repository.selectedFor("THIS_WEEK", "2026-09-28")).toEqual(["READING_COUNT", "COMPARISON:BEFORE_BREAKFAST"]);
  });

  it("replaces the selection for the same period and keeps other periods", () => {
    const storage = createMemoryOnboardingStorage();
    const repository = createAppointmentNoteSelectionRepository(storage, () => NOW as never);
    repository.save(SELECTION as never);
    repository.save({ ...SELECTION, period: "LAST_WEEK", startDate: "2026-09-21", endDate: "2026-09-27", factIds: ["SOURCE"] } as never);
    repository.save({ ...SELECTION, factIds: [] } as never);
    expect(repository.selectedFor("THIS_WEEK", "2026-09-28")).toEqual([]);
    expect(repository.selectedFor("LAST_WEEK", "2026-09-21")).toEqual(["SOURCE"]);
  });

  it("rejects free text, duplicates and unknown periods without writing", () => {
    const storage = createMemoryOnboardingStorage();
    const repository = createAppointmentNoteSelectionRepository(storage, () => NOW as never);
    expect(repository.save({ ...SELECTION, factIds: ["My readings are high"] } as never)).toEqual({ ok: false, reason: "INVALID_SELECTION" });
    expect(repository.save({ ...SELECTION, factIds: ["SOURCE", "SOURCE"] } as never)).toEqual({ ok: false, reason: "INVALID_SELECTION" });
    expect(repository.save({ ...SELECTION, period: "LAST_YEAR" } as never)).toEqual({ ok: false, reason: "INVALID_SELECTION" });
    expect(storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).toBeNull();
  });

  it("clears malformed state and reports unavailable storage truthfully", () => {
    const storage = createMemoryOnboardingStorage({ [APPOINTMENT_NOTE_SELECTION_KEY]: "{not json" });
    const repository = createAppointmentNoteSelectionRepository(storage, () => NOW as never);
    expect(repository.selectedFor("THIS_WEEK", "2026-09-28")).toEqual([]);
    expect(storage.getItem(APPOINTMENT_NOTE_SELECTION_KEY)).toBeNull();
    const failing = createAppointmentNoteSelectionRepository(
      { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined },
      () => NOW as never,
    );
    expect(failing.save(SELECTION as never)).toEqual({ ok: false, reason: "STORAGE_UNAVAILABLE" });
  });
});
