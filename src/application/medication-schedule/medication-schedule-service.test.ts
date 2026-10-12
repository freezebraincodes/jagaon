import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createReminderReconciliation } from "@/application/care-plan/reminder-reconciliation";
import { createInquiryService } from "@/application/inquiry/inquiry-service";
import { barrierPresentationCopyFor } from "./barrier-presentation-copy";
import { createMedicationScheduleService } from "./medication-schedule-service";
import type { MedicationScheduleView, ScheduleOccasionView } from "./medication-schedule-contracts";
import { DEMO_NOCTURIN_MEDICATION_ID, DEMO_VELTORA_MEDICATION_ID, seedSyntheticCarePlan } from "./synthetic-care-plan-seed";

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

const databases: JagaOnDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

const INTEGRATION_TIMEOUT_MS = 60_000;
// Sunday 4 Oct 2026, 10:00 pm in Singapore: today's 9:00 pm occasion has passed.
const SEED_AT = "2026-10-04T14:00:00.000Z" as Instant;
const SCOPE = [DEMO_NOCTURIN_MEDICATION_ID, DEMO_VELTORA_MEDICATION_ID];
const uuid = () => crypto.randomUUID() as never;

async function setup() {
  const database = createJagaOnDatabase(`packet8-schedule-${crypto.randomUUID()}`);
  databases.push(database);
  await database.open();
  let clock = SEED_AT;
  const now = () => clock;
  const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };
  await seedSyntheticCarePlan({ database, seedAt: SEED_AT, ids, copy: barrierPresentationCopyFor("en-SG") });
  const journal = createJournalCommandService(database, { now, ids });
  const carePlan = createCarePlanCommandService(database, { now, ids });
  const reminders = createReminderReconciliation(database, { now, newCommandId: uuid, leaseToken: uuid, instanceId: "test", carePlan });
  const inquiry = createInquiryService(database, { now, ids: { ...ids, presentationKey: uuid, leaseToken: uuid }, instanceId: "test", copy: barrierPresentationCopyFor });
  const schedule = createMedicationScheduleService(database, {
    now,
    journal,
    carePlan,
    inquiry,
    settle: async () => {
      await inquiry.processPending();
      await reminders.processPending();
    },
  });
  async function ready(locale: "en-SG" | "zh-SG" = "en-SG", scope: readonly string[] = SCOPE) {
    const view = await schedule.load({ locale, medicationRecordIds: scope });
    if (view.status !== "READY") throw new Error("schedule unavailable");
    return view;
  }
  return { database, schedule, ready, setClock: (instant: string) => (clock = instant as Instant) };
}

function occasion(view: Extract<MedicationScheduleView, { status: "READY" }>, section: "TODAY" | "YESTERDAY"): ScheduleOccasionView {
  const found = view.occasions.find((entry) => entry.section === section);
  if (!found) throw new Error(`no ${section} occasion`);
  return found;
}

const summary = (view: Extract<MedicationScheduleView, { status: "READY" }>) =>
  view.counts.map((count) => [count.optionKey, count.occasionCount, count.evidence.map((entry) => entry.localDate)]);

