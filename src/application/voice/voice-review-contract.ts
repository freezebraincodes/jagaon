import { z } from "zod";
import {
  VOICE_PERSON_RESOLVABLE_REASONS,
  glucoseHedgeMarked,
  glucoseNeedsConfirmation,
  voiceAnalysisSchema,
  voiceMedicationRefSchema,
  voiceReportedAmountSchema,
  type VoiceAnalysis,
  type VoiceCandidate,
  type VoiceMedicationRef,
} from "@/domain/voice/voice-contracts";
import { formatMmolEntry, isFormattedMmolEntry, isMmolEntryValue } from "@/domain/voice/glucose-entry-format";
import type { VoiceSessionState } from "./voice-session-controller";

/**
 * Packet 13 (P13S): from reviewed candidates plus the person's explicit per-fact decisions to closed save intents, `voice-review.13s.5`.
 * Each fact is decided separately; nothing is an intent without an explicit SAVE decision for that fact.
 *
 * Rules (review C3 and the owner requirements):
 * - A targeted answer may resolve ONLY the person-resolvable reasons: UNIT_UNSTATED (the unit), MEDICINE_UNRESOLVED (a pick from the
 *   profile's canonical medicines) and STATUS_UNCLEAR (the occurrence status).
 * - NEGATION, UNCERTAINTY, CORRECTION and MULTIPLE_NUMBERS are never resolved by an answer: the fact is saved only from an explicit,
 *   complete EDIT of the fact by the person (or by manual entry).
 * - OTHER_PERSON is never saved, not even from an edit: voice never records another person's fact in this profile.
 * - A PLANNED occurrence ("I need to inject") is not an event: it is saved only from an explicit edit to TAKEN, SKIPPED or UNKNOWN.
 * - A medicine (mapped, picked or edited) must be one of the profile's current canonical medicines (`knownMedications`); a mapping
 *   to a removed record is not saved. No dose, unit or time that was not said is added.
 * - 13s.3 (owner #4): an amount the person REPORTED for the occurrence travels unchanged as the intent's `reportedAmount` (exactly as
 *   spoken; never advice). The screen must show what the existing medication command will and will not store, and never drop it
 *   silently. An explicit edit replaces the proposal, so an edited intent carries no reported amount.
 * - 13s.4 (CR-11, owner decisions 2026-10-11; replaces the 13s.3 OUT_OF_RANGE refusal): 50 mmol/L is no longer a save limit. A
 *   glucose value above 50 mmol/L, or zero, from the proposal or from an edit, becomes an intent ONLY with the person's explicit
 *   confirmation (`confirmed: true`, the card's "Save as shown"); without it the fact is refused (CONFIRMATION_REQUIRED). The value
 *   must be in the shared new-entry format (1–4 integer digits, at most one decimal; never rounded) and the intent carries it formatted
 *   to exactly one decimal ("60" → "60.0", "0" → "0.0"). The unit is still never assumed outside the app-default window: an UNSTATED
 *   unit needs the explicit answer ("Yes, mmol/L").
 * - 13s.5 (owner decision 2026-10-14, distress safety): a DISTRESS analysis yields nothing (DISTRESS), whatever the decisions say.
 * - A REDIRECT or over-long analysis, a session that did not complete or a review of an older session yields nothing; a redirect
 *   NOTICE beside separated facts does not block those facts. Malformed decisions refuse the whole review (fail closed).
 * Remembering a term is a separate decision (terminology service); it never creates or depends on an intent.
 * It imports no journal or storage code: the app maps intents to the existing commands (recordGlucose, recordMeal,
 * recordMedicationEvent). recordGlucose has NO format or confirmation check of its own, which is why this contract applies them.
 */
export const VOICE_REVIEW_CONTRACT_VERSION = "voice-review.13s.5";

