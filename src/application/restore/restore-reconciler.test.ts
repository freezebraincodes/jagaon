import { afterEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { createBrowserJournalRuntime, JagaOnStorageLockedError } from "@/application/journal/browser-journal-runtime";
import { createPopulatedDataset, installFakeIndexedDb, openRaw, PACKET10_NOW } from "@/application/storage/packet10-test-support";
import { HACKATHON_STORAGE_PROFILE } from "@/storage/storage-profile-manifest";
import { createStorageMetadataRepository } from "@/storage/storage-metadata";
import { createRestoreReconciler, type ReconciliationOwnerOperations } from "./restore-reconciler";
import { reconciliationPlan } from "./restore-owner-registry";

installFakeIndexedDb();
const TIMEOUT = 120_000;
const names: string[] = [];
afterEach(async () => {
  for (const name of names.splice(0)) await Dexie.delete(name);
});

const OPERATION = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f";

function owners(calls: string[] = []): ReconciliationOwnerOperations {
  const op = (name: string) => async () => void calls.push(name);
  return {
    rebuildBootstrapLocale: op("locale"),
    inquiryMaintenance: op("inquiry"),
    patternLearningRefresh: op("pattern"),
    reminderReconciliation: op("reminders"),
    careSummaryInvalidation: op("summary"),
  };
}

async function reconcilingDataset() {
  const { name, runtime } = await createPopulatedDataset();
  names.push(name);
  runtime.close();
  const database = await openRaw(name);
  await createStorageMetadataRepository(database).writeRestoreState({
    key: "RESTORE_STATE",
    phase: "RECONCILING",
    operationId: OPERATION,
    restoreMode: "RESTORE_INTO_EMPTY_DATABASE",
    planHash: "a".repeat(64),
    committedAt: PACKET10_NOW,
    lastCompletedStep: "COMMITTED",
  });
  return { name, database };
}

describe("closed enabled-owner reconciliation registry", () => {
  it("binds every enabled profile step to one owner and records Safety as not enabled", () => {
    expect(reconciliationPlan().map((step) => [step.checkpoint, step.owner])).toEqual([
      ["VERIFY_STORAGE", "STORAGE_VERIFIER"],
      ["VERIFY_REVERSE_DEPENDENCIES", "DEPENDENCY_VERIFIER"],
      ["REBUILD_BOOTSTRAP_LOCALE", "BOOTSTRAP_LOCALE"],
      ["RUNTIME_POINTERS", "RUNTIME_POINTER_VERIFIER"],
      ["RECOVER_WORK_LEASES", "WORK_LEASE_RECOVERY"],
      ["SAFETY", null],
      ["INQUIRY_MAINTENANCE", "INQUIRY"],
      ["PATTERN_LEARNING_REFRESH", "PATTERN_LEARNING"],
      ["REMINDER_RECONCILIATION", "REMINDERS"],
      ["CARE_SUMMARY_INVALIDATION", "CARE_SUMMARY"],
    ]);
    // An absent owner is never silently treated as successful.
    const enabledSafety = HACKATHON_STORAGE_PROFILE.reconciliationSteps.map((step) => (step.checkpoint === "SAFETY" ? { ...step, disposition: "ENABLED" as const } : step));
    expect(() => reconciliationPlan(enabledSafety)).toThrow("RECONCILIATION_OWNER_MISSING");
    expect(() => reconciliationPlan([{ checkpoint: "UNKNOWN" as never, disposition: "ENABLED" }])).toThrow("RECONCILIATION_STEP_UNDECLARED");
  });
});

describe("post-restore reconciliation (RST-014, RST-018, RST-019)", () => {
  it(
    "RST-014 clears restored claims, completes receipted work and never repeats a receipted effect",
    async () => {
      const h = await reconcilingDataset();
      const work = (await h.database.table("eventWorkItems").toArray()) as Array<Record<string, unknown>>;
      const receipts = (await h.database.table("eventConsumerReceipts").toArray()) as Array<{ eventId: string; consumer: string; handlerVersion: string }>;
      const receipted = work.find((row) => receipts.some((receipt) => receipt.eventId === row.eventId && receipt.consumer === row.consumer && receipt.handlerVersion === row.handlerVersion))!;
      const unreceipted = work.find((row) => !receipts.some((receipt) => receipt.eventId === row.eventId && receipt.consumer === row.consumer && receipt.handlerVersion === row.handlerVersion));
      const claim = { state: "CLAIMED", leaseToken: "other-device", claimedByInstance: "other", leaseExpiresAt: "2026-10-05T00:00:00.000Z" };
      for (const row of [receipted, unreceipted].filter(Boolean) as Array<Record<string, unknown>>) {
        const { availableAt: _a, ...rest } = row;
        void _a;
        await h.database.table("eventWorkItems").put({ ...rest, state: claim, stateCode: "CLAIMED", leaseExpiresAt: claim.leaseExpiresAt } as never);
      }
      expect(await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners: owners() }).resume()).toEqual({ kind: "COMPLETED" });
      const after = (await h.database.table("eventWorkItems").toArray()) as Array<{ workItemId: string; stateCode: string; state: { completedAt?: string } }>;
      expect(after.find((row) => row.workItemId === receipted.workItemId)?.stateCode).toBe("COMPLETED");
      if (unreceipted) expect(after.find((row) => row.workItemId === unreceipted.workItemId)?.stateCode).toBe("PENDING");
      expect(after.some((row) => row.stateCode === "CLAIMED")).toBe(false);
      h.database.close();
    },
    TIMEOUT,
  );

  it(
    "RST-018 resumes idempotently after the last durable checkpoint",
    async () => {
      const h = await reconcilingDataset();
      const first: string[] = [];
      const failed = await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners: owners(first), fault: "PATTERN_LEARNING_REFRESH" }).resume();
      expect(failed).toMatchObject({ kind: "FAILED", failure: { errorCode: "RESTORE_RECONCILIATION_FAILED", userMessageKey: "packet10.restore.recoveryRequired" } });
      expect(first).toEqual(["locale", "inquiry"]);
      expect(await createStorageMetadataRepository(h.database).readRestoreState()).toMatchObject({ phase: "FAILED_BLOCKING", lastCompletedStep: "INQUIRY_MAINTENANCE", failureCode: "RESTORE_RECONCILIATION_FAILED" });
      // FAILED_BLOCKING is not resumed without the patient's explicit recovery choice.
      const refused: string[] = [];
      expect((await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners: owners(refused) }).resume()).kind).toBe("FAILED");
      expect(refused).toEqual([]);
      const second: string[] = [];
      expect(await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners: owners(second), resumeFailedBlocking: true }).resume()).toEqual({ kind: "COMPLETED" });
      expect(second).toEqual(["pattern", "reminders", "summary"]);
      const state = await createStorageMetadataRepository(h.database).readRestoreState();
      expect(state).toMatchObject({ phase: "COMPLETED", lastCompletedStep: "CARE_SUMMARY_INVALIDATION" });
      expect(state).not.toHaveProperty("failureCode");
      // A completed restore is not reconciled again.
      const third: string[] = [];
      await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners: owners(third) }).resume();
      expect(third).toEqual([]);
      h.database.close();
    },
    TIMEOUT,
  );

  it(
    "RST-019 a blocking reconciliation failure keeps the runtime closed with the recovery-required lock",
    async () => {
      const h = await reconcilingDataset();
      await createRestoreReconciler(h.database, { now: () => PACKET10_NOW, owners: { ...owners(), inquiryMaintenance: vi.fn(async () => { throw new Error("x"); }) } }).resume();
      // Simulate a launch where the owner still cannot complete: the runtime resumes and locks.
      await h.database.table("storageMetadata").put({
        key: "RESTORE_STATE",
        phase: "FAILED_BLOCKING",
        operationId: OPERATION,
        restoreMode: "RESTORE_INTO_EMPTY_DATABASE",
        planHash: "a".repeat(64),
        committedAt: PACKET10_NOW,
        lastCompletedStep: "COMMITTED",
        failureCode: "RESTORE_RECONCILIATION_FAILED",
      } as never);
      const edges = (await h.database.table("reverseDependencies").toArray()) as Array<{ dependentRecordId: string }>;
      await h.database.table("recordHeads").delete(edges[0]!.dependentRecordId);
      await h.database.table("recordRevisions").where("recordId").equals(edges[0]!.dependentRecordId).delete();
      h.database.close();
      const error = await createBrowserJournalRuntime(h.name, { now: () => PACKET10_NOW }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(JagaOnStorageLockedError);
    },
    TIMEOUT,
  );
});
