import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Dexie from "dexie";
import fakeIndexedDB, { IDBKeyRange as FDBKeyRange } from "fake-indexeddb";
import type { RecordId } from "@/domain/shared";
import { createPacket8Harness, type Packet8Harness } from "@/application/packet8-test-harness";
import { createInquiryService } from "./inquiry-service";
import { buildInquiryCommitPlan, createInquiryCommandStore } from "./inquiry-persistence";
import { INQUIRY_CAPABILITY_MANIFEST } from "@/inquiry/inquiry-capability-manifest";
import { responseRevision } from "@/domain/inquiry/inquiry-test-fixtures";

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

const cmd = () => crypto.randomUUID() as never;

async function inquiryHeads(h: Packet8Harness) {
  const heads = await h.rows("INQUIRY");
  return Promise.all(heads.map(async (head) => ({ head, payload: (await h.revision(head.headRevisionId))?.revision.payload as { lifecycle: { state: string } } | undefined })));
}

async function presentFor(h: Packet8Harness, state: "MISSED" | "UNSURE" = "MISSED", daysBefore = 1) {
  const saved = await h.record(state, daysBefore);
  await h.inquiry.processPending();
  const offer = await h.inquiry.offerForMedicationEvent(saved.recordId, "en-SG");
  if (offer.kind !== "PRESENTED") throw new Error(`NOT_PRESENTED:${JSON.stringify(offer)}`);
  return { saved, question: offer.question };
}

describe("absent and non-triggering records", () => {
  it("creates no inquiry, work or answer from a schedule with no record", async () => {
    const h = await setup();
    expect(await h.inquiry.processPending()).toEqual({ claimedWorkItems: 0, committedCommands: 0, failed: false });
    expect(await h.rows("INQUIRY")).toEqual([]);
    expect(await h.rows("INQUIRY_RESPONSE")).toEqual([]);
  });

  it("creates no inquiry work for a taken or declined record", async () => {
    const h = await setup();
    await h.record("TAKEN");
    await h.record("DECLINED_TO_RECORD", 2);
    expect(await h.database.table("eventWorkItems").count()).toBe(0);
    await h.inquiry.processPending();
    expect(await h.rows("INQUIRY")).toEqual([]);
  });
});

describe("explicit Skipped record to presented question", () => {
  it("builds an eligible candidate bound to the exact event revision and presents it once", async () => {
    const h = await setup();
    const { saved, question } = await presentFor(h);
    expect(question.leadIn).toBe("You recorded Skipped for Nocturin pen on 2026-10-02. Answering is optional.");
    expect(question.options.map((option) => option.optionKey)).toEqual(["FORGOT", "ROUTINE_CHANGED", "AWAY_FROM_HOME", "ACCESS_DIFFICULTY", "SIDE_EFFECT_CONCERN"]);
    const edges = await h.database.table("reverseDependencies").where("sourceRevisionId").equals(saved.revisionId).toArray();
    expect(edges).toEqual([expect.objectContaining({ owner: "INQUIRY", dependentRecordType: "INQUIRY", dependencyRole: "INQUIRY_BASIS" })]);
    const states = (await h.database.table("recordRevisions").where("recordId").equals(question.inquiryRecordId).toArray()).map(
      (row: { revision: { payload: { lifecycle: { state: string } } } }) => row.revision.payload.lifecycle.state,
    );
    expect(states.sort()).toEqual(["CANDIDATE", "ELIGIBLE", "ELIGIBLE", "PRESENTED", "QUEUED"].sort());
    const again = await h.inquiry.offerForMedicationEvent(saved.recordId, "en-SG");
    expect(again.kind === "PRESENTED" && again.question.presentationKey).toBe(question.presentationKey);
  });

  it("re-presents in the other locale with identical options and a new presentation key", async () => {
    const h = await setup();
    const { saved, question } = await presentFor(h);
    const zh = await h.inquiry.offerForMedicationEvent(saved.recordId, "zh-SG");
    expect(zh.kind).toBe("PRESENTED");
    if (zh.kind !== "PRESENTED") return;
    expect(zh.question.locale).toBe("zh-SG");
    expect(zh.question.presentationKey).not.toBe(question.presentationKey);
    expect(zh.question.options.map((o) => o.optionKey)).toEqual(question.options.map((o) => o.optionKey));
  });
});