/** An intent's value: the stored new-entry form, exactly one decimal (13s.4). An edit's value: the shared entry format (≤ 1 decimal). */
const INTENT_VALUE = z.string().refine(isFormattedMmolEntry, { message: "VALUE_FORMAT" });
const EDIT_VALUE = z.string().refine(isMmolEntryValue, { message: "VALUE_FORMAT" });
const EVENT_STATUSES = ["TAKEN", "SKIPPED", "UNKNOWN"] as const;
const SLOTS = ["BREAKFAST", "LUNCH", "DINNER", "SUPPER"] as const;
const boundedText = (max: number) => z.string().min(1).max(max).refine((text) => text.trim().length > 0);

export const voiceSaveIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GLUCOSE"), valueText: INTENT_VALUE, unit: z.literal("MMOL_PER_L"), unitSource: z.enum(["SPOKEN", "APP_DEFAULT", "PERSON"]) }).strict(),
  z.object({ kind: z.literal("MEAL"), slot: z.enum(SLOTS).nullable(), itemText: boundedText(120).nullable() }).strict(),
  z.object({ kind: z.literal("MEDICATION_EVENT"), medication: voiceMedicationRefSchema, status: z.enum(EVENT_STATUSES), reportedAmount: voiceReportedAmountSchema.nullable() }).strict(),
]);
export type VoiceSaveIntent = z.infer<typeof voiceSaveIntentSchema>;

const editSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GLUCOSE_READING"), valueText: EDIT_VALUE, unit: z.literal("MMOL_PER_L") }).strict(),
  z.object({ kind: z.literal("MEAL_NOTE"), slot: z.enum(SLOTS).nullable(), itemText: boundedText(120).nullable() }).strict(),
  z.object({ kind: z.literal("MEDICATION_OCCURRENCE"), medication: voiceMedicationRefSchema, status: z.enum(EVENT_STATUSES) }).strict(),
]);
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ candidateIndex: z.number().int().min(0), action: z.literal("SKIP") }).strict(),
  z
    .object({
      candidateIndex: z.number().int().min(0),
      action: z.literal("SAVE"),
      /** Targeted answers to the person-resolvable questions only. */
      answers: z.object({ unit: z.literal("MMOL_PER_L").optional(), medication: voiceMedicationRefSchema.optional(), status: z.enum(EVENT_STATUSES).optional() }).strict().optional(),
      /** The person's explicit, complete edit of the fact (replaces the proposed meaning). */
      edit: editSchema.optional(),
      /** 13s.4 (CR-11): the person pressed "Save as shown" on the confirmation panel for this reading (required above 50 or at zero). */
      confirmed: z.literal(true).optional(),
    })
    .strict(),
]);
export type VoiceFactDecision = z.infer<typeof decisionSchema>;

export type VoiceReviewInput = Readonly<{
  analysis: VoiceAnalysis;
  reviewedSessionToken: number;
  currentSession: Readonly<{ sessionToken: number; state: VoiceSessionState }>;
  /** The profile's current canonical medicine records (the only medicines an intent may name). */
  knownMedications: readonly VoiceMedicationRef[];
  decisions: readonly VoiceFactDecision[];
}>;

export type VoiceFactRejection =
  | "OTHER_PERSON"
  | "NEEDS_EDIT"
  | "UNIT_NOT_ANSWERED"
  | "MEDICINE_NOT_ANSWERED"
  | "STATUS_NOT_ANSWERED"
  | "PLANNED_NOT_AN_EVENT"
  | "CONFIRMATION_REQUIRED"
  | "VALUE_FORMAT"
  | "MEDICINE_NOT_IN_PROFILE"
  | "EDIT_KIND_MISMATCH"
  | "NOT_A_FACT";
