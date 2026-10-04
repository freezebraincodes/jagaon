import { afterEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime } from "@/application/journal/browser-journal-runtime";
import { createDeletionFixture } from "@/application/deletion/packet10-deletion-fixture";
import type { DeletionPlan } from "@/application/deletion/deletion-contracts";
import { HACKATHON_CLOSED_ROW_CODECS } from "@/application/storage/profile-row-codecs";
import { PACKET10_NOW, installFakeIndexedDb } from "@/application/storage/packet10-test-support";
import { verifyDataset } from "./dataset-verifier";
import { JAGAON_TABLE_NAMES } from "./table-catalogue";

installFakeIndexedDb();
const INTEGRATION_TIMEOUT_MS = 60_000;
const opened: Array<{ name: string; database: { close(): void } }> = [];
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    entry.database.close();
    await Dexie.delete(entry.name);
  }
});

async function fixture() {
  const created = await createDeletionFixture();
  opened.push(created);
  return created;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function planFor(h: Fixture, type: "GLUCOSE_READING" | "INTAKE_EVENT" | "MEDICATION_EVENT", dependent: string): Promise<DeletionPlan> {
  const result = await h.service.prepare(await h.targetWithDependent(type, dependent));
  if (result.kind !== "PLAN_READY") throw new Error(result.kind);
  return result.plan;
}

const confirmation = (plan: DeletionPlan) => ({ planHash: plan.planHash, confirmedAt: PACKET10_NOW });

describe("Packet 10A authoritative permanent deletion (SDEL-002–SDEL-011)", () => {
  it(
    "SDEL-003/004 removes every patient-content revision and inseparable dependent, leaving the exact minimum identity",
    async () => {
      const h = await fixture();
      const plan = await planFor(h, "GLUCOSE_READING", "CARE_SUMMARY_SNAPSHOT");
      const before = await h.tables();
      expect(await h.service.confirm(plan, confirmation(plan))).toEqual({ kind: "DELETED", removedRecordCount: 1 + plan.closure.dependents.length });
      const after = await h.tables();
      for (const recordId of plan.closure.purgedRecordIds) {
        expect((after.recordRevisions as Array<{ recordId: string }>).filter((row) => row.recordId === recordId)).toEqual([]);
        expect(await h.head(recordId)).toMatchObject({ state: "DELETED" });
      }
      const tombstone = (after.deletionTombstones as Array<Record<string, unknown>>).find((row) => row.recordId === plan.target.recordId)!;
      expect(Object.keys(tombstone).sort()).toEqual(["auditEventId", "deletedAt", "initiator", "recordId", "recordType", "transactionId"]);
      expect(tombstone).toMatchObject({ recordType: "GLUCOSE_READING", initiator: "PATIENT", deletedAt: PACKET10_NOW });
      const audits = (after.auditEvents as Array<{ transactionId: string; recordType: string; reasonCode: string; initiator: string }>).filter(
        (row) => row.transactionId === tombstone.transactionId,
      );
      expect(audits).toHaveLength(plan.closure.purgedRecordIds.length);
      expect(before.auditEvents.length + audits.length).toBe(after.auditEvents.length);
      expect(audits.find((row) => row.recordType === "GLUCOSE_READING")).toMatchObject({ reasonCode: "PATIENT_PERMANENT_DELETION", initiator: "PATIENT" });
      expect(audits.find((row) => row.recordType === "CARE_SUMMARY_SNAPSHOT")).toMatchObject({ reasonCode: "SUMMARY_SOURCE_DELETED", initiator: "JAGAON_SYSTEM" });
      const event = (after.domainEvents as Array<{ change: { recordId: string }; eventName: string; payload: Record<string, unknown> }>).find(
        (row) => row.change.recordId === plan.target.recordId && row.eventName === "PATIENT_RECORD_DELETED",
      )!;
      expect(event.payload).toEqual({
        deletedRecordType: "GLUCOSE_READING",
        deletionReasonCode: "PATIENT_REQUESTED",
        reviewedDeletionPlanHash: plan.planHash,
        affectedDependencies: plan.closure.dependents.map((dependent) => ({ recordType: dependent.head.recordType, recordId: dependent.head.recordId, revisionId: dependent.head.headRevisionId })),
      });
      // The whole dataset still satisfies every closed invariant.
      expect(verifyDataset(after, HACKATHON_CLOSED_ROW_CODECS)).toMatchObject({ kind: "VERIFIED" });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-004 withdraws Learning, Pattern and Inquiry dependents through their owners",
    async () => {
      const h = await fixture();
      const intake = await planFor(h, "INTAKE_EVENT", "LEARNED_KNOWLEDGE");
      expect((await h.service.confirm(intake, confirmation(intake))).kind).toBe("DELETED");
      const medication = await planFor(h, "MEDICATION_EVENT", "INQUIRY");
      expect((await h.service.confirm(medication, confirmation(medication))).kind).toBe("DELETED");
      const after = await h.tables();
      const reasons = (after.auditEvents as Array<{ recordType: string; reasonCode: string }>).filter((row) => ["LEARNED_KNOWLEDGE", "PATTERN_OBSERVATION", "INQUIRY", "INQUIRY_RESPONSE"].includes(row.recordType) && /DELETED$/.test(row.reasonCode));
      expect(new Set(reasons.map((row) => `${row.recordType}:${row.reasonCode}`))).toEqual(
        new Set(["LEARNED_KNOWLEDGE:LEARNED_DERIVED_CONTENT_DELETED", "PATTERN_OBSERVATION:PATTERN_DERIVED_CONTENT_DELETED", "INQUIRY:SOURCE_DELETED", "INQUIRY_RESPONSE:SOURCE_DELETED"]),
      );
      expect(verifyDataset(after, HACKATHON_CLOSED_ROW_CODECS)).toMatchObject({ kind: "VERIFIED" });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-002 a changed target, a new dependent, an expired plan or a wrong confirmation commits nothing",
    async () => {
      const h = await fixture();
      const plan = await planFor(h, "GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
      const before = await h.tables();
      expect(await h.service.confirm(plan, { planHash: "0".repeat(64) as never, confirmedAt: PACKET10_NOW })).toMatchObject({
        kind: "STALE",
        failure: { errorCode: "DELETION_CONFIRMATION_STALE", retryClass: "RETRY_AFTER_REFRESH", userMessageKey: "packet10.deletion.deletionChanged" },
      });
      h.setClock("2026-10-04T02:10:00.001Z");
      expect((await h.service.confirm(plan, confirmation(plan))).kind).toBe("STALE");
      h.setClock(PACKET10_NOW);
      expect(await h.tables()).toEqual(before);

      // A dependent edge added after planning changes the closure.
      const someone = (before.reverseDependencies as Array<Record<string, unknown>>).find((edge) => edge.dependentRecordType === "LEARNED_KNOWLEDGE")!;
      const targetRevision = (before.recordRevisions as Array<{ recordId: string; revisionId: string }>).find((row) => row.recordId === plan.target.recordId)!;
      await h.database.table("reverseDependencies").add({ ...someone, sourceRevisionId: targetRevision.revisionId } as never);
      const changed = await h.tables();
      expect((await h.service.confirm(plan, confirmation(plan))).kind).toBe("STALE");
      const afterNewDependent = await h.tables();
      expect(afterNewDependent.deletionTombstones).toEqual(changed.deletionTombstones);
      expect(afterNewDependent.recordRevisions).toEqual(changed.recordRevisions);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-002 a dependent head that changed after planning is stale with no deletion",
    async () => {
      const h = await fixture();
      const plan = await planFor(h, "GLUCOSE_READING", "CARE_SUMMARY_SNAPSHOT");
      const snapshot = plan.closure.dependents.find((dependent) => dependent.head.recordType === "CARE_SUMMARY_SNAPSHOT")!;
      await h.database.table("recordHeads").put({ ...snapshot.head, updatedAt: "2026-10-04T02:00:30.000Z", headRevisionNumber: snapshot.head.headRevisionNumber } as never);
      const head = await h.head(snapshot.head.recordId);
      await h.database.table("recordHeads").put({ ...head!, headRevisionId: plan.closure.targetHead.headRevisionId } as never);
      expect((await h.service.confirm(plan, confirmation(plan))).kind).toBe("STALE");
      expect(await h.head(plan.target.recordId)).toMatchObject({ state: "ACTIVE" });
      expect((await h.tables()).deletionTombstones).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-006 retains no reversible deleted value, relationship or fingerprint in events, receipts, audits or engine audits",
    async () => {
      const h = await fixture();
      const before = await h.tables();
      // A glucose reading with pattern dependents whose payload no other record shares.
      const rows = before.recordRevisions as Array<{ recordId: string; recordType: string; revisionId: string; revision: { payload: unknown } }>;
      const sources = new Set((before.reverseDependencies as Array<{ sourceRevisionId: string; dependentRecordType: string }>).filter((edge) => edge.dependentRecordType === "PATTERN_EVIDENCE_SNAPSHOT").map((edge) => edge.sourceRevisionId));
      const unique = rows.find(
        (row) => row.recordType === "GLUCOSE_READING" && sources.has(row.revisionId) && rows.filter((other) => JSON.stringify(other.revision.payload) === JSON.stringify(row.revision.payload)).length === 1,
      )!;
      const prepared = await h.service.prepare({ recordType: "GLUCOSE_READING", recordId: unique.recordId as never });
      if (prepared.kind !== "PLAN_READY") throw new Error(prepared.kind);
      const plan = prepared.plan;
      const purged = new Set<string>(plan.closure.purgedRecordIds);
      const targetPayload = JSON.stringify(unique.revision.payload);
      expect(JSON.stringify(before.domainEvents)).toContain(targetPayload);
      const purgedRevisionIds = (before.recordRevisions as Array<{ recordId: string; revisionId: string }>).filter((row) => purged.has(row.recordId)).map((row) => row.revisionId);
      expect(plan.closure.redactedEventIds.length).toBeGreaterThan(0);
      expect(plan.closure.receiptCommandIds.length).toBeGreaterThan(0);
      expect((await h.service.confirm(plan, confirmation(plan))).kind).toBe("DELETED");
      const after = await h.tables();
      for (const table of JAGAON_TABLE_NAMES) {
        for (const row of after[table]) expect(JSON.stringify(row), table).not.toContain(targetPayload);
      }
      for (const event of after.domainEvents as Array<{ eventId: string; payload: unknown }>) {
        if (plan.closure.redactedEventIds.includes(event.eventId)) expect(event.payload).toEqual({ reasonCode: "PATIENT_CONTENT_DELETED" });
      }
      const oldReceipts = new Map((before.commandReceipts as Array<{ commandId: string; commandHash: string }>).map((row) => [row.commandId, row.commandHash]));
      for (const receipt of after.commandReceipts as Array<{ commandId: string; commandHash: string }>) {
        if (plan.closure.receiptCommandIds.includes(receipt.commandId)) expect(receipt.commandHash).not.toBe(oldReceipts.get(receipt.commandId));
      }
      for (const audit of after.engineEvaluationAudits as Array<{ consideredRevisions: Array<{ revisionId: string }>; triggeringRevisions: Array<{ revisionId: string }> }>) {
        expect([...audit.consideredRevisions, ...audit.triggeringRevisions].some((ref) => purgedRevisionIds.includes(ref.revisionId))).toBe(false);
      }
      for (const edge of after.reverseDependencies as Array<{ sourceRevisionId: string; dependentRecordId: string }>) {
        expect(purgedRevisionIds.includes(edge.sourceRevisionId) || purged.has(edge.dependentRecordId)).toBe(false);
      }
      // Identity, order and idempotency survive: events and receipts are never dropped.
      expect(after.domainEvents.length).toBe(before.domainEvents.length + 1 + plan.closure.dependents.length);
      expect(after.commandReceipts.length).toBe(before.commandReceipts.length + 1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-007 deleted content is immediately absent from current reads, history and summaries",
    async () => {
      const h = await fixture();
      const plan = await planFor(h, "GLUCOSE_READING", "CARE_SUMMARY_SNAPSHOT");
      expect((await h.service.confirm(plan, confirmation(plan))).kind).toBe("DELETED");
      h.database.close();
      const runtime = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW });
      try {
        const today = await runtime.query.loadToday();
        expect(JSON.stringify(today)).not.toContain(plan.target.recordId);
        expect(await runtime.query.loadGlucose(plan.target.recordId)).toBeNull();
        const history = await runtime.history.load({ period: "THIS_WEEK" });
        expect(JSON.stringify(history)).not.toContain(plan.target.recordId);
        const snapshot = plan.closure.dependents.find((dependent) => dependent.head.recordType === "CARE_SUMMARY_SNAPSHOT")!;
        const summary = await runtime.carePreparation.query.loadSummary(snapshot.head.recordId);
        expect(JSON.stringify(summary)).not.toContain(plan.target.recordId);
        expect((summary as { status?: string }).status).not.toBe("READY");
      } finally {
        runtime.close();
        await h.database.open();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it.each([
    ["recordRevisions", "deleting"],
    ["domainEvents", "updating"],
    ["commandReceipts", "updating"],
    ["engineEvaluationAudits", "deleting"],
    ["reverseDependencies", "deleting"],
    ["deletionTombstones", "creating"],
    ["recordHeads", "updating"],
    ["auditEvents", "creating"],
    ["domainEvents", "creating"],
    ["eventWorkItems", "creating"],
    ["commandReceipts", "creating"],
  ] as const)(
    "SDEL-011 an injected failure while %s is %s commits nothing",
    async (table, hook) => {
      const h = await fixture();
      const plan = await planFor(h, "GLUCOSE_READING", "PATTERN_EVIDENCE_SNAPSHOT");
      const before = await h.tables();
      const fail = () => {
        throw new Error("injected");
      };
      const dexieTable = h.database.table(table);
      (dexieTable.hook as (name: string, fn: () => void) => void)(hook, fail);
      try {
        const result = await h.service.confirm(plan, confirmation(plan));
        expect(result).toMatchObject({ kind: "FAILED", failure: { operation: "DELETE_RECORD" } });
      } finally {
        (dexieTable.hook as unknown as (name: string) => { unsubscribe(fn: () => void): void })(hook).unsubscribe(fail);
      }
      expect(await h.tables()).toEqual(before);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "SDEL-010 time passage alone removes nothing",
    async () => {
      const h = await fixture();
      const before = await h.tables();
      h.database.close();
      const runtime = await createBrowserJournalRuntime(h.name, { now: () => "2027-10-04T02:00:00.000Z" as never });
      await runtime.history.load({ period: "THIS_WEEK" });
      runtime.close();
      await h.database.open();
      const after = await h.tables();
      for (const table of ["recordRevisions", "deletionTombstones", "domainEvents", "commandReceipts", "auditEvents"] as const) {
        expect(after[table].length, table).toBeGreaterThanOrEqual(before[table].length);
      }
      expect(after.deletionTombstones).toEqual(before.deletionTombstones);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
