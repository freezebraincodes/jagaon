import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { Instant } from "@/domain/shared";
import { createJagaOnDatabase, type JagaOnDatabase } from "@/storage/database";
import { createCarePlanCommandService } from "@/application/care-plan/care-plan-command-service";
import { createJournalCommandService } from "@/application/journal/journal-command-service";
import { createCareOrganisationService } from "./care-organisation-service";
import { createCareOrganisationQuery, VISIT_PREPARATION_PERIOD_DAYS } from "./care-organisation-query";
import { SYNTHETIC_CARE_QUESTION_TEXT, seedSyntheticCareOrganisation } from "./synthetic-care-organisation-seed";
import { seedSyntheticCarePlan } from "@/application/medication-schedule/synthetic-care-plan-seed";
import { barrierPresentationCopyFor } from "@/application/medication-schedule/barrier-presentation-copy";

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
// Sunday 4 Oct 2026, 10:00 in Singapore.
const NOW = "2026-10-04T02:00:00.000Z" as Instant;
const ids = { commandId: uuid, correlationId: uuid, recordId: uuid, revisionId: uuid, auditEventId: uuid, transactionId: uuid, domainEventId: uuid, workItemId: uuid };

async function setup(now = NOW) {
  const database = createJagaOnDatabase(`packet9b-query-${crypto.randomUUID()}`);
  open.push(database);
  await database.open();
  let clock = now;
  const carePlan = createCarePlanCommandService(database, { now: () => clock, ids });
  const service = createCareOrganisationService(database, { now: () => clock, ids, carePlan });
  const query = createCareOrganisationQuery(database, { now: () => clock });
  return { database, service, query, setClock: (value: string) => (clock = value as Instant) };
}

describe("Screen 09 preventive-care projection", () => {
  it("projects the four fixture items with entered dates, notes, source text and status — never due or overdue", async () => {
    const h = await setup();
    expect(await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids })).toBe("SEEDED");
    const view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.items.map((item) => [item.payload.identity.kind === "PATIENT_DEFINED" ? item.payload.identity.label : item.payload.identity.catalogueEntryKey, item.status, item.dateEntered])).toEqual([
      ["EYE_SCREENING", "SCHEDULED", { kind: "TARGET", localDate: "2026-11-03" }],
      ["BLOOD_TEST", "SCHEDULED", { kind: "TARGET", localDate: "2026-10-14" }],
      ["FOOT_CHECK", "RECORDED", { kind: "OCCURRENCE", occurrence: { kind: "DATE_ONLY", localDate: "2026-09-14", timeZoneId: "Asia/Singapore" } }],
      ["FLU_VACCINE", "NO_DATE", null],
    ]);
    expect(view.items[0]!.payload.patientReportedPlanText?.text).toBe("Appointment letter, 2 Sep 2026");
    expect(view.items[3]!.payload.patientNote?.text).toBe("Want to ask the clinic");
    expect(JSON.stringify(view)).not.toMatch(/due|overdue|eligib|missed|complete[ds]?\b/i);
  });

  it("does not treat a passed entered date as overdue or a missing record as missed", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    h.setClock("2027-06-01T00:00:00.000Z");
    const view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.items.map((item) => item.status)).toEqual(["SCHEDULED", "SCHEDULED", "RECORDED", "NO_DATE"]);
  });

  it("returns to scheduled after the patient undoes the report, and records history", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    let view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    const foot = view.items[2]!;
    expect(foot.history.map((entry) => entry.kind)).toEqual(["ITEM", "RECORD"]);
    const record = foot.currentRecord!;
    expect((await h.service.undoPreventiveOutcome({ recordId: record.recordId, expectedRevisionId: record.revisionId, expectedRevisionNumber: record.revisionNumber })).kind).toBe("COMMITTED");
    view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.items[2]!.status).toBe("SCHEDULED");
  });

  it("relays every reported completion by catalogue key for the HSA preview, planned or not, without changing any item", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    let view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    // The seed's earlier eye screening and blood test are reported without a plan; the foot check against its item.
    expect(view.reportedCompletions).toEqual([
      { catalogueEntryKey: "BLOOD_TEST", localDate: "2026-05-12" },
      { catalogueEntryKey: "EYE_SCREENING", localDate: "2025-09-09" },
      { catalogueEntryKey: "FOOT_CHECK", localDate: "2026-09-14" },
    ]);
    // An undone report is no longer relayed.
    const record = view.items[2]!.currentRecord!;
    await h.service.undoPreventiveOutcome({ recordId: record.recordId, expectedRevisionId: record.revisionId, expectedRevisionNumber: record.revisionNumber });
    view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.reportedCompletions!.map((entry) => entry.catalogueEntryKey)).toEqual(["BLOOD_TEST", "EYE_SCREENING"]);
  });

  it("keeps a report through a correction but not through a superseding new plan", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    let view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    const foot = view.items[2]!;
    const target = { recordId: foot.recordId, expectedRevisionId: foot.revisionId, expectedRevisionNumber: foot.revisionNumber };
    const corrected = await h.service.revisePreventiveItem({ ...target, payload: { ...foot.payload, patientNote: { text: "Left foot", language: "en-SG" } }, intent: "CORRECT" });
    if (corrected.kind !== "COMMITTED") throw new Error("committed");
    view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.items[2]!.status).toBe("RECORDED");
    await h.service.revisePreventiveItem({
      recordId: foot.recordId,
      expectedRevisionId: corrected.revisionId,
      expectedRevisionNumber: 2,
      payload: { ...foot.payload, schedule: { kind: "TARGET_DATE", targetDate: "2027-09-14" as never } },
      intent: "SUPERSEDE",
    });
    view = await h.query.loadPreventiveCare();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.items[2]!.status).toBe("SCHEDULED");
  });

  it("places a medication record with an unknown time by the occasion it was recorded for", async () => {
    const h = await setup();
    // The Packet 8 fixture records missed and unsure occasions with no known time.
    await seedSyntheticCarePlan({ database: h.database, seedAt: NOW, ids, copy: barrierPresentationCopyFor("en-SG") });
    const view = await h.query.loadVisitPreparation();
    if (view.status !== "READY") throw new Error("ready");
    const insulin = view.factGroups.find((group) => group.key === "INSULIN")!;
    expect(insulin.sources.length).toBeGreaterThan(0);
    expect(insulin.sources.every((source) => source.recordType === "MEDICATION_EVENT")).toBe(true);
  });

  it("reports unavailable storage instead of an empty list", async () => {
    const h = await setup();
    h.database.close();
    expect(await h.query.loadPreventiveCare()).toEqual({ status: "UNAVAILABLE" });
    expect(await h.query.loadVisitPreparation()).toEqual({ status: "UNAVAILABLE" });
  });
});