export type VoiceReviewNoIntentReason = "INVALID_REVIEW" | "DISTRESS" | "REDIRECTED" | "TRANSCRIPT_TOO_LONG" | "SESSION_NOT_COMPLETED" | "STALE_REVIEW" | "INVALID_DECISIONS" | "NO_CONFIRMATION";
export type VoiceReviewResult =
  | Readonly<{ kind: "INTENTS"; intents: ReadonlyArray<Readonly<{ candidateIndex: number; intent: VoiceSaveIntent }>>; rejected: ReadonlyArray<Readonly<{ candidateIndex: number; reason: VoiceFactRejection }>> }>
  | Readonly<{ kind: "NO_INTENT"; reason: VoiceReviewNoIntentReason; rejected?: ReadonlyArray<Readonly<{ candidateIndex: number; reason: VoiceFactRejection }>> }>;

const none = (reason: VoiceReviewNoIntentReason, rejected?: ReadonlyArray<{ candidateIndex: number; reason: VoiceFactRejection }>): VoiceReviewResult =>
  Object.freeze(rejected && rejected.length > 0 ? { kind: "NO_INTENT", reason, rejected } : { kind: "NO_INTENT", reason });
const EDIT_ONLY = new Set(["NEGATION", "UNCERTAINTY", "CORRECTION", "MULTIPLE_NUMBERS"]);
const sameRef = (left: VoiceMedicationRef, right: VoiceMedicationRef) => left.recordId === right.recordId && left.revisionId === right.revisionId && left.recordType === right.recordType;

/** 13s.4: a glucose intent with the value formatted to one decimal; above 50 or at zero only with the explicit confirmation. */
function glucose(valueText: string, unitSource: "SPOKEN" | "APP_DEFAULT" | "PERSON", confirmed: boolean, hedged = false): { intent: VoiceSaveIntent } | { reason: VoiceFactRejection } {
  const formatted = formatMmolEntry(valueText);
  if (formatted === null) return { reason: "VALUE_FORMAT" };
  // Round 5 (revised B): a hedged proposal ("about 7.8", "~7", 七点八左右) also needs the explicit confirmation, whatever its value.
  if ((glucoseNeedsConfirmation(formatted) || hedged) && !confirmed) return { reason: "CONFIRMATION_REQUIRED" };
  return { intent: { kind: "GLUCOSE", valueText: formatted, unit: "MMOL_PER_L", unitSource } };
}

/** The intent for one SAVE decision, or the closed reason it cannot be saved. Exported for the per-card review screen. */
export function intentForDecision(candidate: VoiceCandidate, decision: Extract<VoiceFactDecision, { action: "SAVE" }>, knownMedications: readonly VoiceMedicationRef[]): { intent: VoiceSaveIntent } | { reason: VoiceFactRejection } {
  if (candidate.kind === "UNSUPPORTED_SPAN") return { reason: "NOT_A_FACT" };
  if (candidate.ambiguity.includes("OTHER_PERSON")) return { reason: "OTHER_PERSON" };
  const known = (ref: VoiceMedicationRef) => knownMedications.some((entry) => sameRef(entry, ref));
  const edit = decision.edit;
  if (edit) {
    if (edit.kind !== candidate.kind) return { reason: "EDIT_KIND_MISMATCH" };
    if (edit.kind === "GLUCOSE_READING") return glucose(edit.valueText, "PERSON", decision.confirmed === true);
    if (edit.kind === "MEAL_NOTE") return { intent: { kind: "MEAL", slot: edit.slot, itemText: edit.itemText } };
    return known(edit.medication) ? { intent: { kind: "MEDICATION_EVENT", medication: edit.medication, status: edit.status, reportedAmount: null } } : { reason: "MEDICINE_NOT_IN_PROFILE" };
  }
  if (candidate.kind === "GLUCOSE_READING" && formatMmolEntry(candidate.valueText) === null) return { reason: "VALUE_FORMAT" };
  if (candidate.ambiguity.some((reason) => EDIT_ONLY.has(reason))) return { reason: "NEEDS_EDIT" };
  if (candidate.ambiguity.some((reason) => !(VOICE_PERSON_RESOLVABLE_REASONS as readonly string[]).includes(reason))) return { reason: "NEEDS_EDIT" };
  const answers = decision.answers ?? {};
  if (candidate.kind === "GLUCOSE_READING") {
    const hedged = glucoseHedgeMarked(candidate.sourcePhrase);
    if (candidate.unit === "UNSTATED") return answers.unit === "MMOL_PER_L" ? glucose(candidate.valueText, "PERSON", decision.confirmed === true, hedged) : { reason: "UNIT_NOT_ANSWERED" };
    return glucose(candidate.valueText, candidate.unitSource === "APP_DEFAULT" ? "APP_DEFAULT" : "SPOKEN", decision.confirmed === true, hedged);
  }
  if (candidate.kind === "MEAL_NOTE") return { intent: { kind: "MEAL", slot: candidate.slot === "UNSTATED" ? null : candidate.slot, itemText: candidate.itemText } };
  if (candidate.status === "PLANNED") return { reason: "PLANNED_NOT_AN_EVENT" };
  const medication = candidate.medicineRef.kind === "MAPPED" ? candidate.medicineRef.medication : answers.medication;
  if (!medication) return { reason: "MEDICINE_NOT_ANSWERED" };
  if (!known(medication)) return { reason: "MEDICINE_NOT_IN_PROFILE" };
  const status = candidate.status === "UNKNOWN" ? answers.status : candidate.status;
  if (!status) return { reason: "STATUS_NOT_ANSWERED" };
  return { intent: { kind: "MEDICATION_EVENT", medication, status, reportedAmount: candidate.reportedAmount } };
}