describe("presentation-bound answer capture", () => {
  it("commits the response and the terminal inquiry revision atomically with the NOT_APPLICABLE disposition", async () => {
    const h = await setup();
    const { question } = await presentFor(h);
    const result = await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "ROUTINE_CHANGED" } as never, commandId: cmd() });
    expect(result.kind).toBe("COMMITTED");
    const [responseHead] = await h.rows("INQUIRY_RESPONSE");
    const response = await h.revision(responseHead!.headRevisionId);
    const [inquiry] = await inquiryHeads(h);
    const inquiryRow = await h.revision(inquiry!.head.headRevisionId);
    expect(response!.transactionId).toBe(inquiryRow!.transactionId);
    expect(inquiry!.payload!.lifecycle).toEqual({ state: "ANSWERED", response: { recordType: "INQUIRY_RESPONSE", recordId: responseHead!.recordId, revisionId: responseHead!.headRevisionId } });
    expect(response!.revision.payload.safetyDisposition).toEqual({
      applicability: "NOT_APPLICABLE",
      determinedAt: "2026-10-03T02:00:00.000Z",
      capabilityManifestVersion: "8.1",
      reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT",
    });
    expect(await h.rows("SAFETY_EVENT")).toEqual([]);
    const events = (await h.database.table("domainEvents").where("transactionId").equals(response!.transactionId).toArray()) as Array<{ eventName: string; payload: unknown }>;
    expect(events.map((event) => event.eventName).sort()).toEqual(["INQUIRY_RESPONSE_RECORDED", "INQUIRY_TRANSITIONED"]);
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain("ROUTINE_CHANGED");
  });

  it("replays an exact retry and rejects any other submission once resolved", async () => {
    const h = await setup();
    const { question } = await presentFor(h);
    const commandId = cmd();
    const answer = { inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" } as never, commandId };
    const first = await h.inquiry.answer(answer);
    const replay = await h.inquiry.answer(answer);
    expect(replay).toEqual(first);
    const second = await h.inquiry.answer({ ...answer, rawAnswer: { kind: "NOT_SURE" }, commandId: cmd() });
    expect(second).toEqual({ kind: "REJECTED", code: "INQUIRY_ALREADY_RESOLVED" });
    expect(await h.rows("INQUIRY_RESPONSE")).toHaveLength(1);
  });

  it("creates no response when the presentation was resolved first through another path", async () => {
    const h = await setup();
    const { question } = await presentFor(h);
    expect((await h.inquiry.dismiss({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey })).kind).toBe("COMMITTED");
    const late = await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "NOT_SURE" }, commandId: cmd() });
    expect(late).toEqual({ kind: "REJECTED", code: "PRESENTATION_NOT_ANSWERABLE" });
    expect(await h.rows("INQUIRY_RESPONSE")).toEqual([]);
  });

  it("rejects an unknown presentation key and an option that was not offered", async () => {
    const h = await setup();
    const { question } = await presentFor(h);
    expect(await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: "stale-key", rawAnswer: { kind: "NOT_SURE" }, commandId: cmd() })).toEqual({
      kind: "REJECTED",
      code: "PRESENTATION_NOT_ANSWERABLE",
    });
    expect(
      await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "DATE", localDate: "2026-10-01" } as never, commandId: cmd() }),
    ).toEqual({ kind: "REJECTED", code: "ANSWER_NOT_PERMITTED" });
  });
});