describe("Screen 10 visit-preparation projection", () => {
  it("seeds one demo question of the patient's own for the appointment (owner decision 2026-10-12)", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    const view = await h.query.loadVisitPreparation();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.questions).toEqual([expect.objectContaining({ text: SYNTHETIC_CARE_QUESTION_TEXT, language: "und", relatedAppointment: view.appointment!.recordId })]);
  });

  it("shows the next recorded appointment, the patient's own questions and in-period fact sources only", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids, demoQuestion: false });
    const journal = createJournalCommandService(h.database, { now: () => NOW, ids });
    const glucose = (instantUtc: string) =>
      journal.recordGlucose({
        payload: { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "PATIENT_SELECTED_SLOT", slot: "BEDTIME" } },
        temporal: { kind: "POINT", occurrence: { kind: "EXACT", instantUtc: instantUtc as Instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 } },
        recordedAt: NOW,
      });
    await glucose("2026-10-03T13:00:00.000Z");
    // Owner instruction 2026-10-12: the period is the 14 local days ending today (was 30), so it starts at 21 Sep 00:00 SGT.
    expect(VISIT_PREPARATION_PERIOD_DAYS).toBe(14);
    await glucose("2026-09-20T16:30:00.000Z"); // 21 Sep 00:30 SGT: the period's first local day
    await glucose("2026-09-20T15:30:00.000Z"); // 20 Sep 23:30 SGT: outside the 14-day period (was inside the 30-day one)
    await glucose("2026-08-01T13:00:00.000Z"); // outside the period
    const initial = await h.query.loadVisitPreparation();
    if (initial.status !== "READY" || !initial.appointment) throw new Error("ready");
    const appointment = initial.appointment;
    expect(appointment.payload.appointmentLabel).toBe("Dr Lim, Bukit Merah Polyclinic");
    expect(appointment.scheduledAt).toMatchObject({ kind: "EXACT", instantUtc: "2026-10-14T01:40:00.000Z" });
    expect(await h.service.createCareQuestion({
      questionText: { text: "可以把笔放在包里吗？", language: "zh-SG" },
      relatedAppointment: { recordType: "APPOINTMENT", recordId: appointment.recordId, revisionId: appointment.revisionId },
    })).toMatchObject({ kind: "COMMITTED" });
    const view = await h.query.loadVisitPreparation();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.period).toEqual({ startAt: "2026-09-20T16:00:00.000Z", endAtExclusive: "2026-10-04T16:00:00.000Z", startDate: "2026-09-21", endDate: "2026-10-04" });
    expect(view.questions).toEqual([expect.objectContaining({ text: "可以把笔放在包里吗？", language: "zh-SG", relatedAppointment: appointment.recordId })]);
    expect(view.factGroups.map((group) => [group.key, group.sources.length])).toEqual([
      ["GLUCOSE", 2],
      ["INSULIN", 0],
      ["MEALS", 0],
      ["WALKS", 0],
    ]);
  });

  it("keeps a passed appointment unchanged and simply shows no upcoming appointment", async () => {
    const h = await setup("2026-12-01T00:00:00.000Z" as Instant);
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    const view = await h.query.loadVisitPreparation();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.appointment).toBeNull();
    const [head] = (await h.database.table("recordHeads").where("recordType").equals("APPOINTMENT").toArray()) as Array<{ headRevisionNumber: number }>;
    expect(head!.headRevisionNumber).toBe(1);
  });
});

