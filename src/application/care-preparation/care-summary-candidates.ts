import type { Instant, RecordHead, RecordId, RecordType } from "@/domain/shared";
import type { TimePoint } from "@/domain/shared/temporal";
import type { TypedRevisionRef } from "@/domain/shared/typed-revision-ref";
import type { AppointmentRevision } from "@/domain/care-plan/appointment";
import type { CareQuestionRevision } from "@/domain/care-plan/care-question";
import type { MedicationRevision } from "@/domain/care-plan/care-plan-revisions";
import type { JagaOnDatabase } from "@/storage/database";
import { carePlanRevisionRowCodec } from "@/application/care-plan/care-plan-persistence";
import { validatePacket6StoredRevision } from "@/application/journal/journal-row-codecs";
import { CARE_SUMMARY_MAX_SELECTIONS } from "@/domain/care-preparation/care-summary-snapshot";
import type { CareSummaryDraft, CareSummaryFact } from "./deterministic-care-summary-renderer";
import type { CareSummaryGroupKey, CareSummarySelectionInput } from "./care-preparation-contracts";

/**
 * Exact-source loading for a care summary (domain 11.3; plan 9C Task 3).
 *
 * Only explicitly selected, allowlisted, current active revisions become
 * facts. A deleted, corrected-away or superseded revision, a record outside
 * the period, a non-patient question or an unsupported value is ineligible;
 * nothing is filled in or widened. Patient notes are private by default and
 * are never read into a summary.
 */

export const CARE_SUMMARY_GROUP_RECORD_TYPES: Readonly<Record<CareSummaryGroupKey, RecordType>> = Object.freeze({
  GLUCOSE: "GLUCOSE_READING",
  INSULIN: "MEDICATION_EVENT",
  MEALS: "INTAKE_EVENT",
  WALKS: "ACTIVITY_EVENT",
});

const HOME_OFFSET_MS = 8 * 3_600_000;

function instantOf(point: TimePoint): string | null {
  if (point.kind === "EXACT") return point.instantUtc;
  if (point.kind === "APPROXIMATE") return point.approximateInstantUtc;
  if (point.kind === "DATE_ONLY") return new Date(Date.parse(`${point.localDate}T00:00:00.000Z`) - HOME_OFFSET_MS).toISOString();
  return null;
}

const refKey = (ref: TypedRevisionRef<RecordType>) => `${ref.recordType}|${ref.recordId}|${ref.revisionId}`;

async function currentHead(database: JagaOnDatabase, ref: TypedRevisionRef<RecordType>): Promise<RecordHead | null> {
  const head = (await database.table("recordHeads").get(ref.recordId)) as RecordHead | undefined;
  if (!head || head.state !== "ACTIVE" || head.recordType !== ref.recordType || head.headRevisionId !== ref.revisionId) return null;
  return head;
}

/** True only when every reference is still its record's exact current, active revision. */
export async function sourcesAreCurrent(database: JagaOnDatabase, refs: TypedRevisionRef<RecordType>[]): Promise<boolean> {
  for (const ref of refs) if (!(await currentHead(database, ref))) return false;
  return true;
}

export type LoadedCareSummaryDraft =
  | { kind: "OK"; draft: CareSummaryDraft; selections: number }
  | { kind: "EMPTY" }
  | { kind: "TOO_LARGE" }
  | { kind: "INELIGIBLE" };

class Ineligible extends Error {}

