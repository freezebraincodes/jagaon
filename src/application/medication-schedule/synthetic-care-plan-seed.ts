import type { CommandId, CorrelationId, DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { WorkItemId } from "@/application/contracts/event-work";
import type { AuditEventId, Instant, RecordId, RevisionId, TransactionId } from "@/domain/shared";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { PrescriptionVersionPayload } from "@/domain/care-plan/prescription-version";
import type { ReminderPayload } from "@/domain/care-plan/reminder";
import type { InquiryAnswerOptionKeyValue } from "@/domain/inquiry/inquiry-registry";
import type { JagaOnDatabase } from "@/storage/database";
import { demoRevisionId } from "@/application/governed/demo-scenario-fixture";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createReminderReconciliation } from "@/application/care-plan/reminder-reconciliation";
import { createInquiryService, type BarrierPresentationCopy } from "@/application/inquiry/inquiry-service";

/**
 * Deterministic synthetic Care Plan scenario for the Packet 8 demo.
 *
 * Every value is invented and uses the fictional demo medicines from the
 * prepared onboarding profile. Records are written only through the Care
 * Plan, journal and Inquiry command boundaries, and only into an empty demo
 * database. The plan is a pure function of the seed instant: two recorded
 * prescriptions (one fixed 9:00 pm time, one "with meals" direction that has
 * no fixed time), a prescription typo correction that leaves a reminder for
 * review, explicit medication records with optional answers, and occasions
 * deliberately left unrecorded. Nothing is inferred from an unrecorded day.
 */

export const DEMO_LANTUS_MEDICATION_ID = "00000000-0000-4000-8000-000000000101";
export const DEMO_APIDRA_MEDICATION_ID = "00000000-0000-4000-8000-000000000103";

const HOME_OFFSET_MINUTES = 480;
const DAY_MS = 86_400_000;

type SeedIds = {
  commandId(): CommandId;
  correlationId(): CorrelationId;
  recordId(): RecordId;
  revisionId(): RevisionId;
  auditEventId(): AuditEventId;
  transactionId(): TransactionId;
  domainEventId(): DomainEventId;
  workItemId(): WorkItemId;
};

/** One explicit synthetic record for the 9:00 pm occasion `daysBefore` local days before the seed date. */
export type SeededOccasion = {
  daysBefore: number;
  state: MedicationEventPayload["state"];
  amount?: { kind: "KNOWN"; value: string } | { kind: "NOT_RECORDED" } | { kind: "UNSURE" };
  answer?: { kind: "OPTION"; optionKey: InquiryAnswerOptionKeyValue } | { kind: "PREFER_NOT_TO_SAY" };
};

/** Days 1, 5 and 10 are deliberately left unrecorded. */
export const SEEDED_NIGHT_OCCASIONS: readonly SeededOccasion[] = Object.freeze([
  { daysBefore: 13, state: "TAKEN", amount: { kind: "UNSURE" } },
  { daysBefore: 12, state: "MISSED", answer: { kind: "OPTION", optionKey: "ROUTINE_CHANGED" } },
  { daysBefore: 11, state: "DECLINED_TO_RECORD" },
  { daysBefore: 9, state: "MISSED", answer: { kind: "OPTION", optionKey: "AWAY_FROM_HOME" } },
  { daysBefore: 8, state: "TAKEN", amount: { kind: "KNOWN", value: "12" } },
  { daysBefore: 7, state: "UNSURE", answer: { kind: "PREFER_NOT_TO_SAY" } },
  { daysBefore: 6, state: "TAKEN", amount: { kind: "NOT_RECORDED" } },
  { daysBefore: 4, state: "MISSED", answer: { kind: "OPTION", optionKey: "ROUTINE_CHANGED" } },
  { daysBefore: 3, state: "TAKEN", amount: { kind: "KNOWN", value: "12" } },
  { daysBefore: 2, state: "TAKEN", amount: { kind: "KNOWN", value: "12" } },
]);

function localMidnightUtc(seedAt: Instant, daysBefore: number): number {
  const local = new Date(Date.parse(seedAt) + HOME_OFFSET_MINUTES * 60_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysBefore) - HOME_OFFSET_MINUTES * 60_000;
}

const at = (ms: number) => new Date(ms).toISOString() as Instant;

