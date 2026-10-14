// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createVoiceJournalSave, createVoiceSaveWithRefresh, reportedAmountTaken } from "./voice-journal-save";

const MED = { recordType: "MEDICATION", recordId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", revisionId: "7a1c2d3e-4a5b-4c6d-9e7f-0a1b2c3d4e5f" } as const;
const NOW = "2026-10-09T07:00:00.000Z" as never;
const committed = { kind: "COMMITTED", recordId: "r", revisionId: "v" } as never;

function ports() {
  const command = () => vi.fn(async (input: unknown) => (void input, committed));
  return { commands: { recordGlucose: command(), recordMeal: command() }, recordMedicationEvent: command(), now: () => NOW };
}

describe("voice intent → existing journal command (Q13-6)", () => {
  // CR-11 (owner decisions 2026-10-11): replaces the review M5 "0 < value <= 50" pin. The save path validates the shared new-entry
  // format again and stores the value formatted to one decimal; there is no 50 limit (the review contract requires "Save as shown").
  it("glucose: mmol/L, method and context unspecified, time unknown; the format is checked again and stored with one decimal (CR-11)", async () => {
    const p = ports();
    const save = createVoiceJournalSave(p);
    expect(await save({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" })).toEqual({ kind: "SAVED" });
    expect(p.commands.recordGlucose).toHaveBeenCalledWith({ payload: { measurement: { enteredValue: "6.8", enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "UNKNOWN", context: { kind: "UNSPECIFIED" } }, temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } }, recordedAt: NOW });
    for (const [valueText, stored] of [["0", "0.0"], ["0.0", "0.0"], ["9", "9.0"], ["51", "51.0"], ["60", "60.0"], ["99", "99.0"], ["100", "100.0"], ["999.5", "999.5"], ["1234.5", "1234.5"]] as const) {
      expect(await save({ kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource: "PERSON" }), valueText).toEqual({ kind: "SAVED" });
      expect((vi.mocked(p.commands.recordGlucose).mock.calls.at(-1)![0] as { payload: { measurement: { enteredValue: string } } }).payload.measurement.enteredValue, valueText).toBe(stored);
    }
    const before = vi.mocked(p.commands.recordGlucose).mock.calls.length;
    for (const valueText of ["9.25", "60.00", "6.80", "-5", "1e3", "abc", "060", "12345", ""]) expect(await save({ kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource: "PERSON" }), valueText).toEqual({ kind: "NOT_SAVED" });
    expect(p.commands.recordGlucose).toHaveBeenCalledTimes(before);
  });

  it("meal: the slot only when said, the food words exactly as said, nothing inferred", async () => {
    const p = ports();
    const save = createVoiceJournalSave(p);
    await save({ kind: "MEAL", slot: "LUNCH", itemText: "chicken rice" });
    await save({ kind: "MEAL", slot: null, itemText: null });
    expect(p.commands.recordMeal.mock.calls.map(([input]) => (input as { payload: unknown }).payload)).toEqual([
      { intakeKind: "MEAL", intakeSlot: { kind: "STANDARD_MEAL", code: "LUNCH" }, occasion: "UNKNOWN", foodIncluded: "UNKNOWN", drinkIncluded: "UNKNOWN", items: [{ kind: "UNKNOWN", label: "chicken rice" }] },
      { intakeKind: "MEAL", occasion: "UNKNOWN", foodIncluded: "UNKNOWN", drinkIncluded: "UNKNOWN", items: [] },
    ]);
  });

  it("medicine: taken (with the reported amount as said), skipped → MISSED, unknown → UNSURE; never a dose that was not said", async () => {
    const p = ports();
    const save = createVoiceJournalSave(p);
    await save({ kind: "MEDICATION_EVENT", medication: MED, status: "TAKEN", reportedAmount: null } as never);
    await save({ kind: "MEDICATION_EVENT", medication: MED, status: "TAKEN", reportedAmount: { valueText: "10", unitText: "units" } } as never);
    await save({ kind: "MEDICATION_EVENT", medication: MED, status: "SKIPPED", reportedAmount: null } as never);
    await save({ kind: "MEDICATION_EVENT", medication: MED, status: "UNKNOWN", reportedAmount: null } as never);
    expect(p.recordMedicationEvent.mock.calls.map(([input]) => (input as { payload: unknown }).payload)).toEqual([
      { medication: MED, state: "TAKEN", amountTaken: { kind: "NOT_RECORDED" } },
      { medication: MED, state: "TAKEN", amountTaken: { kind: "KNOWN", amount: { value: "10", unit: "UNIT" } } },
      { medication: MED, state: "MISSED", intendedOccasion: { expectedAt: { kind: "UNKNOWN" } } },
      { medication: MED, state: "UNSURE", intendedOccasion: { expectedAt: { kind: "UNKNOWN" } } },
    ]);
  });

  it("maps spoken unit words by a fixed table and keeps any other word verbatim", () => {
    expect(reportedAmountTaken({ valueText: "2", unitText: "tablets" })).toEqual({ kind: "KNOWN", amount: { value: "2", unit: "TABLET" } });
    expect(reportedAmountTaken({ valueText: "10", unitText: "个单位" })).toEqual({ kind: "KNOWN", amount: { value: "10", unit: "UNIT" } });
    expect(reportedAmountTaken({ valueText: "1", unitText: "pens" })).toEqual({ kind: "KNOWN", amount: { value: "1", unit: "OTHER", otherUnitText: "pens" } });
    expect(reportedAmountTaken({ valueText: "abc", unitText: "units" })).toEqual({ kind: "NOT_RECORDED" });
    expect(reportedAmountTaken(null)).toEqual({ kind: "NOT_RECORDED" });
  });

  it("a failed or throwing command is NOT_SAVED", async () => {
    const save = createVoiceJournalSave({ commands: { recordGlucose: async () => ({ kind: "FAILED", code: "VALIDATION_FAILED" }), recordMeal: async () => { throw new Error("x"); } }, recordMedicationEvent: async () => committed, now: () => NOW });
    expect(await save({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" })).toEqual({ kind: "NOT_SAVED" });
    expect(await save({ kind: "MEAL", slot: null, itemText: "rice" })).toEqual({ kind: "NOT_SAVED" });
  });

  it("review I-4: 粒 is never guessed as a capsule; it is kept verbatim as OTHER", () => {
    expect(reportedAmountTaken({ valueText: "2", unitText: "粒" })).toEqual({ kind: "KNOWN", amount: { value: "2", unit: "OTHER", otherUnitText: "粒" } });
    expect(reportedAmountTaken({ valueText: "2", unitText: "胶囊" })).toEqual({ kind: "KNOWN", amount: { value: "2", unit: "CAPSULE" } });
  });

  it("review I-3: the save outcome is independent of the refresh; a failed refresh after a committed save still reports SAVED", async () => {
    const intent = { kind: "MEAL", slot: null, itemText: "laksa" } as const;
    const refresh = vi.fn(async () => {
      throw new Error("TEST-ONLY refresh failure");
    });
    const saved = createVoiceSaveWithRefresh(async () => ({ kind: "SAVED" }), refresh);
    expect(await saved(intent)).toEqual({ kind: "SAVED" });
    expect(refresh).toHaveBeenCalledTimes(1);
    const syncThrow = createVoiceSaveWithRefresh(async () => ({ kind: "SAVED" }), () => {
      throw new Error("TEST-ONLY sync refresh failure");
    });
    expect(await syncThrow(intent)).toEqual({ kind: "SAVED" });
    const notSaved = vi.fn();
    expect(await createVoiceSaveWithRefresh(async () => ({ kind: "NOT_SAVED" }), notSaved)(intent)).toEqual({ kind: "NOT_SAVED" });
    expect(notSaved).not.toHaveBeenCalled();
  });
});

describe("owner decision 2026-10-14: a feeling saved as a note, an activity to the activity log", () => {
  it("FEELING_NOTE → createPersonalNote with her words, the cues, the reviewed kind sentence and no AI", async () => {
    const p = ports();
    const createPersonalNote = vi.fn(async (input: unknown) => (void input, { kind: "COMMITTED", recordId: "r", revisionId: "v" }) as never);
    const save = createVoiceJournalSave({ ...p, notes: { createPersonalNote } });
    expect(await save({ kind: "FEELING_NOTE", text: "Feeling tired and a bit worried today.", cueKeys: ["tired", "worried"] })).toEqual({ kind: "SAVED" });
    expect(createPersonalNote).toHaveBeenCalledWith({
      payload: {
        text: "Feeling tired and a bit worried today.",
        language: "en-SG",
        feelingCues: ["tired", "worried"],
        turns: [
          { role: "PATIENT", text: "Feeling tired and a bit worried today.", source: "PATIENT" },
          { role: "JAGAON_KIND_SENTENCE", text: "That sounds like a tiring day. Thank you for telling me.", source: "REVIEWED_BANK" },
        ],
        themes: [],
        aiUsed: false,
        promptVersion: null,
        careQuestionRef: null,
      },
    });
    for (const command of [p.commands.recordGlucose, p.commands.recordMeal, p.recordMedicationEvent]) expect(command).not.toHaveBeenCalled();
    createPersonalNote.mockResolvedValueOnce({ kind: "FAILED", code: "COMMIT_FAILED" } as never);
    expect(await save({ kind: "FEELING_NOTE", text: "Tired", cueKeys: ["tired"] })).toEqual({ kind: "NOT_SAVED" });
    createPersonalNote.mockRejectedValueOnce(new Error("storage"));
    expect(await save({ kind: "FEELING_NOTE", text: "Tired", cueKeys: ["tired"] })).toEqual({ kind: "NOT_SAVED" });
    // Without the notes port nothing is saved.
    expect(await createVoiceJournalSave(p)({ kind: "FEELING_NOTE", text: "Tired", cueKeys: ["tired"] })).toEqual({ kind: "NOT_SAVED" });
  });

  it("ACTIVITY → recordActivity with the category, her label, the duration only when said, and an unknown time", async () => {
    const p = ports();
    const recordActivity = vi.fn(async (input: unknown) => (void input, committed));
    const save = createVoiceJournalSave({ ...p, recordActivity });
    expect(await save({ kind: "ACTIVITY", category: "WALKING", label: "Walked 30 minutes after dinner", durationMinutes: 30 })).toEqual({ kind: "SAVED" });
    expect(await save({ kind: "ACTIVITY", category: "HOUSEHOLD_ACTIVITY", label: "Cleaned the house", durationMinutes: null })).toEqual({ kind: "SAVED" });
    expect(recordActivity.mock.calls.map(([input]) => input)).toEqual([
      { payload: { activityCategory: "WALKING", patientLabel: "Walked 30 minutes after dinner", reportedDurationMinutes: 30 }, temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } }, recordedAt: NOW },
      { payload: { activityCategory: "HOUSEHOLD_ACTIVITY", patientLabel: "Cleaned the house" }, temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } }, recordedAt: NOW },
    ]);
    expect(await createVoiceJournalSave(p)({ kind: "ACTIVITY", category: "WALKING", label: "Walked", durationMinutes: null })).toEqual({ kind: "NOT_SAVED" });
  });
});
