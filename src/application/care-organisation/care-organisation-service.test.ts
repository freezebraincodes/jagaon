import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant, RecordId, RevisionId } from "@/domain/shared";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createReminderReconciliation } from "@/application/care-plan/reminder-reconciliation";
import type { PreventiveCareItemPayload } from "@/domain/care-plan/preventive-care";
import type { AppointmentPayload } from "@/domain/care-plan/appointment";
import { createCareOrganisationService } from "./care-organisation-service";

const originalIndexedDB = Dexie.dependencies.indexedDB;
const originalKeyRange = Dexie.dependencies.IDBKeyRange;
beforeAll(() => {
  Dexie.dependencies.indexedDB = fakeIndexedDB;
  Dexie.dependencies.IDBKeyRange = FDBKeyRange;
});
afterAll(() => {
  Dexie.dependencies.indexedDB = originalIndexedDB;
  Dexie.dependencies.IDBKeyRange = originalKeyRange;
});
const open: JagaOnDatabase[] = [];
afterEach(async () => {
  for (const database of open.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

const uuid = () => crypto.randomUUID() as never;
const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const DAY = (localDate: string) => ({ kind: "DATE_ONLY" as const, localDate: localDate as never, timeZoneId: "Asia/Singapore" });
const AT = (instantUtc: string) => ({ kind: "EXACT" as const, instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 });

async function setup() {
  const database = createJagaOnDatabase(`packet9b-${crypto.randomUUID()}`);
  open.push(database);
  await database.open();
  let clock = NOW;
  const now = () => clock;
  const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };
  const carePlan = createCarePlanCommandService(database, { now, ids });
  const service = createCareOrganisationService(database, { now, ids, carePlan });
  const reminders = createReminderReconciliation(database, { now, newCommandId: uuid, leaseToken: uuid, instanceId: "test", carePlan });
  const rows = async (recordType: string) => (await database.table("recordHeads").where("recordType").equals(recordType).toArray()) as Array<{ recordId: string; headRevisionId: string; headRevisionNumber: number; state: string }>;
  const revisionsOf = async (recordId: string) => (await database.table("recordRevisions").where("recordId").equals(recordId).toArray()) as Array<{ revision: { action: string; payload: Record<string, unknown>; temporal: Record<string, unknown> } }>;
  const events = async () =>
    ((await database.table("domainEvents").toArray()) as Array<{ eventName: string; localSequence: number; payload: Record<string, unknown>; change: { recordType: string } }>).sort(
      (a, b) => a.localSequence - b.localSequence,
    );
  return { database, service, reminders, rows, revisionsOf, events, setClock: (value: string) => (clock = value as Instant) };
}

const EYE: PreventiveCareItemPayload = {
  identity: { kind: "REVIEWED_CATALOGUE_MATCH", catalogueEntryKey: "EYE_SCREENING", catalogueVersion: "preventive-care-catalogue.1", label: "Eye screening" },
  trackingState: "ACTIVE",
  schedule: { kind: "TARGET_DATE", targetDate: "2026-11-03" as never },
  patientNote: { text: "Afternoon slot", language: "en-SG" },
};
const VISIT: AppointmentPayload = { appointmentLabel: "Dr Lim, Bukit Merah Polyclinic", service: { kind: "UNKNOWN" }, mode: "IN_PERSON", status: "SCHEDULED", careContactLabel: "Dr Lim", locationLabel: "Bukit Merah Polyclinic" };
const committed = <T extends { kind: string }>(result: T) => {
  if (result.kind !== "COMMITTED") throw new Error(`expected COMMITTED, got ${JSON.stringify(result)}`);
  return result as Extract<T, { kind: "COMMITTED" }> & { recordId: RecordId; revisionId: RevisionId };
};
const expected = (result: { recordId: RecordId; revisionId: RevisionId }, number = 1) => ({ recordId: result.recordId, expectedRevisionId: result.revisionId, expectedRevisionNumber: number });

describe("preventive-care items and occurrences", () => {
  it("keeps the item, its occurrence and history separate; a correction never rewrites the earlier revision", async () => {
    const h = await setup();
    const item = committed(await h.service.createPreventiveItem({ payload: EYE }));
    const corrected = committed(await h.service.revisePreventiveItem({ ...expected(item), payload: { ...EYE, schedule: { kind: "TARGET_DATE", targetDate: "2026-11-04" as never } }, intent: "CORRECT" }));
    const history = await h.revisionsOf(item.recordId);
    expect(history.map((row) => row.revision.action).sort()).toEqual(["CORRECT", "CREATE"]);
    const outcome = committed(
      await h.service.recordPreventiveOutcome({
        payload: { careReference: { kind: "PLANNED_ITEM", item: { recordType: "PREVENTIVE_CARE_ITEM", recordId: item.recordId, revisionId: corrected.revisionId } }, completionReport: { kind: "PATIENT_REPORTED_COMPLETED" } },
        occurrence: DAY("2026-10-03"),
      }),
    );
    // Recording an occurrence does not touch the item.
    expect((await h.rows("PREVENTIVE_CARE_ITEM"))[0]!.headRevisionId).toBe(corrected.revisionId);
    expect((await h.revisionsOf(outcome.recordId))[0]!.revision.temporal).toEqual({ kind: "POINT", occurrence: DAY("2026-10-03") });
  });

  it("rejects an occurrence against a stale item revision with no partial write", async () => {
    const h = await setup();
    const item = committed(await h.service.createPreventiveItem({ payload: EYE }));
    committed(await h.service.revisePreventiveItem({ ...expected(item), payload: { ...EYE, trackingState: "PAUSED" }, intent: "SUPERSEDE" }));
    const stale = await h.service.recordPreventiveOutcome({
      payload: { careReference: { kind: "PLANNED_ITEM", item: { recordType: "PREVENTIVE_CARE_ITEM", recordId: item.recordId, revisionId: item.revisionId } }, completionReport: { kind: "PATIENT_REPORTED_COMPLETED" } },
      occurrence: DAY("2026-10-03"),
    });
    expect(stale).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
    expect(await h.rows("PREVENTIVE_CARE_RECORD")).toEqual([]);
  });

  it("keeps an unknown occurrence date unknown and lets the patient undo a mistaken report without keeping its content", async () => {
    const h = await setup();
    const outcome = committed(
      await h.service.recordPreventiveOutcome({
        payload: { careReference: { kind: "UNPLANNED", identity: { kind: "PATIENT_DEFINED", label: "Dental clean" } }, completionReport: { kind: "PATIENT_UNSURE" }, patientNote: { text: "Private words", language: "en-SG" } },
        occurrence: { kind: "UNKNOWN" },
      }),
    );
    expect((await h.revisionsOf(outcome.recordId))[0]!.revision.temporal).toEqual({ kind: "POINT", occurrence: { kind: "UNKNOWN" } });
    // An unplanned occurrence creates no plan or reminder.
    expect(await h.rows("PREVENTIVE_CARE_ITEM")).toEqual([]);
    expect(await h.rows("REMINDER")).toEqual([]);
    committed(await h.service.undoPreventiveOutcome(expected(outcome)));
    expect((await h.rows("PREVENTIVE_CARE_RECORD"))[0]!.state).toBe("DELETED");
    expect(await h.revisionsOf(outcome.recordId)).toEqual([]);
    expect(JSON.stringify(await h.database.table("deletionTombstones").toArray())).not.toContain("Private words");
  });

  it("replays an exact retry and rejects a stale second tab without partial writes", async () => {
    const h = await setup();
    const commandId = uuid();
    const first = committed(await h.service.createPreventiveItem({ payload: EYE, commandId }));
    expect(await h.service.createPreventiveItem({ payload: EYE, commandId })).toEqual(first);
    expect(await h.rows("PREVENTIVE_CARE_ITEM")).toHaveLength(1);
    committed(await h.service.revisePreventiveItem({ ...expected(first), payload: { ...EYE, trackingState: "PAUSED" }, intent: "SUPERSEDE" }));
    const before = await h.events();
    const secondTab = await h.service.revisePreventiveItem({ ...expected(first), payload: { ...EYE, trackingState: "ENDED" }, intent: "SUPERSEDE" });
    expect(secondTab).toEqual({ kind: "REJECTED", code: "HEAD_CONFLICT" });
    expect(await h.events()).toHaveLength(before.length);
  });

  it("rejects invalid input before any write", async () => {
    const h = await setup();
    const result = await h.service.createPreventiveItem({ payload: { ...EYE, schedule: { kind: "TARGET_DATE", targetDate: "2026-02-30" as never } } });
    expect(result).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
    expect(await h.events()).toEqual([]);
  });
});

describe("appointments", () => {
  it("records a scheduled visit and keeps it SCHEDULED after its time passes", async () => {
    const h = await setup();
    const visit = committed(await h.service.scheduleAppointment({ payload: VISIT, scheduledAt: AT("2026-10-14T01:40:00.000Z") }));
    h.setClock("2026-12-01T00:00:00.000Z");
    const [head] = await h.rows("APPOINTMENT");
    const [row] = await h.revisionsOf(visit.recordId);
    expect(head!.headRevisionNumber).toBe(1);
    expect(row!.revision.payload.status).toBe("SCHEDULED");
  });

  it("distinguishes correction, reschedule, cancellation and patient-reported outcome", async () => {
    const h = await setup();
    const visit = committed(await h.service.scheduleAppointment({ payload: VISIT, scheduledAt: AT("2026-10-14T01:40:00.000Z") }));
    const typo = committed(await h.service.reviseAppointment({ ...expected(visit), payload: { ...VISIT, appointmentLabel: "Dr Lim, Bukit Merah Polyclinic B" }, scheduledAt: AT("2026-10-14T01:40:00.000Z"), reason: "RECORDED_ERROR_CORRECTED" }));
    // A reschedule must move the time; a cancellation must not.
    expect(await h.service.reviseAppointment({ ...expected(typo, 2), payload: VISIT, scheduledAt: AT("2026-10-14T01:40:00.000Z"), reason: "RESCHEDULED" })).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
    const moved = committed(await h.service.reviseAppointment({ ...expected(typo, 2), payload: VISIT, scheduledAt: AT("2026-10-21T01:40:00.000Z"), reason: "RESCHEDULED" }));
    expect(await h.service.reviseAppointment({ ...expected(moved, 3), payload: { ...VISIT, status: "PATIENT_REPORTED_ATTENDED" }, scheduledAt: AT("2026-10-21T01:40:00.000Z"), reason: "CANCELLED" })).toEqual({
      kind: "FAILED",
      code: "VALIDATION_FAILED",
    });
    committed(await h.service.reviseAppointment({ ...expected(moved, 3), payload: { ...VISIT, status: "CANCELLED" }, scheduledAt: AT("2026-10-21T01:40:00.000Z"), reason: "CANCELLED" }));
    const history = (await h.revisionsOf(visit.recordId)).map((row) => row.revision.action).sort();
    expect(history).toEqual(["CORRECT", "CREATE", "SUPERSEDE", "SUPERSEDE"]);
    // Cancellation is history, not deletion; no preventive-care occurrence was created.
    expect((await h.rows("APPOINTMENT"))[0]!.state).toBe("ACTIVE");
    expect(await h.rows("PREVENTIVE_CARE_RECORD")).toEqual([]);
    const reasons = (await h.events()).filter((event) => event.eventName === "APPOINTMENT_REVISED").map((event) => event.payload);
    expect(reasons).toEqual([{ reasonCode: "RECORDED_ERROR_CORRECTED" }, { reasonCode: "RESCHEDULED" }, { reasonCode: "CANCELLED" }]);
  });

  it("moves only the exact dependent reminder to review when its appointment is rescheduled", async () => {
    const h = await setup();
    const visit = committed(await h.service.scheduleAppointment({ payload: VISIT, scheduledAt: AT("2026-10-14T01:40:00.000Z") }));
    const other = committed(await h.service.scheduleAppointment({ payload: { ...VISIT, appointmentLabel: "Dentist" }, scheduledAt: AT("2026-10-20T01:00:00.000Z") }));
    const carePlan = createCarePlanCommandService(h.database, {
      now: () => NOW,
      ids: { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid },
    });
    const reminder = (target: { recordId: RecordId; revisionId: RevisionId }) =>
      carePlan.createReminder({
        patientConfirmed: true,
        payload: {
          label: { text: "Visit", language: "und" },
          subject: { kind: "APPOINTMENT", target: { recordType: "APPOINTMENT", recordId: target.recordId, revisionId: target.revisionId } },
          schedule: { kind: "ONE_TIME", at: AT("2026-10-13T12:00:00.000Z") },
          state: "ACTIVE",
          deliveryPreference: "IN_APP_ONLY",
        },
      });
    const watching = committed(await reminder(visit));
    const unrelated = committed(await reminder(other));
    committed(await h.service.reviseAppointment({ ...expected(visit), payload: VISIT, scheduledAt: AT("2026-10-21T01:40:00.000Z"), reason: "RESCHEDULED" }));
    await h.reminders.processPending();
    const state = async (recordId: string) => {
      const head = (await h.rows("REMINDER")).find((row) => row.recordId === recordId)!;
      return ((await h.database.table("recordRevisions").get(head.headRevisionId)) as { revision: { payload: { state: string } } }).revision.payload.state;
    };
    expect(await state(watching.recordId)).toBe("REVIEW_REQUIRED");
    expect(await state(unrelated.recordId)).toBe("ACTIVE");
  });
});

describe("context windows and event minimisation", () => {
  it("records and supersedes a context with truthful interval ends", async () => {
    const h = await setup();
    const travel = committed(await h.service.recordContextWindow({ payload: { context: { kind: "TRAVEL" }, state: "PATIENT_REPORTED_ACTIVE" }, start: DAY("2026-09-28"), end: { kind: "OPEN" } }));
    expect(await h.service.reviseContextWindow({ ...expected(travel), payload: { context: { kind: "TRAVEL" }, state: "PATIENT_REPORTED_ENDED" }, start: DAY("2026-09-28"), end: { kind: "OPEN" }, intent: "SUPERSEDE" })).toEqual({
      kind: "FAILED",
      code: "VALIDATION_FAILED",
    });
    committed(await h.service.reviseContextWindow({ ...expected(travel), payload: { context: { kind: "TRAVEL" }, state: "PATIENT_REPORTED_ENDED" }, start: DAY("2026-09-28"), end: { kind: "ENDED_TIME_UNKNOWN" }, intent: "SUPERSEDE" }));
    expect((await h.revisionsOf(travel.recordId)).map((row) => row.revision.action).sort()).toEqual(["CREATE", "SUPERSEDE"]);
  });

  it("carries only closed reason codes in events, never notes, labels or dates", async () => {
    const h = await setup();
    committed(await h.service.createPreventiveItem({ payload: EYE }));
    committed(await h.service.scheduleAppointment({ payload: VISIT, scheduledAt: AT("2026-10-14T01:40:00.000Z") }));
    committed(await h.service.recordContextWindow({ payload: { context: { kind: "OTHER", label: { text: "Moving house", language: "en-SG" } }, state: "PLANNED" }, start: DAY("2026-10-10"), end: { kind: "UNKNOWN" } }));
    const text = JSON.stringify(await h.events());
    for (const leaked of ["Afternoon slot", "Dr Lim", "Bukit Merah", "Moving house", "2026-10-14", "2026-11-03"]) expect(text).not.toContain(leaked);
  });
});