function lantusPrescription(time: string): PrescriptionVersionPayload {
  return {
    medication: { recordType: "MEDICATION", recordId: DEMO_LANTUS_MEDICATION_ID as RecordId, revisionId: demoRevisionId(DEMO_LANTUS_MEDICATION_ID) },
    sourceInstructionText: { text: "Inject 12 units every night at 9 pm (demo label)", language: "en-SG" },
    doseInstruction: { kind: "FIXED", amount: { value: "12" as never, unit: "UNIT" } },
    schedule: { kind: "FIXED_LOCAL_TIMES", entries: [{ scheduleKey: "night", time: time as never }] },
    effectivePeriod: { start: { kind: "DATE_ONLY", localDate: "2026-08-12" as never, timeZoneId: "Asia/Singapore" }, end: { kind: "OPEN" } },
  } as PrescriptionVersionPayload;
}

const APIDRA_PRESCRIPTION = {
  medication: { recordType: "MEDICATION", recordId: DEMO_APIDRA_MEDICATION_ID as RecordId, revisionId: demoRevisionId(DEMO_APIDRA_MEDICATION_ID) },
  sourceInstructionText: { text: "Inject 6 units with meals (demo label)", language: "en-SG" },
  doseInstruction: { kind: "FIXED", amount: { value: "6" as never, unit: "UNIT" } },
  // Event-relative wording: JagaOn never turns it into an invented clock time.
  schedule: { kind: "EVENT_RELATIVE", timings: [{ scheduleKey: "meals", relation: "WITH", anchor: "MEAL", interval: { kind: "UNSPECIFIED" } }] },
  effectivePeriod: { start: { kind: "DATE_ONLY", localDate: "2026-08-12" as never, timeZoneId: "Asia/Singapore" }, end: { kind: "OPEN" } },
} as PrescriptionVersionPayload;

const EVERY_DAY = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;

function committed<T extends { kind: string }>(result: T): Extract<T, { kind: "COMMITTED" }> {
  if (result.kind !== "COMMITTED") throw new Error("SYNTHETIC_CARE_PLAN_BOOTSTRAP_FAILED");
  return result as Extract<T, { kind: "COMMITTED" }>;
}