export function reviewVoiceCandidates(input: VoiceReviewInput): VoiceReviewResult {
  const analysis = voiceAnalysisSchema.safeParse(input?.analysis);
  if (!analysis.success) return none("INVALID_REVIEW");
  if (analysis.data.kind === "DISTRESS") return none("DISTRESS");
  if (analysis.data.kind === "REDIRECT") return none("REDIRECTED");
  if (analysis.data.kind === "TRANSCRIPT_TOO_LONG") return none("TRANSCRIPT_TOO_LONG");
  if (input.currentSession?.state !== "COMPLETED") return none("SESSION_NOT_COMPLETED");
  if (!Number.isSafeInteger(input.reviewedSessionToken) || input.reviewedSessionToken !== input.currentSession.sessionToken) return none("STALE_REVIEW");
  const known = z.array(voiceMedicationRefSchema).safeParse(input.knownMedications);
  if (!known.success) return none("INVALID_REVIEW");

  const candidates = analysis.data.candidates;
  const decisions = z.array(decisionSchema).max(candidates.length).safeParse(input.decisions);
  if (!decisions.success) return none("INVALID_DECISIONS");
  const indexes = decisions.data.map((decision) => decision.candidateIndex);
  if (new Set(indexes).size !== indexes.length || indexes.some((index) => index >= candidates.length)) return none("INVALID_DECISIONS");

  const intents: Array<{ candidateIndex: number; intent: VoiceSaveIntent }> = [];
  const rejected: Array<{ candidateIndex: number; reason: VoiceFactRejection }> = [];
  for (const decision of [...decisions.data].sort((left, right) => left.candidateIndex - right.candidateIndex)) {
    if (decision.action !== "SAVE") continue;
    const outcome = intentForDecision(candidates[decision.candidateIndex]!, decision, known.data);
    if ("intent" in outcome) intents.push(Object.freeze({ candidateIndex: decision.candidateIndex, intent: Object.freeze(voiceSaveIntentSchema.parse(outcome.intent)) }));
    else rejected.push(Object.freeze({ candidateIndex: decision.candidateIndex, reason: outcome.reason }));
  }
  return intents.length === 0 ? none("NO_CONFIRMATION", rejected) : Object.freeze({ kind: "INTENTS", intents: Object.freeze(intents), rejected: Object.freeze(rejected) });
}