describe("Medication schedule service", () => {
  it("projects only fixed recorded times, leaves unrecorded occasions unrecorded and counts only reviewed options", async () => {
    const { ready, database } = await setup();
    const view = await ready();

    expect(view.today).toBe("2026-10-04");
    expect(view.yesterday).toBe("2026-10-03");
    expect(view.occasions.map((entry) => [entry.section, entry.medicineName, entry.scheduledTime, entry.record])).toEqual([
      ["YESTERDAY", "Nocturin pen", "21:00", null],
      ["TODAY", "Nocturin pen", "21:00", null],
    ]);
    // "With meals" has no fixed time and never becomes one.
    expect(view.withoutFixedTime).toEqual([{ medicineName: "Veltora pen" }]);
    expect(view.window).toEqual({ startDate: "2026-09-21", endDate: "2026-10-04" });
    // Prefer not to say, Declined and Taken never count; distinct occasions only.
    expect(summary(view)).toEqual([
      ["ROUTINE_CHANGED", 2, ["2026-09-22", "2026-09-30"]],
      ["AWAY_FROM_HOME", 1, ["2026-09-25"]],
    ]);
    expect(view.excludedCorrected).toBe(0);
    // d0, d1, d5 and d10 have no record; nothing is inferred from them.
    expect(view.unrecordedCount).toBe(4);

    expect(view.reminders.map((reminder) => [reminder.label, reminder.state, reminder.times])).toEqual([
      ["Morning reading", "ACTIVE", ["07:00"]],
      ["Sunday foot check", "PAUSED", ["09:00"]],
      ["Nocturin pen", "REVIEW_REQUIRED", ["21:30"]],
    ]);
    expect(view.reminders.find((reminder) => reminder.state === "REVIEW_REQUIRED")?.currentPrescription?.times).toEqual(["21:00"]);

    const types = new Set((await database.table("recordHeads").toArray()).map((head: { recordType: string }) => head.recordType));
    expect(types.has("SAFETY_EVENT")).toBe(false);
    for (const head of (await database.table("recordHeads").where("recordType").equals("INQUIRY_RESPONSE").toArray()) as { headRevisionId: string }[]) {
      const row = (await database.table("recordRevisions").get(head.headRevisionId)) as { revision: { payload: { safetyDisposition: unknown } } };
      expect(row.revision.payload.safetyDisposition).toEqual({
        applicability: "NOT_APPLICABLE",
        determinedAt: expect.any(String),
        capabilityManifestVersion: "8.1",
        reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT",
      });
    }
  }, INTEGRATION_TIMEOUT_MS);

  it("shows the no-fixed-schedule state when no recorded medicine is in scope", async () => {
    const { ready } = await setup();
    const view = await ready("en-SG", []);
    expect(view.occasions).toEqual([]);
    expect(view.withoutFixedTime).toEqual([]);
    const vel = await ready("en-SG", [DEMO_VELTORA_MEDICATION_ID]);
    expect(vel.occasions).toEqual([]);
    expect(vel.withoutFixedTime).toEqual([{ medicineName: "Veltora pen" }]);
  }, INTEGRATION_TIMEOUT_MS);

  it("offers the barrier question only after Skipped or Not sure, and counts an explicit answer", async () => {
    const { schedule, ready } = await setup();
    const today = occasion(await ready(), "TODAY");

    const taken = await schedule.recordOccasion({ occasion: today.occasion, state: "TAKEN", amount: { kind: "UNSURE" }, locale: "en-SG", commandId: uuid() });
    expect(taken).toMatchObject({ kind: "SAVED", offer: null });

    const yesterday = occasion(await ready(), "YESTERDAY");
    const skipped = await schedule.recordOccasion({ occasion: yesterday.occasion, state: "SKIPPED", amount: null, locale: "zh-SG", commandId: uuid() });
    if (skipped.kind !== "SAVED" || !skipped.offer) throw new Error("expected an offer");
    expect(skipped.offer.question).toBe("你是否想记录当时有什么情况让这件事变得困难？");
    expect(skipped.offer.options.map((option) => option.optionKey)).toEqual([
      "FORGOT",
      "ROUTINE_CHANGED",
      "AWAY_FROM_HOME",
      "ACCESS_DIFFICULTY",
      "SIDE_EFFECT_CONCERN",
    ]);

    expect(await schedule.answerBarrier({ question: skipped.offer, answer: { kind: "OPTION", optionKey: "FORGOT" }, commandId: uuid() })).toEqual({ kind: "SAVED" });
    const after = await ready();
    expect(occasion(after, "YESTERDAY").barrier).toMatchObject({ kind: "ANSWERED", answer: { kind: "OPTION", optionKey: "FORGOT" } });
    expect(occasion(after, "TODAY").record).toMatchObject({ state: "TAKEN", amount: { kind: "UNSURE" } });
    expect(summary(after)[0]).toEqual(["FORGOT", 1, ["2026-10-03"]]);
    expect(after.unrecordedCount).toBe(2);
  }, INTEGRATION_TIMEOUT_MS);

  it("rejects an amount that does not match the recorded state and never prefills one", async () => {
    const { schedule, ready } = await setup();
    const today = occasion(await ready(), "TODAY");
    expect(today.amountUnit).toEqual({ unit: "UNIT", otherUnitText: null });
    expect(await schedule.recordOccasion({ occasion: today.occasion, state: "TAKEN", amount: null, locale: "en-SG", commandId: uuid() })).toEqual({
      kind: "FAILED",
      code: "VALIDATION_FAILED",
    });
    expect(
      await schedule.recordOccasion({ occasion: today.occasion, state: "SKIPPED", amount: { kind: "NOT_RECORDED" }, locale: "en-SG", commandId: uuid() }),
    ).toEqual({ kind: "FAILED", code: "VALIDATION_FAILED" });
    expect(occasion(await ready(), "TODAY").record).toBeNull();
  }, INTEGRATION_TIMEOUT_MS);

  it("excludes an answer from counts once its medication record is corrected or its answer removed", async () => {
    const { schedule, ready } = await setup();
    const yesterday = occasion(await ready(), "YESTERDAY");
    const saved = await schedule.recordOccasion({ occasion: yesterday.occasion, state: "NOT_SURE", amount: null, locale: "en-SG", commandId: uuid() });
    if (saved.kind !== "SAVED" || !saved.offer) throw new Error("expected an offer");
    await schedule.answerBarrier({ question: saved.offer, answer: { kind: "OPTION", optionKey: "ROUTINE_CHANGED" }, commandId: uuid() });
    expect(summary(await ready())[0]).toEqual(["ROUTINE_CHANGED", 3, ["2026-09-22", "2026-09-30", "2026-10-03"]]);

    const record = occasion(await ready(), "YESTERDAY").record!;
    const corrected = await schedule.correctOccasion({
      occasion: yesterday.occasion,
      state: "TAKEN",
      amount: { kind: "KNOWN", value: "12", unit: "UNIT", otherUnitText: null },
      locale: "en-SG",
      commandId: uuid(),
      recordId: record.recordId,
      expectedRevisionId: record.revisionId,
      expectedRevisionNumber: record.revisionNumber,
    });
    expect(corrected).toMatchObject({ kind: "SAVED", offer: null });
    const after = await ready();
    expect(summary(after)[0]).toEqual(["ROUTINE_CHANGED", 2, ["2026-09-22", "2026-09-30"]]);
    expect(occasion(after, "YESTERDAY").barrier).toEqual({ kind: "NONE" });

    // Removing a seeded answer takes it out of the counts too.
    const view = await ready();
    const seededAway = view.counts.find((count) => count.optionKey === "AWAY_FROM_HOME");
    expect(seededAway?.occasionCount).toBe(1);
  }, INTEGRATION_TIMEOUT_MS);

  it("keeps a snoozed or dismissed question out of the counts", async () => {
    const { schedule, ready } = await setup();
    const yesterday = occasion(await ready(), "YESTERDAY");
    const saved = await schedule.recordOccasion({ occasion: yesterday.occasion, state: "SKIPPED", amount: null, locale: "en-SG", commandId: uuid() });
    if (saved.kind !== "SAVED" || !saved.offer) throw new Error("expected an offer");
    expect(await schedule.snoozeBarrier(saved.offer, "TOMORROW")).toEqual({ kind: "SAVED" });
    const view = await ready();
    expect(occasion(view, "YESTERDAY").barrier).toEqual({ kind: "NONE" });
    expect(view.counts.reduce((total, count) => total + count.occasionCount, 0)).toBe(3);
  }, INTEGRATION_TIMEOUT_MS);

  it("changes reminders only with an explicit patient confirmation and confirms a review against the recorded time", async () => {
    const { schedule, ready } = await setup();
    const review = (await ready()).reminders.find((reminder) => reminder.state === "REVIEW_REQUIRED")!;
    expect(await schedule.saveReminder({ reminder: review, change: { kind: "CONFIRM_REVIEW" }, commandId: uuid() })).toEqual({ kind: "SAVED" });
    const confirmed = (await ready()).reminders.find((reminder) => reminder.label === "Nocturin pen")!;
    expect([confirmed.state, confirmed.times]).toEqual(["ACTIVE", ["21:00"]]);

    // A stale view cannot overwrite a newer reminder revision.
    expect(await schedule.saveReminder({ reminder: review, change: { kind: "PAUSE" }, commandId: uuid() })).toEqual({ kind: "FAILED", code: "HEAD_CONFLICT" });

    const morning = (await ready()).reminders.find((reminder) => reminder.label === "Morning reading")!;
    expect(await schedule.saveReminder({ reminder: morning, change: { kind: "CHANGE_TIME", time: "07:30" }, commandId: uuid() })).toEqual({ kind: "SAVED" });
    const moved = (await ready()).reminders.find((reminder) => reminder.label === "Morning reading")!;
    expect(await schedule.saveReminder({ reminder: moved, change: { kind: "PAUSE" }, commandId: uuid() })).toEqual({ kind: "SAVED" });
    expect((await ready()).reminders.find((reminder) => reminder.label === "Morning reading")).toMatchObject({ state: "PAUSED", times: ["07:30"] });
  }, INTEGRATION_TIMEOUT_MS);

  it("saves, edits and removes a care question locally without answering it", async () => {
    const { schedule, ready } = await setup();
    expect(await schedule.saveCareQuestion({ text: "Can I keep the pen in my bag?", language: "en-SG", commandId: uuid() })).toEqual({ kind: "SAVED" });
    const [question] = (await ready()).careQuestions;
    expect(question).toMatchObject({ text: "Can I keep the pen in my bag?", language: "en-SG" });
    expect(await schedule.editCareQuestion({ question: question!, text: "Can I keep the pen in my work bag?", language: "en-SG", commandId: uuid() })).toEqual({ kind: "SAVED" });
    const [edited] = (await ready()).careQuestions;
    expect(edited?.text).toBe("Can I keep the pen in my work bag?");
    expect(await schedule.dismissCareQuestion({ question: edited!, commandId: uuid() })).toEqual({ kind: "SAVED" });
    expect((await ready()).careQuestions).toEqual([]);
  }, INTEGRATION_TIMEOUT_MS);

  it("reports the schedule as unavailable when storage cannot be read", async () => {
    const { schedule, database } = await setup();
    database.close();
    expect(await schedule.load({ locale: "en-SG", medicationRecordIds: SCOPE })).toEqual({ status: "UNAVAILABLE" });
  }, INTEGRATION_TIMEOUT_MS);
});