describe("synthetic care-organisation seed", () => {
  it("adds fixture heads only when none exist", async () => {
    const h = await setup();
    expect(await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids })).toBe("SEEDED");
    expect(await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids })).toBe("SKIPPED");
    expect(await h.database.table("recordHeads").where("recordType").equals("PREVENTIVE_CARE_ITEM").count()).toBe(4);
    // Owner decision 2026-10-16: the upcoming visit and one earlier visit the patient reported attending (was 1).
    expect(await h.database.table("recordHeads").where("recordType").equals("APPOINTMENT").count()).toBe(2);
  });

  it("records the earlier visit with Dr Lim 35 days before the seed day as the patient's own attended report (owner decision 2026-10-16)", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    const overview = await h.query.loadPeriodOverview!("SINCE_LAST_VISIT");
    if (overview.status !== "READY") throw new Error("ready");
    expect(overview.lastVisit).toMatchObject({ localDate: "2026-08-30" });
    // The upcoming visit is unchanged: still the one shown on visit preparation.
    const view = await h.query.loadVisitPreparation();
    if (view.status !== "READY") throw new Error("ready");
    expect(view.appointment?.scheduledAt).toMatchObject({ instantUtc: "2026-10-14T01:40:00.000Z" });
  });
});

describe("Screen 10 period overview (owner decision 2026-10-16)", () => {
  const local = (localDate: string, time: string) => ({
    kind: "POINT" as const,
    occurrence: { kind: "EXACT" as const, instantUtc: new Date(Date.parse(`${localDate}T${time}:00.000Z`) - 8 * 3_600_000).toISOString() as Instant, timeZoneId: "Asia/Singapore", utcOffsetMinutes: 480 },
  });

  async function journalOf(h: Awaited<ReturnType<typeof setup>>) {
    const journal = createJournalCommandService(h.database, { now: () => NOW, ids });
    return {
      glucose: (localDate: string, time = "07:00") =>
        journal.recordGlucose({
          payload: { measurement: { enteredValue: "6.6" as never, enteredUnit: "MMOL_L", normalization: null }, measurementMethod: "FINGERSTICK_METER", context: { kind: "UNSPECIFIED" } },
          temporal: local(localDate, time),
          recordedAt: NOW,
        } as never),
      meal: (localDate: string) =>
        journal.recordMeal({
          payload: { intakeKind: "MEAL", intakeSlot: { kind: "STANDARD_MEAL", code: "BREAKFAST" }, occasion: "ROUTINE", foodIncluded: "YES", drinkIncluded: "UNKNOWN", items: [{ kind: "FOOD", label: "Kaya toast" }] },
          temporal: local(localDate, "07:30"),
          recordedAt: NOW,
        } as never),
      walk: (localDate: string) =>
        journal.recordActivity({ payload: { activityCategory: "WALKING", patientLabel: "Morning walk", reportedDurationMinutes: 20 }, temporal: local(localDate, "06:45"), recordedAt: NOW } as never),
    };
  }

  it("counts each kind of record in the chosen period, the saved questions and who they are for", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    const journal = await journalOf(h);
    await journal.glucose("2026-10-04"); // today
    await journal.glucose("2026-09-28"); // the first of the last 7 days
    await journal.glucose("2026-09-27"); // 8 days ago: in the last 14 and 30 days only
    await journal.glucose("2026-09-05"); // the first of the last 30 days
    await journal.glucose("2026-09-04"); // outside every fixed period
    await journal.meal("2026-10-02");
    await journal.meal("2026-09-20");
    await journal.walk("2026-10-03");

    const counts = async (choice: "LAST_7_DAYS" | "LAST_14_DAYS" | "LAST_30_DAYS") => {
      const view = await h.query.loadPeriodOverview!(choice);
      if (view.status !== "READY") throw new Error("ready");
      return { choice: view.choice, period: [view.period.startDate, view.period.endDate], counts: view.counts };
    };
    expect(await counts("LAST_7_DAYS")).toEqual({ choice: "LAST_7_DAYS", period: ["2026-09-28", "2026-10-04"], counts: { GLUCOSE: 2, INSULIN: 0, MEALS: 1, WALKS: 1 } });
    expect(await counts("LAST_14_DAYS")).toEqual({ choice: "LAST_14_DAYS", period: ["2026-09-21", "2026-10-04"], counts: { GLUCOSE: 3, INSULIN: 0, MEALS: 1, WALKS: 1 } });
    expect(await counts("LAST_30_DAYS")).toEqual({ choice: "LAST_30_DAYS", period: ["2026-09-05", "2026-10-04"], counts: { GLUCOSE: 4, INSULIN: 0, MEALS: 2, WALKS: 1 } });

    const view = await h.query.loadPeriodOverview!("LAST_30_DAYS");
    if (view.status !== "READY") throw new Error("ready");
    expect([view.questionCount, view.questionsFor]).toEqual([1, "Dr Lim"]);
  });

  it("counts since the visit the patient reported attending, from the visit's own time", async () => {
    const h = await setup();
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    const journal = await journalOf(h);
    await journal.glucose("2026-08-30", "08:00"); // the visit day, before the 10:20 visit
    await journal.glucose("2026-08-30", "12:00"); // the visit day, after it
    await journal.glucose("2026-10-01");
    const view = await h.query.loadPeriodOverview!("SINCE_LAST_VISIT");
    if (view.status !== "READY") throw new Error("ready");
    expect(view.choice).toBe("SINCE_LAST_VISIT");
    expect(view.period).toMatchObject({ startAt: "2026-08-30T02:20:00.000Z", startDate: "2026-08-30", endDate: "2026-10-04" });
    expect(view.counts.GLUCOSE).toBe(2);
  });

  it("never takes a passed appointment as a visit, and counts the last 30 days when no visit is on record", async () => {
    const h = await setup("2026-12-01T00:00:00.000Z" as Instant);
    await seedSyntheticCareOrganisation({ database: h.database, seedAt: NOW, ids });
    // The 14 Oct appointment has passed but is still only scheduled; the attended 30 Aug visit stays the last visit.
    const later = await h.query.loadPeriodOverview!("SINCE_LAST_VISIT");
    expect(later).toMatchObject({ status: "READY", choice: "SINCE_LAST_VISIT", lastVisit: { localDate: "2026-08-30" }, questionsFor: null });

    const empty = await setup();
    const view = await empty.query.loadPeriodOverview!("SINCE_LAST_VISIT");
    expect(view).toMatchObject({ status: "READY", choice: "LAST_30_DAYS", lastVisit: null, questionCount: 0, questionsFor: null, counts: { GLUCOSE: 0, INSULIN: 0, MEALS: 0, WALKS: 0 } });
  });

  it("reports unavailable storage instead of zero counts", async () => {
    const h = await setup();
    h.database.close();
    expect(await h.query.loadPeriodOverview!("LAST_7_DAYS")).toEqual({ status: "UNAVAILABLE" });
  });
});
