import Dexie from "dexie";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createReminderReconciliation } from "@/application/care-plan/reminder-reconciliation";
import { createInquiryService, type BarrierPresentationCopy } from "@/application/inquiry/inquiry-service";
import type { MedicationEventPayload } from "@/domain/health-records/medication-event";
import type { PrescriptionVersionPayload } from "@/domain/care-plan/prescription-version";
import type { Instant, RecordId, RevisionId } from "@/domain/shared";

/**
 * Test-only Packet 8 harness: one fake-IndexedDB database, a controllable
 * clock and the journal, Care Plan and Inquiry services wired as in the
 * runtime. Never imported by runtime modules.
 */

export const NOCTURIN_MEDICATION = { recordId: "00000000-0000-4000-8000-000000000101", revisionId: "00000000-0000-4000-8000-000000000101" } as const;

export const NOCTURIN_PRESCRIPTION: PrescriptionVersionPayload = {
  medication: { recordType: "MEDICATION", recordId: NOCTURIN_MEDICATION.recordId as RecordId, revisionId: NOCTURIN_MEDICATION.revisionId as RevisionId },
  sourceInstructionText: { text: "Inject 12 units every night at 9 pm (demo label)", language: "en-SG" },
  doseInstruction: { kind: "FIXED", amount: { value: "12" as never, unit: "UNIT" } },
  schedule: { kind: "FIXED_LOCAL_TIMES", entries: [{ scheduleKey: "night", time: "21:00" as never }] },
  effectivePeriod: { start: { kind: "DATE_ONLY", localDate: "2026-08-12" as never, timeZoneId: "Asia/Singapore" }, end: { kind: "OPEN" } },
} as PrescriptionVersionPayload;

export const TEST_COPY: BarrierPresentationCopy = {
  template: {
    barrierWhy: (status, medicine, date) => `You recorded ${status} for ${medicine} on ${date}. Answering is optional.`,
    barrierQuestion: "Would you like to record anything that made this difficult?",
    optionLabels: {
      FORGOT: "Forgot",
      ROUTINE_CHANGED: "Routine changed",
      AWAY_FROM_HOME: "Away from home",
      ACCESS_DIFFICULTY: "Access difficulty",
      SIDE_EFFECT_CONCERN: "Side-effect concern",
    },
  },
  statusLabel: (state) => (state === "MISSED" ? "Skipped" : "Not sure"),
  occasionDate: (localDate) => localDate,
};

const uuid = () => crypto.randomUUID() as never;

export async function createPacket8Harness(start: string = "2026-10-03T02:00:00.000Z") {
  const database = createJagaOnDatabase(`packet8-${crypto.randomUUID()}`);
  await database.open();
  let clock = start as Instant;
  const now = () => clock;
  const ids = {
    commandId: uuid,
    correlationId: uuid,
    recordId: uuid,
    revisionId: uuid,
    auditEventId: uuid,
    transactionId: uuid,
    domainEventId: uuid,
    workItemId: uuid,
  };
  const journal = createJournalCommandService(database, { now, ids });
  const carePlan = createCarePlanCommandService(database, { now, ids });
  const reminders = createReminderReconciliation(database, { now, newCommandId: uuid, leaseToken: () => crypto.randomUUID(), instanceId: "test", carePlan });
  const inquiry = createInquiryService(database, {
    now,
    ids: { ...ids, presentationKey: () => crypto.randomUUID(), leaseToken: () => crypto.randomUUID() },
    instanceId: "test",
    copy: () => TEST_COPY,
  });

  const medication = await carePlan.registerMedication({
    recordId: NOCTURIN_MEDICATION.recordId as RecordId,
    revisionId: NOCTURIN_MEDICATION.revisionId as RevisionId,
    payload: {
      identity: { kind: "UNMAPPED", patientEnteredName: "Nocturin pen" },
      doseForm: "INJECTION_SOLUTION",
      route: "SUBCUTANEOUS",
      deliveryDevice: "INSULIN_PEN",
    },
    recordedAt: clock,
  });
  const prescription = await carePlan.recordPrescriptionVersion({ payload: NOCTURIN_PRESCRIPTION, recordedAt: clock });
  if (medication.kind !== "COMMITTED" || prescription.kind !== "COMMITTED") throw new Error("HARNESS_SEED_FAILED");
  const prescriptionRef = { recordType: "PRESCRIPTION_VERSION" as const, recordId: prescription.recordId, revisionId: prescription.revisionId };

  /** 9:00 pm Singapore on the local date `daysBefore` days before 3 Oct 2026. */
  function occasionAt(daysBefore: number): Instant {
    return new Date(Date.UTC(2026, 9, 3 - daysBefore, 13, 0)).toISOString() as Instant;
  }

  function eventPayload(state: MedicationEventPayload["state"], daysBefore: number, ref = prescriptionRef): MedicationEventPayload {
    const intendedOccasion = {
      expectedAt: { kind: "EXACT" as const, instantUtc: occasionAt(daysBefore), timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 },
      prescriptionVersion: ref,
      scheduleKey: "night",
    };
    const base = {
      medication: { recordType: "MEDICATION" as const, recordId: NOCTURIN_MEDICATION.recordId as RecordId, revisionId: NOCTURIN_MEDICATION.revisionId as RevisionId },
      prescriptionVersion: ref,
      intendedOccasion,
    };
    return (state === "TAKEN" ? { ...base, state, amountTaken: { kind: "NOT_RECORDED" } } : { ...base, state }) as MedicationEventPayload;
  }

  async function record(state: MedicationEventPayload["state"], daysBefore = 1) {
    const result = await journal.recordMedicationEvent({
      payload: eventPayload(state, daysBefore),
      temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } },
      recordedAt: clock,
    });
    if (result.kind !== "COMMITTED") throw new Error(`RECORD_FAILED:${JSON.stringify(result)}`);
    return result;
  }

  async function rows(recordType: string) {
    const heads = await database.table("recordHeads").where("recordType").equals(recordType).toArray();
    return heads as Array<{ recordId: string; headRevisionId: string; state: string }>;
  }

  async function revision(revisionId: string) {
    return (await database.table("recordRevisions").get(revisionId)) as { revision: { payload: Record<string, unknown> }; transactionId: string } | undefined;
  }

  async function close() {
    database.close();
    await Dexie.delete(database.name);
  }

  return {
    database: database as JagaOnDatabase,
    journal,
    carePlan,
    reminders,
    inquiry,
    prescriptionRef,
    eventPayload,
    occasionAt,
    record,
    rows,
    revision,
    close,
    setClock(next: string) {
      clock = next as Instant;
    },
    advanceHours(hours: number) {
      clock = new Date(Date.parse(clock) + hours * 3_600_000).toISOString() as Instant;
    },
  };
}

export type Packet8Harness = Awaited<ReturnType<typeof createPacket8Harness>>;