export async function loadCareSummaryDraft(database: JagaOnDatabase, input: CareSummarySelectionInput, asOf: Instant): Promise<LoadedCareSummaryDraft> {
  const groups = input.groups.filter((group) => group.sources.length > 0);
  const selections = (input.appointment ? 1 : 0) + groups.length + input.questions.length;
  if (selections === 0) return { kind: "EMPTY" };
  if (selections > CARE_SUMMARY_MAX_SELECTIONS) return { kind: "TOO_LARGE" };
  if (new Set(groups.map((group) => group.key)).size !== groups.length) return { kind: "INELIGIBLE" };
  const allRefs = [...(input.appointment ? [input.appointment] : []), ...groups.flatMap((group) => group.sources), ...input.questions];
  if (new Set(allRefs.map(refKey)).size !== allRefs.length) return { kind: "INELIGIBLE" };

  const startAt = Date.parse(input.period.startAt);
  const endAt = Date.parse(input.period.endAtExclusive);
  const inPeriod = (point: TimePoint | null) => {
    const at = point ? instantOf(point) : null;
    return at !== null && Date.parse(at) >= startAt && Date.parse(at) < endAt;
  };

  async function carePlanRevision<T>(ref: TypedRevisionRef<RecordType>): Promise<T> {
    if (!(await currentHead(database, ref))) throw new Ineligible();
    return carePlanRevisionRowCodec.validateAfterRead(await database.table("recordRevisions").get(ref.revisionId)).revision as T;
  }

  async function medicationName(recordId: RecordId): Promise<{ ref: TypedRevisionRef<"MEDICATION">; name: string }> {
    const head = (await database.table("recordHeads").get(recordId)) as RecordHead | undefined;
    if (!head || head.state !== "ACTIVE" || head.recordType !== "MEDICATION") throw new Ineligible();
    const ref: TypedRevisionRef<"MEDICATION"> = { recordType: "MEDICATION", recordId: head.recordId, revisionId: head.headRevisionId };
    const revision = await carePlanRevision<MedicationRevision>(ref);
    return { ref, name: revision.payload.identity.patientEnteredName };
  }

  async function fact(key: CareSummaryGroupKey, ref: TypedRevisionRef<RecordType>): Promise<CareSummaryFact> {
    if (ref.recordType !== CARE_SUMMARY_GROUP_RECORD_TYPES[key] || !(await currentHead(database, ref))) throw new Ineligible();
    const revision = validatePacket6StoredRevision(await database.table("recordRevisions").get(ref.revisionId)).revision;
    if (revision.recordType === "GLUCOSE_READING") {
      const occurrence = revision.temporal.occurrence;
      // Only the governed mmol/L entry is rendered; the entered value is kept exactly.
      if (revision.payload.measurement.enteredUnit !== "MMOL_L" || !inPeriod(occurrence)) throw new Ineligible();
      return { kind: "GLUCOSE", ref: { recordType: "GLUCOSE_READING", recordId: ref.recordId, revisionId: ref.revisionId }, occurrence, value: revision.payload.measurement.enteredValue };
    }
    if (revision.recordType === "MEDICATION_EVENT") {
      const payload = revision.payload;
      if (payload.state === "DELAYED") throw new Ineligible();
      const occurrence = revision.temporal.occurrence;
      const intendedAt = payload.intendedOccasion?.expectedAt ?? null;
      if (!inPeriod(occurrence.kind === "UNKNOWN" ? intendedAt : occurrence)) throw new Ineligible();
      const amount = payload.state === "TAKEN" && payload.amountTaken.kind === "KNOWN" ? payload.amountTaken.amount : null;
      return {
        kind: "MEDICATION_EVENT",
        ref: { recordType: "MEDICATION_EVENT", recordId: ref.recordId, revisionId: ref.revisionId },
        occurrence,
        state: payload.state,
        intendedAt,
        amount: amount ? (amount.unit === "OTHER" ? { value: amount.value, unit: "OTHER", otherUnitText: amount.otherUnitText } : { value: amount.value, unit: amount.unit }) : null,
        medication: await medicationName(payload.medication.recordId),
      };
    }
    if (revision.recordType === "INTAKE_EVENT") {
      const occurrence = revision.temporal.occurrence;
      if (!inPeriod(occurrence)) throw new Ineligible();
      return { kind: "INTAKE", ref: { recordType: "INTAKE_EVENT", recordId: ref.recordId, revisionId: ref.revisionId }, occurrence, intakeKind: revision.payload.intakeKind, items: revision.payload.items.map((item) => item.label) };
    }
    if (revision.recordType === "ACTIVITY_EVENT") {
      const temporal = revision.temporal;
      const occurrence = temporal.kind === "POINT" ? temporal.occurrence : temporal.start;
      if (!inPeriod(occurrence)) throw new Ineligible();
      return { kind: "ACTIVITY", ref: { recordType: "ACTIVITY_EVENT", recordId: ref.recordId, revisionId: ref.revisionId }, occurrence, label: revision.payload.patientLabel, minutes: revision.payload.reportedDurationMinutes ?? null };
    }
    throw new Ineligible();
  }

  try {
    let appointment: CareSummaryDraft["appointment"] = null;
    if (input.appointment) {
      const revision = await carePlanRevision<AppointmentRevision>(input.appointment);
      if (revision.recordType !== "APPOINTMENT" || revision.payload.status !== "SCHEDULED") throw new Ineligible();
      appointment = { ref: input.appointment, label: revision.payload.appointmentLabel, scheduledAt: revision.temporal.occurrence };
    }
    const facts: CareSummaryDraft["groups"] = [];
    for (const group of groups) facts.push({ key: group.key, facts: await Promise.all(group.sources.map((ref) => fact(group.key, ref))) });
    const questions: CareSummaryDraft["questions"] = [];
    for (const ref of input.questions) {
      const revision = await carePlanRevision<CareQuestionRevision>(ref);
      // Only the patient's own questions that are ready to ask; never a dismissed or suggested one.
      if (revision.recordType !== "CARE_QUESTION" || revision.payload.state !== "READY_TO_ASK" || revision.payload.origin.kind !== "PATIENT_AUTHORED") throw new Ineligible();
      questions.push({ ref, text: revision.payload.questionText.text, language: revision.payload.questionText.language });
    }
    const included = new Set(allRefs.map(refKey));
    return {
      kind: "OK",
      selections,
      draft: {
        locale: input.locale,
        asOf,
        period: input.period,
        appointment,
        groups: facts,
        questions,
        excluded: input.notSelected.filter((ref) => !included.has(refKey(ref))).map((source) => ({ source, reason: "NOT_SELECTED" as const })),
      },
    };
  } catch (error) {
    if (error instanceof Ineligible) return { kind: "INELIGIBLE" };
    throw error;
  }
}