export async function seedSyntheticCarePlan(input: {
  database: JagaOnDatabase;
  seedAt: Instant;
  ids: SeedIds;
  copy: BarrierPresentationCopy;
}): Promise<void> {
  const { database, seedAt, ids } = input;
  let clock = at(Date.parse(seedAt) - 60 * DAY_MS);
  const now = () => clock;
  const journal = createJournalCommandService(database, { now, ids });
  const carePlan = createCarePlanCommandService(database, { now, ids });
  const reminders = createReminderReconciliation(database, { now, newCommandId: ids.commandId, leaseToken: () => crypto.randomUUID(), instanceId: "seed", carePlan });
  const inquiry = createInquiryService(database, {
    now,
    ids: { ...ids, presentationKey: () => crypto.randomUUID(), leaseToken: () => crypto.randomUUID() },
    instanceId: "seed",
    copy: () => input.copy,
  });

  for (const [recordId, catalogueEntryKey, name] of [
    [DEMO_LANTUS_MEDICATION_ID, "lantus-demo", "Lantus"],
    [DEMO_APIDRA_MEDICATION_ID, "apidra-demo", "Apidra"],
  ] as const) {
    committed(
      await carePlan.registerMedication({
        recordId: recordId as RecordId,
        revisionId: demoRevisionId(recordId),
        payload: {
          identity: {
            kind: "REVIEWED_CATALOGUE_MATCH",
            patientEnteredName: name,
            catalogueEntryKey,
            catalogueVersion: "6a.1",
            matchedLabel: name,
            matchMethod: "STRUCTURED_PATIENT_SELECTION",
          },
          doseForm: "INJECTION_SOLUTION",
          route: "SUBCUTANEOUS",
          deliveryDevice: "INSULIN_PEN",
        },
        recordedAt: clock,
      }),
    );
  }
  // The first transcription had a typo; it is corrected below, which leaves
  // the reminder that relayed it waiting for the patient's review.
  const typo = committed(await carePlan.recordPrescriptionVersion({ payload: lantusPrescription("21:30"), recordedAt: clock }));
  committed(await carePlan.recordPrescriptionVersion({ payload: APIDRA_PRESCRIPTION, recordedAt: clock }));

  const reminder = (payload: Omit<ReminderPayload, "deliveryPreference">): ReminderPayload => ({ ...payload, deliveryPreference: "IN_APP_ONLY" });
  committed(
    await carePlan.createReminder({
      seeded: true,
      patientConfirmed: true,
      payload: reminder({
        label: { text: "Morning reading", language: "und" },
        subject: { kind: "MEASUREMENT", measurementKind: "GLUCOSE" },
        schedule: { kind: "WEEKLY_LOCAL", daysOfWeek: [...EVERY_DAY], times: ["07:00" as never], timeZoneId: "Asia/Singapore" },
        state: "ACTIVE",
      }),
    }),
  );
  committed(
    await carePlan.createReminder({
      seeded: true,
      patientConfirmed: true,
      payload: reminder({
        label: { text: "Lantus", language: "und" },
        subject: { kind: "MEDICATION", target: { recordType: "PRESCRIPTION_VERSION", recordId: typo.recordId, revisionId: typo.revisionId } },
        schedule: { kind: "WEEKLY_LOCAL", daysOfWeek: [...EVERY_DAY], times: ["21:30" as never], timeZoneId: "Asia/Singapore" },
        state: "ACTIVE",
      }),
    }),
  );
  committed(
    await carePlan.createReminder({
      seeded: true,
      patientConfirmed: true,
      payload: reminder({
        label: { text: "Sunday foot check", language: "und" },
        subject: { kind: "CUSTOM" },
        schedule: { kind: "WEEKLY_LOCAL", daysOfWeek: ["SUNDAY"], times: ["09:00" as never], timeZoneId: "Asia/Singapore" },
        state: "PAUSED",
      }),
    }),
  );

  clock = at(Date.parse(clock) + DAY_MS);
  const corrected = committed(
    await carePlan.correctPrescriptionVersion({
      recordId: typo.recordId,
      expectedRevisionId: typo.revisionId,
      expectedRevisionNumber: 1,
      payload: lantusPrescription("21:00"),
      seeded: true,
    }),
  );
  await reminders.processPending();

  const prescription = { recordType: "PRESCRIPTION_VERSION" as const, recordId: corrected.recordId, revisionId: corrected.revisionId };
  const medication = { recordType: "MEDICATION" as const, recordId: DEMO_LANTUS_MEDICATION_ID as RecordId, revisionId: demoRevisionId(DEMO_LANTUS_MEDICATION_ID) };
  for (const occasion of SEEDED_NIGHT_OCCASIONS) {
    const expectedAt = at(localMidnightUtc(seedAt, occasion.daysBefore) + 21 * 3_600_000);
    clock = at(Date.parse(expectedAt) + 25 * 60_000);
    if (Date.parse(clock) >= Date.parse(seedAt)) continue;
    const intendedOccasion = {
      expectedAt: { kind: "EXACT" as const, instantUtc: expectedAt, timeZoneId: "Asia/Singapore", utcOffsetMinutes: HOME_OFFSET_MINUTES },
      prescriptionVersion: prescription,
      scheduleKey: "night",
    };
    const amount = occasion.amount;
    const payload = (
      occasion.state === "TAKEN"
        ? {
            medication,
            prescriptionVersion: prescription,
            intendedOccasion,
            state: "TAKEN",
            amountTaken: amount?.kind === "KNOWN" ? { kind: "KNOWN", amount: { value: amount.value, unit: "UNIT" } } : { kind: amount?.kind ?? "NOT_RECORDED" },
          }
        : { medication, prescriptionVersion: prescription, intendedOccasion, state: occasion.state }
    ) as MedicationEventPayload;
    const saved = committed(await journal.recordMedicationEvent({ payload, temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } }, recordedAt: clock }));
    if (!occasion.answer) continue;
    await inquiry.processPending();
    const offer = await inquiry.offerForMedicationEvent(saved.recordId, "en-SG");
    if (offer.kind !== "PRESENTED") throw new Error("SYNTHETIC_CARE_PLAN_BOOTSTRAP_FAILED");
    const rawAnswer = occasion.answer.kind === "OPTION" ? ({ kind: "BOUNDED_CHOICE", optionKey: occasion.answer.optionKey } as never) : ({ kind: "PREFER_NOT_TO_SAY" } as const);
    committed(await inquiry.answer({ inquiryRecordId: offer.question.inquiryRecordId, presentationKey: offer.question.presentationKey, rawAnswer, commandId: ids.commandId() }));
  }
}
