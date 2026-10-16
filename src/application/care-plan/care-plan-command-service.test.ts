import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { ReminderPayload } from "@/domain/care-plan/reminder";
import { createPacket8Harness, LANTUS_PRESCRIPTION, type Packet8Harness } from "@/application/packet8-test-harness";

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
const open: Packet8Harness[] = [];
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

async function setup() {
  const harness = await createPacket8Harness();
  open.push(harness);
  return harness;
}

function medicationReminder(h: Packet8Harness, state: ReminderPayload["state"] = "ACTIVE"): ReminderPayload {
  return {
    label: { text: "Lantus (demo)", language: "und" },
    subject: { kind: "MEDICATION", target: h.prescriptionRef },
    schedule: { kind: "WEEKLY_LOCAL", daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"], times: ["21:00" as never], timeZoneId: "Asia/Singapore" },
    state,
    deliveryPreference: "IN_APP_ONLY",
  };
}

async function reminderState(h: Packet8Harness, recordId: string) {
  const head = (await h.database.table("recordHeads").get(recordId)) as { headRevisionId: string };
  const row = await h.revision(head.headRevisionId);
  return row!.revision as unknown as { action: string; provenance: { initiator: string }; payload: ReminderPayload };
}

describe("reminder lifecycle", () => {
  it("requires explicit patient confirmation to create a reminder", async () => {
    const h = await setup();
    const refused = await h.carePlan.createReminder({ payload: medicationReminder(h), patientConfirmed: false as never });
    expect(refused).toEqual({ kind: "FAILED", code: "CONFIRMATION_REQUIRED" });
    expect(await h.rows("REMINDER")).toEqual([]);
  });

  it("creates an in-app reminder with an exact edge to the relayed prescription revision and no medication fact", async () => {
    const h = await setup();
    const created = await h.carePlan.createReminder({ payload: medicationReminder(h), patientConfirmed: true });
    expect(created.kind).toBe("COMMITTED");
    if (created.kind !== "COMMITTED") return;
    const edges = await h.database.table("reverseDependencies").where("sourceRevisionId").equals(h.prescriptionRef.revisionId).toArray();
    expect(edges).toEqual([expect.objectContaining({ owner: "CARE_PLAN", dependentRecordType: "REMINDER", dependentRecordId: created.recordId })]);
    expect(await h.rows("MEDICATION_EVENT")).toEqual([]);
    expect(await h.database.table("eventWorkItems").count()).toBe(0);
  });

  it("pauses, resumes and ends only through patient-confirmed revisions that record nothing about the action", async () => {
    const h = await setup();
    const created = await h.carePlan.createReminder({ payload: medicationReminder(h), patientConfirmed: true });
    if (created.kind !== "COMMITTED") throw new Error("create failed");
    const paused = await h.carePlan.reviseReminder({
      recordId: created.recordId,
      expectedRevisionId: created.revisionId,
      expectedRevisionNumber: 1,
      payload: medicationReminder(h, "PAUSED"),
      intent: "SUPERSEDE",
      reason: "PAUSED",
      patientConfirmed: true,
    });
    expect(paused.kind).toBe("COMMITTED");
    if (paused.kind !== "COMMITTED") return;
    expect((await reminderState(h, created.recordId)).payload.state).toBe("PAUSED");
    const stale = await h.carePlan.reviseReminder({
      recordId: created.recordId,
      expectedRevisionId: created.revisionId,
      expectedRevisionNumber: 1,
      payload: medicationReminder(h, "ENDED"),
      intent: "SUPERSEDE",
      reason: "ENDED",
      patientConfirmed: true,
    });
    expect(stale).toEqual({ kind: "REJECTED", code: "HEAD_CONFLICT" });
    const ended = await h.carePlan.reviseReminder({
      recordId: created.recordId,
      expectedRevisionId: paused.revisionId,
      expectedRevisionNumber: 2,
      payload: medicationReminder(h, "ENDED"),
      intent: "SUPERSEDE",
      reason: "ENDED",
      patientConfirmed: true,
    });
    expect(ended.kind).toBe("COMMITTED");
    expect(await h.rows("MEDICATION_EVENT")).toEqual([]);
    expect(await h.rows("INQUIRY")).toEqual([]);
  });

  it("cannot set review-required itself or activate against a superseded source", async () => {
    const h = await setup();
    const created = await h.carePlan.createReminder({ payload: medicationReminder(h, "PAUSED"), patientConfirmed: true });
    if (created.kind !== "COMMITTED") throw new Error("create failed");
    const review = await h.carePlan.reviseReminder({
      recordId: created.recordId,
      expectedRevisionId: created.revisionId,
      expectedRevisionNumber: 1,
      payload: medicationReminder(h, "REVIEW_REQUIRED"),
      intent: "SUPERSEDE",
      reason: "PAUSED",
      patientConfirmed: true,
    });
    expect(review).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
  });

  it("replays an exact retry of the same creation command without a duplicate reminder", async () => {
    const h = await setup();
    const commandId = crypto.randomUUID() as never;
    const first = await h.carePlan.createReminder({ payload: medicationReminder(h), patientConfirmed: true, commandId });
    const second = await h.carePlan.createReminder({ payload: medicationReminder(h), patientConfirmed: true, commandId });
    expect(second).toEqual(first);
    expect(await h.rows("REMINDER")).toHaveLength(1);
  });
});

describe("source change reconciliation", () => {
  it("moves only reminders relaying the corrected prescription revision to review and suspends them", async () => {
    const h = await setup();
    const active = await h.carePlan.createReminder({ payload: medicationReminder(h, "ACTIVE"), patientConfirmed: true });
    const paused = await h.carePlan.createReminder({ payload: medicationReminder(h, "PAUSED"), patientConfirmed: true });
    const ended = await h.carePlan.createReminder({ payload: medicationReminder(h, "ENDED"), patientConfirmed: true });
    const custom = await h.carePlan.createReminder({
      payload: { ...medicationReminder(h), label: { text: "Sunday foot check", language: "und" }, subject: { kind: "CUSTOM" } },
      patientConfirmed: true,
    });
    if ([active, paused, ended, custom].some((result) => result.kind !== "COMMITTED")) throw new Error("create failed");
    const corrected = await h.carePlan.correctPrescriptionVersion({
      recordId: h.prescriptionRef.recordId,
      expectedRevisionId: h.prescriptionRef.revisionId,
      expectedRevisionNumber: 1,
      payload: { ...LANTUS_PRESCRIPTION, schedule: { kind: "FIXED_LOCAL_TIMES", entries: [{ scheduleKey: "night", time: "21:30" as never }] } },
    });
    expect(corrected.kind).toBe("COMMITTED");
    const report = await h.reminders.processPending();
    expect(report).toMatchObject({ claimedWorkItems: 1, committedCommands: 2, failed: false });
    const id = (result: typeof active) => (result.kind === "COMMITTED" ? result.recordId : "");
    const review = await reminderState(h, id(active));
    expect(review.payload.state).toBe("REVIEW_REQUIRED");
    expect(review.action).toBe("SYSTEM_DERIVE");
    expect(review.provenance.initiator).toBe("JAGAON_SYSTEM");
    // The reminder is not silently rewritten to the corrected time.
    expect(review.payload.schedule).toEqual(medicationReminder(h).schedule);
    expect((await reminderState(h, id(paused))).payload.state).toBe("REVIEW_REQUIRED");
    expect((await reminderState(h, id(ended))).payload.state).toBe("ENDED");
    expect((await reminderState(h, id(custom))).payload.state).toBe("ACTIVE");
    expect(await h.reminders.processPending()).toMatchObject({ claimedWorkItems: 0 });
  });

  it("re-activates a reviewed reminder only against the current recorded prescription revision", async () => {
    const h = await setup();
    const created = await h.carePlan.createReminder({ payload: medicationReminder(h), patientConfirmed: true });
    if (created.kind !== "COMMITTED") throw new Error("create failed");
    const corrected = await h.carePlan.correctPrescriptionVersion({
      recordId: h.prescriptionRef.recordId,
      expectedRevisionId: h.prescriptionRef.revisionId,
      expectedRevisionNumber: 1,
      payload: LANTUS_PRESCRIPTION,
    });
    if (corrected.kind !== "COMMITTED") throw new Error("correct failed");
    await h.reminders.processPending();
    const head = (await h.database.table("recordHeads").get(created.recordId)) as { headRevisionId: string; headRevisionNumber: number };
    const stale = await h.carePlan.reviseReminder({
      recordId: created.recordId,
      expectedRevisionId: head.headRevisionId as never,
      expectedRevisionNumber: head.headRevisionNumber,
      payload: medicationReminder(h, "ACTIVE"),
      intent: "SUPERSEDE",
      reason: "REVIEW_CONFIRMED",
      patientConfirmed: true,
    });
    expect(stale).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
    const current = { recordType: "PRESCRIPTION_VERSION" as const, recordId: corrected.recordId, revisionId: corrected.revisionId };
    const confirmed = await h.carePlan.reviseReminder({
      recordId: created.recordId,
      expectedRevisionId: head.headRevisionId as never,
      expectedRevisionNumber: head.headRevisionNumber,
      payload: { ...medicationReminder(h, "ACTIVE"), subject: { kind: "MEDICATION", target: current } },
      intent: "SUPERSEDE",
      reason: "REVIEW_CONFIRMED",
      patientConfirmed: true,
    });
    expect(confirmed.kind).toBe("COMMITTED");
    expect((await reminderState(h, created.recordId)).payload.state).toBe("ACTIVE");
  });
});

describe("care questions", () => {
  it("saves, edits and dismisses a patient-authored question without any answer or delivery state", async () => {
    const h = await setup();
    const created = await h.carePlan.createCareQuestion({ questionText: { text: "我可以把笔放在车里吗？", language: "zh-SG" } });
    if (created.kind !== "COMMITTED") throw new Error("create failed");
    const first = await h.revision(created.revisionId);
    expect(first!.revision.payload).toMatchObject({ origin: { kind: "PATIENT_AUTHORED" }, state: "READY_TO_ASK", questionText: { text: "我可以把笔放在车里吗？", language: "zh-SG" } });
    const edited = await h.carePlan.reviseCareQuestion({
      recordId: created.recordId,
      expectedRevisionId: created.revisionId,
      expectedRevisionNumber: 1,
      questionText: { text: "Can I keep my pen in the car?", language: "en-SG" },
      state: "READY_TO_ASK",
    });
    expect(edited.kind).toBe("COMMITTED");
    const history = await h.database.table("recordRevisions").where("recordId").equals(created.recordId).count();
    expect(history).toBe(2);
    if (edited.kind !== "COMMITTED") return;
    const dismissed = await h.carePlan.reviseCareQuestion({
      recordId: created.recordId,
      expectedRevisionId: edited.revisionId,
      expectedRevisionNumber: 2,
      questionText: { text: "Can I keep my pen in the car?", language: "en-SG" },
      state: "DISMISSED",
    });
    expect(dismissed.kind).toBe("COMMITTED");
    expect(await h.rows("INQUIRY")).toEqual([]);
  });
});
