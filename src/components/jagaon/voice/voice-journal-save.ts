import type { JournalCommandService, JournalCommitResult, RecordMedicationEventInput } from "@/application/journal/journal-contracts";
import type { VoiceSaveIntent } from "@/application/voice/voice-review-contract";
import type { DecimalString } from "@/domain/health-records/measurement";
import type { Instant } from "@/domain/shared/time";
import type { VoiceSaveOutcome } from "./TellJagaOnScreen";

/**
 * Packet 13 (P13S; Q13-6): one explicitly confirmed voice fact → the EXISTING journal command, with the existing validation unchanged.
 * - GLUCOSE → `recordGlucose`: mmol/L, the same plausible range as manual entry (0 < value ≤ 50; review M5), method UNKNOWN, context
 *   UNSPECIFIED (the person did not pick one), occurrence time UNKNOWN (never inferred).
 * - MEAL → `recordMeal`: intake MEAL, the standard slot only when said, the food words exactly as said (item kind UNKNOWN: food or drink
 *   is not inferred), occasion UNKNOWN, occurrence time UNKNOWN.
 * - MEDICATION_EVENT → `recordMedicationEvent`: TAKEN, SKIPPED → MISSED, UNKNOWN → UNSURE, each for the confirmed canonical
 *   medicine, occurrence and expected time UNKNOWN. A TAKEN event stores the amount the person REPORTED (owner decision #4) exactly as
 *   said: the value as spoken and the unit by a fixed word table (units → UNIT, tablet → TABLET, capsule → CAPSULE, mg → MG, ml → ML),
 *   any other unit word kept verbatim as OTHER. Without a reported amount it is NOT_RECORDED: no dose is ever added. MISSED and UNSURE
 *   have no amount field, so the screen says the amount will not be saved (`reportedAmountSaved` covers TAKEN only).
 * Never called without the person's explicit Save (the screen calls it once per confirmed fact).
 */
export type VoiceJournalSavePorts = Readonly<{
  commands: Pick<JournalCommandService, "recordGlucose" | "recordMeal">;
  recordMedicationEvent: (input: RecordMedicationEventInput) => Promise<JournalCommitResult>;
  now: () => Instant;
}>;

/** Spoken unit words → the journal's dose units (exact words only; anything else is kept verbatim as OTHER). */
const DOSE_UNITS: Readonly<Record<string, "UNIT" | "TABLET" | "CAPSULE" | "MG" | "ML">> = Object.freeze({
  unit: "UNIT", units: "UNIT", 单位: "UNIT", 个单位: "UNIT",
  tablet: "TABLET", tablets: "TABLET", 片: "TABLET",
  // Review I-4 (owner: "do not guess units"): 粒 is a counter for pills or capsules alike, so it is kept verbatim as OTHER.
  capsule: "CAPSULE", capsules: "CAPSULE", 胶囊: "CAPSULE",
  mg: "MG", milligram: "MG", milligrams: "MG", 毫克: "MG",
  ml: "ML", millilitre: "ML", milliliter: "ML", millilitres: "ML", milliliters: "ML", 毫升: "ML",
});

type AmountTaken = Extract<RecordMedicationEventInput["payload"], { state: "TAKEN" }>["amountTaken"];
export function reportedAmountTaken(amount: Readonly<{ valueText: string; unitText: string }> | null | undefined): AmountTaken {
  if (!amount || !/^\d{1,4}(?:\.\d{1,2})?$/.test(amount.valueText) || amount.unitText.trim().length === 0) return { kind: "NOT_RECORDED" };
  const unit = DOSE_UNITS[amount.unitText.trim().toLowerCase()];
  const value = amount.valueText as DecimalString;
  return unit ? { kind: "KNOWN", amount: { value, unit } } : { kind: "KNOWN", amount: { value, unit: "OTHER", otherUnitText: amount.unitText.trim() } };
}

const UNKNOWN_POINT = Object.freeze({ kind: "POINT" as const, occurrence: Object.freeze({ kind: "UNKNOWN" as const }) });
const GLUCOSE_VALUE = /^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/;

export function createVoiceJournalSave(ports: VoiceJournalSavePorts): (intent: VoiceSaveIntent) => Promise<VoiceSaveOutcome> {
  return async function save(intent: VoiceSaveIntent): Promise<VoiceSaveOutcome> {
    let result: JournalCommitResult;
    try {
      const recordedAt = ports.now();
      if (intent.kind === "GLUCOSE") {
        const value = Number(intent.valueText);
        if (!GLUCOSE_VALUE.test(intent.valueText) || !(value > 0 && value <= 50)) return { kind: "NOT_SAVED" };
        result = await ports.commands.recordGlucose({
          payload: { measurement: { enteredValue: intent.valueText as DecimalString, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "UNKNOWN", context: { kind: "UNSPECIFIED" } },
          temporal: UNKNOWN_POINT,
          recordedAt,
        });
      } else if (intent.kind === "MEAL") {
        result = await ports.commands.recordMeal({
          payload: {
            intakeKind: "MEAL",
            ...(intent.slot ? { intakeSlot: { kind: "STANDARD_MEAL" as const, code: intent.slot } } : {}),
            occasion: "UNKNOWN",
            foodIncluded: "UNKNOWN",
            drinkIncluded: "UNKNOWN",
            items: intent.itemText ? [{ kind: "UNKNOWN", label: intent.itemText }] : [],
          },
          temporal: UNKNOWN_POINT,
          recordedAt,
        });
      } else {
        const medication = { recordType: "MEDICATION" as const, recordId: intent.medication.recordId, revisionId: intent.medication.revisionId } as RecordMedicationEventInput["payload"]["medication"];
        const occasion = { expectedAt: { kind: "UNKNOWN" as const } };
        const payload: RecordMedicationEventInput["payload"] =
          intent.status === "TAKEN"
            ? { medication, state: "TAKEN", amountTaken: reportedAmountTaken((intent as { reportedAmount?: { valueText: string; unitText: string } | null }).reportedAmount) }
            : { medication, state: intent.status === "SKIPPED" ? "MISSED" : "UNSURE", intendedOccasion: occasion };
        result = await ports.recordMedicationEvent({ payload, temporal: UNKNOWN_POINT, recordedAt });
      }
    } catch {
      return { kind: "NOT_SAVED" };
    }
    return result.kind === "COMMITTED" ? { kind: "SAVED" } : { kind: "NOT_SAVED" };
  };
}

/**
 * Review I-3: the save outcome never depends on what happens after it. `save` decides SAVED or NOT_SAVED; only after a SAVED outcome is
 * `refresh` called (for example to reload the app's journal views), and any refresh failure is swallowed without data (the record is
 * committed, so reporting "not saved" would invite a duplicate retry). The app wires this around `createVoiceJournalSave`.
 */
export function createVoiceSaveWithRefresh(save: (intent: VoiceSaveIntent) => Promise<VoiceSaveOutcome>, refresh: () => unknown): (intent: VoiceSaveIntent) => Promise<VoiceSaveOutcome> {
  return async function saveThenRefresh(intent: VoiceSaveIntent): Promise<VoiceSaveOutcome> {
    const outcome = await save(intent);
    if (outcome.kind === "SAVED") {
      try {
        await refresh();
      } catch {
        // Swallowed on purpose: the fact is committed; nothing about it is logged.
      }
    }
    return outcome;
  };
}