describe("uncertainty, refusal, dismissal and snooze", () => {
  it("maps Not sure to NOT_SURE and Prefer not to say to DECLINED, and refusal suppresses re-asking", async () => {
    const h = await setup();
    const { saved, question } = await presentFor(h);
    await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "PREFER_NOT_TO_SAY" }, commandId: cmd() });
    expect((await inquiryHeads(h))[0]!.payload!.lifecycle.state).toBe("DECLINED");
    // A correction of the same occasion would rebuild eligibility, but refusal blocks it.
    await h.journal.correctMedicationEvent({
      recordId: saved.recordId,
      expectedRevisionId: saved.revisionId,
      expectedRevisionNumber: 1,
      payload: h.eventPayload("UNSURE", 1),
      temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } },
      recordedAt: "2026-10-03T02:00:00.000Z" as never,
    });
    await h.inquiry.processPending();
    const states = (await inquiryHeads(h)).map((entry) => entry.payload!.lifecycle.state).sort();
    expect(states).toEqual(["DECLINED", "WITHDRAWN"]);
  });

  it("keeps dismissal and snooze distinct and returns a snoozed question only through fresh eligibility", async () => {
    const h = await setup();
    const { saved, question } = await presentFor(h);
    expect((await h.inquiry.snooze({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, choice: "TOMORROW" })).kind).toBe("COMMITTED");
    expect((await h.inquiry.offerForMedicationEvent(saved.recordId, "en-SG")).kind === "NONE").toBe(true);
    h.advanceHours(25);
    const again = await h.inquiry.offerForMedicationEvent(saved.recordId, "en-SG");
    expect(again.kind).toBe("PRESENTED");
    if (again.kind !== "PRESENTED") return;
    expect(again.question.presentationKey).not.toBe(question.presentationKey);
    await h.inquiry.dismiss({ inquiryRecordId: again.question.inquiryRecordId, presentationKey: again.question.presentationKey });
    expect((await inquiryHeads(h))[0]!.payload!.lifecycle.state).toBe("DISMISSED");
    expect(await h.inquiry.offerForMedicationEvent(saved.recordId, "en-SG")).toEqual({ kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" });
  });
});

describe("shared interruption budget", () => {
  it("does not ask about a second occasion within four hours of the last presentation", async () => {
    const h = await setup();
    const { question } = await presentFor(h, "MISSED", 1);
    await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "NOT_SURE" }, commandId: cmd() });
    const second = await h.record("UNSURE", 2);
    await h.inquiry.processPending();
    expect(await h.inquiry.offerForMedicationEvent(second.recordId, "en-SG")).toEqual({ kind: "NONE", reason: "NOT_SELECTED" });
    h.advanceHours(5);
    expect((await h.inquiry.offerForMedicationEvent(second.recordId, "en-SG")).kind).toBe("PRESENTED");
  });
});

