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
  it("glucose: mmol/L, method and context unspecified, time unknown; the manual range check is kept (review M5)", async () => {
    const p = ports();
    const save = createVoiceJournalSave(p);
    expect(await save({ kind: "GLUCOSE", valueText: "6.8", unit: "MMOL_PER_L", unitSource: "SPOKEN" })).toEqual({ kind: "SAVED" });
    expect(p.commands.recordGlucose).toHaveBeenCalledWith({ payload: { measurement: { enteredValue: "6.8", enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "UNKNOWN", context: { kind: "UNSPECIFIED" } }, temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } }, recordedAt: NOW });
    for (const valueText of ["0", "0.0", "51", "99"]) expect(await save({ kind: "GLUCOSE", valueText, unit: "MMOL_PER_L", unitSource: "PERSON" }), valueText).toEqual({ kind: "NOT_SAVED" });
    expect(p.commands.recordGlucose).toHaveBeenCalledTimes(1);
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
