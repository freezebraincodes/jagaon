import type { JournalCommandService, JournalCommitResult, RecordActivityInput, RecordMedicationEventInput } from "@/application/journal/journal-contracts";
import type { PersonalNoteCommandService } from "@/application/notes/personal-note-service";
import type { VoiceSaveIntent } from "@/application/voice/voice-review-contract";
import type { DecimalString } from "@/domain/health-records/measurement";
import { noteKindSentenceFor } from "@/domain/notes/note-kind-sentences";
import { formatMmolEntry, isFormattedMmolEntry } from "@/domain/voice/glucose-entry-format";
import type { Instant } from "@/domain/shared/time";
import type { VoiceSaveOutcome } from "./TellJagaOnScreen";

/**
 * Packet 13 (P13S; Q13-6): one explicitly confirmed voice fact → the EXISTING journal command, with the existing validation unchanged.
 * - GLUCOSE → `recordGlucose`: mmol/L, method UNKNOWN, context UNSPECIFIED (the person did not pick one), occurrence time UNKNOWN (never
 *   inferred). CR-11 (2026-10-11): the value is validated again with the same new-entry format as manual entry (1–4 integer digits, at
 *   most one decimal; never rounded) and stored formatted to exactly one decimal ("60.0", "0.0"). There is no 50 mmol/L limit: the
 *   review contract has already required the explicit "Save as shown" above 50 or at zero.
 * - MEAL → `recordMeal`: intake MEAL, the standard slot only when said, the food words exactly as said (item kind UNKNOWN: food or drink
 *   is not inferred), occasion UNKNOWN, occurrence time UNKNOWN.
 * - MEDICATION_EVENT → `recordMedicationEvent`: TAKEN, SKIPPED → MISSED, UNKNOWN → UNSURE, each for the confirmed canonical
 *   medicine, occurrence and expected time UNKNOWN. A TAKEN event stores the amount the person REPORTED (owner decision #4) exactly as
 *   said: the value as spoken and the unit by a fixed word table (units → UNIT, tablet → TABLET, capsule → CAPSULE, mg → MG, ml → ML),
 *   any other unit word kept verbatim as OTHER. Without a reported amount it is NOT_RECORDED: no dose is ever added. MISSED and UNSURE
 *   have no amount field, so the screen says the amount will not be saved (`reportedAmountSaved` covers TAKEN only).
 * - FEELING_NOTE (owner decision 2026-10-14, "Save as a note") → `createPersonalNote`: her (edited) words as the note text, language
 *   en-SG (feelings are recognised in English only), the recognised cue keys, two turns (her words as PATIENT; the reviewed kind
 *   sentence for her cues, `noteKindSentenceFor`, as JAGAON_KIND_SENTENCE from REVIEWED_BANK), no themes, no AI (aiUsed false,
 *   promptVersion null), no care question.
 * - ACTIVITY (owner decision 2026-10-14) → `recordActivity`: the recognised category, her (edited) words as the label, the duration
 *   only when said or entered; occurrence time UNKNOWN (a POINT, as for the other voice saves; activity allows POINT or INTERVAL).
 * Never called without the person's explicit Save (the screen calls it once per confirmed fact). Without the notes or activity port
 * (an older runtime or a test double) those intents are NOT_SAVED.
 */
export type VoiceJournalSavePorts = Readonly<{
  commands: Pick<JournalCommandService, "recordGlucose" | "recordMeal">;
  recordMedicationEvent: (input: RecordMedicationEventInput) => Promise<JournalCommitResult>;
  /** Owner decision 2026-10-14: the existing activity command (`runtime.commands.recordActivity`). */
  recordActivity?: (input: RecordActivityInput) => Promise<JournalCommitResult>;
  /** Owner decision 2026-10-14: the personal-note command service (`runtime.notes.commands`). */
  notes?: Pick<PersonalNoteCommandService, "createPersonalNote">;
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

export function createVoiceJournalSave(ports: VoiceJournalSavePorts): (intent: VoiceSaveIntent) => Promise<VoiceSaveOutcome> {
  return async function save(intent: VoiceSaveIntent): Promise<VoiceSaveOutcome> {
    let result: JournalCommitResult;
    try {
      const recordedAt = ports.now();
      if (intent.kind === "FEELING_NOTE") {
        if (!ports.notes) return { kind: "NOT_SAVED" };
        const note = await ports.notes.createPersonalNote({
          payload: {
            text: intent.text,
            language: "en-SG",
            feelingCues: [...intent.cueKeys],
            turns: [
              { role: "PATIENT", text: intent.text, source: "PATIENT" },
              { role: "JAGAON_KIND_SENTENCE", text: noteKindSentenceFor(intent.cueKeys), source: "REVIEWED_BANK" },
            ],
            themes: [],
            aiUsed: false,
            promptVersion: null,
            careQuestionRef: null,
          },
        });
        return note.kind === "COMMITTED" ? { kind: "SAVED" } : { kind: "NOT_SAVED" };
      }
      if (intent.kind === "ACTIVITY") {
        if (!ports.recordActivity) return { kind: "NOT_SAVED" };
        result = await ports.recordActivity({
          payload: { activityCategory: intent.category, patientLabel: intent.label, ...(intent.durationMinutes !== null ? { reportedDurationMinutes: intent.durationMinutes } : {}) },
          temporal: UNKNOWN_POINT,
          recordedAt,
        });
      } else if (intent.kind === "GLUCOSE") {
        const enteredValue = formatMmolEntry(intent.valueText);
        if (enteredValue === null || !isFormattedMmolEntry(enteredValue)) return { kind: "NOT_SAVED" };
        result = await ports.commands.recordGlucose({
          payload: { measurement: { enteredValue: enteredValue as DecimalString, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "UNKNOWN", context: { kind: "UNSPECIFIED" } },
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
      } else if (intent.kind === "MEDICATION_EVENT") {
        const medication = { recordType: "MEDICATION" as const, recordId: intent.medication.recordId, revisionId: intent.medication.revisionId } as RecordMedicationEventInput["payload"]["medication"];
        const occasion = { expectedAt: { kind: "UNKNOWN" as const } };
        const payload: RecordMedicationEventInput["payload"] =
          intent.status === "TAKEN"
            ? { medication, state: "TAKEN", amountTaken: reportedAmountTaken((intent as { reportedAmount?: { valueText: string; unitText: string } | null }).reportedAmount) }
            : { medication, state: intent.status === "SKIPPED" ? "MISSED" : "UNSURE", intendedOccasion: occasion };
        result = await ports.recordMedicationEvent({ payload, temporal: UNKNOWN_POINT, recordedAt });
      } else {
        return { kind: "NOT_SAVED" };
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