describe("correction and deletion propagation", () => {
  it("withdraws an open question when the recorded state is corrected to taken", async () => {
    const h = await setup();
    const { saved } = await presentFor(h);
    await h.journal.correctMedicationEvent({
      recordId: saved.recordId,
      expectedRevisionId: saved.revisionId,
      expectedRevisionNumber: 1,
      payload: h.eventPayload("TAKEN", 1),
      temporal: { kind: "POINT", occurrence: { kind: "UNKNOWN" } },
      recordedAt: "2026-10-03T02:00:00.000Z" as never,
    });
    await h.inquiry.processPending();
    const [entry] = await inquiryHeads(h);
    expect(entry!.payload!.lifecycle).toMatchObject({ state: "WITHDRAWN", reason: "EVIDENCE_CHANGED" });
    expect(await h.rows("INQUIRY")).toHaveLength(1);
  });

  it("deletes and purges the question and answer when the source record is deleted", async () => {
    const h = await setup();
    const { saved, question } = await presentFor(h);
    await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "SOMETHING_ELSE", text: { text: "Visiting family", language: "en-SG" } }, commandId: cmd() });
    const { createAuthoritativeCommandStore } = await import("@/storage/authoritative-command-transaction");
    const { createStorageRowCodec } = await import("@/storage/storage-row-codec");
    const { z } = await import("zod");
    const { packet8WorkItemsFor } = await import("@/application/packet8-subscriptions");
    const store = createAuthoritativeCommandStore(h.database, {
      revisionCodec: createStorageRowCodec("recordRevisions", z.any()),
      auditCodec: createStorageRowCodec("auditEvents", z.any()),
      eventCodec: createStorageRowCodec("domainEvents", z.any()),
      reverseDependencyCodec: createStorageRowCodec("reverseDependencies", z.any()),
      evaluationAuditCodec: createStorageRowCodec("engineEvaluationAudits", z.any()),
    });
    const [transactionId, auditEventId, eventId, commandId] = [cmd(), cmd(), cmd(), cmd()];
    const at = "2026-10-03T03:00:00.000Z";
    await store.execute({
      kind: "COMMIT",
      commandId,
      commandHash: "d".repeat(64),
      completedAt: at,
      transactionId,
      headExpectations: [{ kind: "MUST_MATCH", recordType: "MEDICATION_EVENT", recordId: saved.recordId, expectedRevisionId: saved.revisionId, expectedRevisionNumber: 1 }],
      recordRevisions: [],
      recordHeads: [{ recordId: saved.recordId, recordType: "MEDICATION_EVENT", headRevisionId: saved.revisionId, headRevisionNumber: 1, state: "DELETED", updatedAt: at }],
      deletionTombstones: [{ recordId: saved.recordId, recordType: "MEDICATION_EVENT", deletedAt: at, initiator: "PATIENT", auditEventId, transactionId }],
      auditEvents: [{ auditEventId, transactionId, recordId: saved.recordId, occurredAt: at }],
      domainEvents: [
        {
          eventId,
          eventName: "PATIENT_RECORD_DELETED",
          transactionId,
          commandId,
          correlationId: cmd(),
          change: { kind: "RECORD_DELETED", recordType: "MEDICATION_EVENT", recordId: saved.recordId, previousRevisionId: saved.revisionId, resultingRevisionId: null },
        },
      ],
      eventWorkItems: packet8WorkItemsFor({ eventId, eventName: "PATIENT_RECORD_DELETED", recordType: "MEDICATION_EVENT", createdAt: at as never, workItemId: cmd }),
      reverseDependencies: [],
      evaluationAudits: [],
      appPreference: null,
      safety: { kind: "NOT_REQUIRED" },
    } as never);
    h.setClock(at);
    await h.inquiry.processPending();
    expect((await h.rows("INQUIRY")).map((row) => row.state)).toEqual(["DELETED"]);
    expect((await h.rows("INQUIRY_RESPONSE")).map((row) => row.state)).toEqual(["DELETED"]);
    expect(await h.database.table("recordRevisions").where("recordId").equals(question.inquiryRecordId).count()).toBe(0);
    const remaining = JSON.stringify(await h.database.table("recordRevisions").toArray());
    expect(remaining).not.toContain("Visiting family");
    expect(await h.database.table("reverseDependencies").where("dependentRecordId").equals(question.inquiryRecordId).count()).toBe(0);
  });

  it("corrects an answer as a new response revision and re-points the inquiry, keeping both values", async () => {
    const h = await setup();
    const { question } = await presentFor(h);
    const first = await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" } as never, commandId: cmd() });
    const responseRecordId = (first as { responseRecordId: RecordId }).responseRecordId;
    expect((await h.inquiry.correctResponse({ responseRecordId, rawAnswer: { kind: "NOT_SURE" }, commandId: cmd() })).kind).toBe("COMMITTED");
    const history = (await h.database.table("recordRevisions").where("recordId").equals(responseRecordId).toArray()) as Array<{
      action: string;
      revision: { action: string; payload: { rawAnswer: { kind: string }; answeredAt: string } };
    }>;
    expect(history.map((row) => [row.revision.action, row.revision.payload.rawAnswer.kind]).sort()).toEqual([
      ["CORRECT", "NOT_SURE"],
      ["CREATE", "BOUNDED_CHOICE"],
    ]);
    expect(new Set(history.map((row) => row.revision.payload.answeredAt)).size).toBe(1);
    expect((await inquiryHeads(h))[0]!.payload!.lifecycle.state).toBe("NOT_SURE");
  });

  it("commits a correction made after the clock advances, re-resolving NOT_APPLICABLE at the correction time", async () => {
    const h = await setup();
    const { question } = await presentFor(h);
    const first = await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "FORGOT" } as never, commandId: cmd() });
    expect(first.kind).toBe("COMMITTED");
    const responseRecordId = (first as { responseRecordId: RecordId }).responseRecordId;
    type StoredResponse = {
      revisionId: string;
      revision: {
        action: string;
        revisionCreatedAt: string;
        payload: { answeredAt: string; rawAnswer: { kind: string }; safetyDisposition: Record<string, unknown>; processing: { state: string } };
      };
    };
    const [created] = (await h.database.table("recordRevisions").where("recordId").equals(responseRecordId).toArray()) as StoredResponse[];
    const answeredAtT0 = created!.revision.payload.answeredAt;

    // T1 > T0: the patient corrects the answer three hours later.
    h.advanceHours(3);
    const t1 = new Date(Date.parse(answeredAtT0) + 3 * 3_600_000).toISOString();
    const corrected = await h.inquiry.correctResponse({ responseRecordId, rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "ROUTINE_CHANGED" } as never, commandId: cmd() });
    expect(corrected).toEqual({ kind: "COMMITTED", responseRecordId });

    const history = ((await h.database.table("recordRevisions").where("recordId").equals(responseRecordId).toArray()) as StoredResponse[]).sort(
      (a, b) => a.revision.revisionCreatedAt.localeCompare(b.revision.revisionCreatedAt),
    );
    // Both immutable revisions remain, each keeping the original first answeredAt.
    expect(history.map((row) => [row.revision.action, row.revision.payload.rawAnswer.kind, row.revision.payload.answeredAt])).toEqual([
      ["CREATE", "BOUNDED_CHOICE", answeredAtT0],
      ["CORRECT", "BOUNDED_CHOICE", answeredAtT0],
    ]);
    expect(history[0]!.revision.payload.safetyDisposition).toEqual({
      applicability: "NOT_APPLICABLE",
      determinedAt: answeredAtT0,
      capabilityManifestVersion: "8.1",
      reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT",
    });
    // Applicability is re-resolved at T1, never retained or backdated.
    expect(history[1]!.revision.revisionCreatedAt).toBe(t1);
    expect(history[1]!.revision.payload.safetyDisposition).toEqual({
      applicability: "NOT_APPLICABLE",
      determinedAt: t1,
      capabilityManifestVersion: "8.1",
      reason: "INQUIRY_SAFETY_CAPABILITY_ABSENT",
    });

    // The Inquiry's new terminal revision points to the corrected response revision.
    const [inquiry] = await inquiryHeads(h);
    const lifecycle = inquiry!.payload!.lifecycle as unknown as { state: string; response: { recordType: string; recordId: string; revisionId: string } };
    expect(lifecycle.state).toBe("ANSWERED");
    expect(lifecycle.response).toEqual({ recordType: "INQUIRY_RESPONSE", recordId: responseRecordId, revisionId: history[1]!.revisionId });
    const responseHead = (await h.rows("INQUIRY_RESPONSE"))[0]!;
    expect(responseHead.headRevisionId).toBe(history[1]!.revisionId);

    // No Safety record, handler work, policy pack, route or effect anywhere.
    for (const row of history) {
      expect(row.revision.payload.processing.state).not.toBe("SAFETY_ROUTED");
      expect(JSON.stringify(row.revision.payload.safetyDisposition)).not.toMatch(/screening|policyPack|SAFETY_EVENT|NO_SAFETY_ROUTE/);
    }
    const heads = (await h.database.table("recordHeads").toArray()) as Array<{ recordType: string }>;
    expect(heads.filter((head) => /SAFETY/.test(head.recordType))).toEqual([]);
    const events = (await h.database.table("domainEvents").toArray()) as Array<{ eventName: string }>;
    expect(events.filter((event) => /SAFETY/.test(event.eventName))).toEqual([]);
    expect(events.map((event) => event.eventName)).toContain("INQUIRY_RESPONSE_CORRECTED");
    const work = (await h.database.table("eventWorkItems").toArray()) as Array<{ consumer: string }>;
    expect(work.filter((item) => /SAFETY/.test(item.consumer))).toEqual([]);
  });

  it("removes an answer together with the exact question it answered", async () => {
    const h = await setup();
    const { question } = await presentFor(h);
    const first = await h.inquiry.answer({ inquiryRecordId: question.inquiryRecordId, presentationKey: question.presentationKey, rawAnswer: { kind: "BOUNDED_CHOICE", optionKey: "AWAY_FROM_HOME" } as never, commandId: cmd() });
    expect((await h.inquiry.removeResponse({ responseRecordId: (first as { responseRecordId: RecordId }).responseRecordId })).kind).toBe("COMMITTED");
    expect((await h.rows("INQUIRY")).map((row) => row.state)).toEqual(["DELETED"]);
    expect((await h.rows("INQUIRY_RESPONSE")).map((row) => row.state)).toEqual(["DELETED"]);
  });
});

describe("capability and activation boundaries", () => {
  it("refuses to store a SCREENED Safety disposition in the ordinary Inquiry capability set", async () => {
    const h = await setup();
    const store = createInquiryCommandStore(h.database);
    const revision = responseRevision({
      payload: { ...responseRevision().payload, safetyDisposition: { applicability: "SCREENED", screening: { evaluatedAt: "2026-10-02T13:00:00.000Z", policyPackVersion: "pack.1", outcome: { kind: "NO_SAFETY_ROUTE" } } } },
    });
    const plan = () =>
      buildInquiryCommitPlan({
        commandId: cmd(),
        commandHash: "a".repeat(64) as never,
        correlationId: cmd(),
        transactionId: revision.transactionId as never,
        completedAt: "2026-10-02T13:00:00.000Z" as never,
        changes: [{ kind: "REVISION", revision: revision as never, expectedHead: null, eventId: cmd(), eventName: "INQUIRY_RESPONSE_RECORDED", auditReason: "PATIENT_ANSWERED" }],
        reverseDependencies: [],
      });
    expect(() => plan()).toThrow();
    expect(await h.rows("INQUIRY_RESPONSE")).toEqual([]);
    void store;
  });

  it("cannot activate the barrier question when the manifest disables its definition", async () => {
    const h = await setup();
    const disabled = createInquiryService(h.database, {
      now: () => "2026-10-03T02:00:00.000Z" as never,
      ids: { commandId: cmd, correlationId: cmd, recordId: cmd, revisionId: cmd, auditEventId: cmd, transactionId: cmd, domainEventId: cmd, presentationKey: () => crypto.randomUUID(), leaseToken: () => crypto.randomUUID() },
      instanceId: "disabled",
      copy: () => ({ template: { barrierWhy: () => "x", barrierQuestion: "x", optionLabels: {} as never }, statusLabel: () => "x", occasionDate: () => "x" }),
      manifest: { ...INQUIRY_CAPABILITY_MANIFEST, definitions: { ...INQUIRY_CAPABILITY_MANIFEST.definitions, MEDICATION_OCCASION_BARRIER_V1: { kind: "DISABLED_PRODUCT_SCOPE" } } },
    });
    await h.record("MISSED");
    await disabled.processPending();
    expect(await h.rows("INQUIRY")).toEqual([]);
  });

  it("expires a presented question seven days after presentation", async () => {
    const h = await setup();
    const { saved } = await presentFor(h);
    h.advanceHours(7 * 24);
    await h.inquiry.maintain();
    expect((await inquiryHeads(h))[0]!.payload!.lifecycle.state).toBe("EXPIRED");
    expect(await h.inquiry.offerForMedicationEvent(saved.recordId, "en-SG")).toEqual({ kind: "NONE", reason: "NO_ELIGIBLE_QUESTION" });
  });
});
